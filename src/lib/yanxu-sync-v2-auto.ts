import {
  yanxuSyncV2CreateSnapshot,
  yanxuSyncV2ReadData,
  yanxuSyncV2RestoreSnapshot,
  yanxuSyncV2Session,
  yanxuSyncV2WriteData,
  type YanxuSyncV2Snapshot,
} from './ipc/yanxu-sync-v2';

const ORIGIN_KEY = 'yanxu-sync-v2-origin';
const UPLOAD_HISTORY_KEY = 'yanxu-sync-v2-upload-history';
const UPLOAD_RULES_KEY = 'yanxu-sync-v2-upload-correction-rules';
const LAST_NIGHTLY_SYNC_KEY = 'yanxu-sync-v2-last-nightly-upload';
const AUTH_CHANGED_EVENT = 'yanxu-sync-v2-auth-changed';
const SYNC_STATUS_EVENT = 'yanxu-sync-v2-auto-sync-status';
const LAST_AUTO_SYNC_AT_KEY = 'yanxu-sync-v2-last-auto-sync-at';
const LAST_AUTO_SYNC_STATUS_KEY = 'yanxu-sync-v2-last-auto-sync-status';
const CHECK_INTERVAL_MS = 30_000;

let activeSync: Promise<void> | null = null;

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shouldRunNightlyUpload(date: Date): boolean {
  return date.getHours() > 23 || (date.getHours() === 23 && date.getMinutes() >= 30);
}

function mergeSnapshotFromCloud(
  applicationData: Record<string, unknown>,
  usageHabits: Record<string, unknown>,
) {
  return {
    ...applicationData,
    activity: Array.isArray(usageHabits.activity) ? usageHabits.activity : [],
    history: Array.isArray(applicationData.history) ? applicationData.history : [],
  } as unknown as YanxuSyncV2Snapshot;
}

/** Merge cloud data into the local app, then upload the resulting snapshot. */
async function syncOnce(): Promise<boolean> {
  const origin = localStorage.getItem(ORIGIN_KEY)?.trim();
  const session = await yanxuSyncV2Session();
  if (!origin || !session) return false;

  // Restore is a merge, so data already on this computer is kept. This lets a newly
  // signed-in device receive the account's cloud data before contributing its own.
  const current = await yanxuSyncV2ReadData();
  const cloudHasData =
    Object.keys(current.applicationData).length > 0 || Object.keys(current.usageHabits).length > 0;
  if (cloudHasData) {
    await yanxuSyncV2RestoreSnapshot(
      mergeSnapshotFromCloud(current.applicationData, current.usageHabits),
    );
  }

  const includeHistory = localStorage.getItem(UPLOAD_HISTORY_KEY) === 'true';
  const includeCorrectionRules = localStorage.getItem(UPLOAD_RULES_KEY) === 'true';
  const snapshot = await yanxuSyncV2CreateSnapshot(includeHistory, includeCorrectionRules);
  const latest = await yanxuSyncV2ReadData();
  const { activity, history, ...snapshotApplicationData } = snapshot;
  const applicationData: Record<string, unknown> = snapshotApplicationData;
  const existingApplication = latest.applicationData;

  // Disabled categories remain untouched in the cloud, matching the manual upload.
  if (!includeHistory) {
    if (Array.isArray(existingApplication.history))
      applicationData.history = existingApplication.history;
    else delete applicationData.history;
  }
  if (!includeCorrectionRules) {
    if (Array.isArray(existingApplication.correctionRules)) {
      applicationData.correctionRules = existingApplication.correctionRules;
    } else {
      delete applicationData.correctionRules;
    }
  }

  await yanxuSyncV2WriteData(latest.revision, applicationData, {
    ...latest.usageHabits,
    activity,
  });
  return true;
}

function setSyncStatus(status: 'success' | 'failed'): void {
  localStorage.setItem(LAST_AUTO_SYNC_STATUS_KEY, status);
  if (status === 'success') localStorage.setItem(LAST_AUTO_SYNC_AT_KEY, new Date().toISOString());
  window.dispatchEvent(new Event(SYNC_STATUS_EVENT));
}

export function getYanxuSyncV2AutoSyncStatus(): string {
  const status = localStorage.getItem(LAST_AUTO_SYNC_STATUS_KEY);
  const syncedAt = localStorage.getItem(LAST_AUTO_SYNC_AT_KEY);
  if (status === 'failed') return '上次自动同步失败；请检查网络或重新登录。';
  if (status === 'success' && syncedAt) {
    const date = new Date(syncedAt);
    if (!Number.isNaN(date.getTime())) return `最近自动同步：${date.toLocaleString()}`;
  }
  return '登录后将在应用启动时同步，并于每天 23:30 自动上传。';
}

export const YANXU_SYNC_V2_AUTO_STATUS_EVENT = SYNC_STATUS_EVENT;

function requestSync(reason: 'startup' | 'nightly' | 'login'): Promise<void> {
  if (activeSync) return activeSync;
  activeSync = syncOnce()
    .then((didSync) => {
      if (didSync) {
        console.info(`[yanxu-sync] automatic sync completed (${reason})`);
        setSyncStatus('success');
      }
    })
    .catch((error) => {
      console.warn(`[yanxu-sync] automatic sync failed (${reason})`, error);
      setSyncStatus('failed');
      throw error;
    })
    .finally(() => {
      activeSync = null;
    });
  return activeSync;
}

export function notifyYanxuSyncV2SignedIn(): void {
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

/** Called by the app's main WebView so scheduling continues while its window is hidden. */
export function startYanxuSyncV2AutoSync(): () => void {
  let stopped = false;
  let lastNightlyAttemptDate = '';
  let nextNightlyRetryAt = 0;

  const tryNightlyUpload = () => {
    if (stopped) return;
    const now = new Date();
    const dateKey = localDateKey(now);
    if (
      !shouldRunNightlyUpload(now) ||
      dateKey === lastNightlyAttemptDate ||
      now.getTime() < nextNightlyRetryAt
    )
      return;

    lastNightlyAttemptDate = dateKey;
    void requestSync('nightly')
      .then(() => {
        nextNightlyRetryAt = 0;
        localStorage.setItem(LAST_NIGHTLY_SYNC_KEY, dateKey);
      })
      .catch(() => {
        // Retry after five minutes while the app remains open.
        lastNightlyAttemptDate = '';
        nextNightlyRetryAt = Date.now() + 5 * 60_000;
      });
  };

  // Once per app launch, synchronize after the native session has initialized.
  void requestSync('startup').catch(() => undefined);

  const onSignedIn = () => {
    void requestSync('login').catch(() => undefined);
  };
  window.addEventListener(AUTH_CHANGED_EVENT, onSignedIn);

  const lastNightlyDate = localStorage.getItem(LAST_NIGHTLY_SYNC_KEY);
  const today = localDateKey(new Date());
  if (lastNightlyDate === today) lastNightlyAttemptDate = today;
  const interval = window.setInterval(tryNightlyUpload, CHECK_INTERVAL_MS);
  tryNightlyUpload();

  return () => {
    stopped = true;
    window.clearInterval(interval);
    window.removeEventListener(AUTH_CHANGED_EVENT, onSignedIn);
  };
}
