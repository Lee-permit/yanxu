import { invokeOrMock } from './shared';

export interface YanxuSyncV2Connection {
  protocolVersion: number;
  service: string;
  authentication: string[];
  endToEndEncryption: boolean;
  maxDataBytes: number;
}

export interface YanxuSyncV2Login {
  username: string;
  displayName: string;
  expiresIn: number;
}

export interface YanxuSyncV2Session { username: string; displayName: string }

export interface YanxuSyncV2FeishuStart { authorizationUrl: string }

export interface YanxuSyncV2FeishuLogin extends YanxuSyncV2Login { created: boolean }

export interface YanxuSyncV2Data {
  revision: number;
  updatedAt: string | null;
  applicationData: Record<string, unknown>;
  usageHabits: Record<string, unknown>;
}

export interface YanxuSyncV2Snapshot {
  schemaVersion: number;
  vocabulary: unknown[];
  correctionRules: unknown[];
  customStylePacks: unknown[];
  activity: Array<{ date: string; count: number; chars: number; durationMs: number }>;
  history: unknown[];
}

export interface YanxuSyncV2RestoreResult {
  vocabularyAdded: number;
  correctionRulesAdded: number;
  stylePacksAdded: number;
  stylePacksUpdated: number;
  activityDaysMerged: number;
  historyEntriesMerged: number;
}

let previewSession: string | null = null;

export const yanxuSyncV2TestConnection = (origin: string): Promise<YanxuSyncV2Connection> =>
  invokeOrMock('yanxu_sync_v2_test_connection', { origin }, () => ({
    protocolVersion: 2,
    service: 'yanxu-sync',
    authentication: ['username-password'],
    endToEndEncryption: false,
    maxDataBytes: 16 * 1024 * 1024,
  }));

export const yanxuSyncV2Register = (
  origin: string,
  username: string,
  password: string,
  allowInsecureHttp = false,
): Promise<YanxuSyncV2Login> =>
  invokeOrMock('yanxu_sync_v2_register', { origin, username, password, allowInsecureHttp }, () => {
    previewSession = username;
    return { username, displayName: username, expiresIn: 7 * 24 * 60 * 60 };
  });

export const yanxuSyncV2Login = (
  origin: string,
  username: string,
  password: string,
  allowInsecureHttp = false,
): Promise<YanxuSyncV2Login> =>
  invokeOrMock('yanxu_sync_v2_login', { origin, username, password, allowInsecureHttp }, () => {
    previewSession = username;
    return { username, displayName: username, expiresIn: 7 * 24 * 60 * 60 };
  });

export const yanxuSyncV2FeishuStart = (origin: string, allowInsecureHttp = false): Promise<string> =>
  invokeOrMock('yanxu_sync_v2_feishu_start', { origin, allowInsecureHttp }, () => {
    throw new Error('飞书登录需要 HTTPS，或在公网 HTTP 测试时勾选明文传输风险确认');
  });

export const yanxuSyncV2TakeFeishuTicket = (): Promise<string | null> =>
  invokeOrMock('yanxu_sync_v2_take_feishu_ticket', undefined, () => null);

export const yanxuSyncV2FeishuResolve = (
  origin: string,
  ticket: string,
  allowInsecureHttp = false,
): Promise<YanxuSyncV2FeishuLogin> =>
  invokeOrMock('yanxu_sync_v2_feishu_resolve', { origin, ticket, allowInsecureHttp }, () => {
    previewSession = 'feishu_user';
    return { username: previewSession, displayName: '飞书用户', expiresIn: 7 * 24 * 60 * 60, created: true };
  });

export const yanxuSyncV2Session = (): Promise<YanxuSyncV2Session | null> =>
  invokeOrMock('yanxu_sync_v2_session', undefined, () => previewSession ? { username: previewSession, displayName: previewSession } : null);

export const yanxuSyncV2RefreshSession = (): Promise<YanxuSyncV2Session | null> =>
  invokeOrMock('yanxu_sync_v2_refresh_session', undefined, () => previewSession ? { username: previewSession, displayName: previewSession } : null);

export const yanxuSyncV2ReadData = (): Promise<YanxuSyncV2Data> =>
  invokeOrMock('yanxu_sync_v2_read_data', undefined, () => ({
    revision: 0,
    updatedAt: null,
    applicationData: {},
    usageHabits: {},
  }));

export const yanxuSyncV2WriteData = (
  expectedRevision: number,
  applicationData: Record<string, unknown>,
  usageHabits: Record<string, unknown>,
): Promise<YanxuSyncV2Data> =>
  invokeOrMock(
    'yanxu_sync_v2_write_data',
    { expectedRevision, applicationData, usageHabits },
    () => ({
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
      applicationData,
      usageHabits,
    }),
  );

export const yanxuSyncV2CreateSnapshot = (
  includeHistory: boolean,
  includeCorrectionRules: boolean,
): Promise<YanxuSyncV2Snapshot> =>
  invokeOrMock('yanxu_sync_v2_create_snapshot', { includeHistory, includeCorrectionRules }, () => ({
    schemaVersion: 2,
    vocabulary: [],
    correctionRules: [],
    customStylePacks: [],
    activity: [],
    history: [],
  }));

export const yanxuSyncV2RestoreSnapshot = (snapshot: YanxuSyncV2Snapshot): Promise<YanxuSyncV2RestoreResult> =>
  invokeOrMock('yanxu_sync_v2_restore_snapshot', { snapshot }, () => ({
    vocabularyAdded: snapshot.vocabulary.length,
    correctionRulesAdded: snapshot.correctionRules.length,
    stylePacksAdded: snapshot.customStylePacks.length,
    stylePacksUpdated: 0,
    activityDaysMerged: snapshot.activity.length,
    historyEntriesMerged: snapshot.history.length,
  }));

export const yanxuSyncV2Logout = (): Promise<void> =>
  invokeOrMock('yanxu_sync_v2_logout', undefined, () => {
    previewSession = null;
  });
