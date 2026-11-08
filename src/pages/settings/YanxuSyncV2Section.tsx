import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openExternal } from '../../lib/ipc/utils';
import {
  yanxuSyncV2Login,
  yanxuSyncV2Logout,
  yanxuSyncV2CreateSnapshot,
  yanxuSyncV2ReadData,
  yanxuSyncV2RestoreSnapshot,
  yanxuSyncV2Session,
  yanxuSyncV2RefreshSession,
  yanxuSyncV2TestConnection,
  yanxuSyncV2WriteData,
  yanxuSyncV2FeishuResolve,
  yanxuSyncV2FeishuStart,
  yanxuSyncV2TakeFeishuTicket,
  type YanxuSyncV2Connection,
  type YanxuSyncV2Data,
  type YanxuSyncV2Snapshot,
} from '../../lib/ipc/yanxu-sync-v2';
import { Card } from '../_atoms';
import {
  getYanxuSyncV2AutoSyncStatus,
  notifyYanxuSyncV2SignedIn,
  YANXU_SYNC_V2_AUTO_STATUS_EVENT,
} from '../../lib/yanxu-sync-v2-auto';

const ORIGIN_KEY = 'yanxu-sync-v2-origin';
const UPLOAD_HISTORY_KEY = 'yanxu-sync-v2-upload-history';
const UPLOAD_RULES_KEY = 'yanxu-sync-v2-upload-correction-rules';
const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--ol-line-strong)',
  borderRadius: 9,
  background: 'var(--ol-control-solid)',
  color: 'var(--ol-ink)',
  padding: '10px 12px',
};
const buttonStyle: CSSProperties = {
  border: 0,
  borderRadius: 8,
  background: 'var(--ol-blue)',
  color: 'white',
  padding: '9px 14px',
  cursor: 'pointer',
};

export function YanxuSyncV2Section() {
  const [origin, setOrigin] = useState(() => localStorage.getItem(ORIGIN_KEY) ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(
    () => localStorage.getItem('yanxu-sync-v2-allow-insecure-http') === 'true',
  );
  const [uploadHistory, setUploadHistory] = useState(
    () => localStorage.getItem(UPLOAD_HISTORY_KEY) === 'true',
  );
  const [uploadCorrectionRules, setUploadCorrectionRules] = useState(
    () => localStorage.getItem(UPLOAD_RULES_KEY) === 'true',
  );
  const [connection, setConnection] = useState<YanxuSyncV2Connection | null>(null);
  const [signedIn, setSignedIn] = useState<{ username: string; displayName: string } | null>(null);
  const [data, setData] = useState<YanxuSyncV2Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [autoSyncStatus, setAutoSyncStatus] = useState(getYanxuSyncV2AutoSyncStatus);
  const handledTickets = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    const loadSession = async () => {
      try {
        const refreshed = await yanxuSyncV2RefreshSession();
        if (active && refreshed) {
          setSignedIn(refreshed);
          return;
        }
      } catch {
        // Keep the saved local identity visible when the server cannot be reached.
      }
      try {
        const saved = await yanxuSyncV2Session();
        if (active) setSignedIn(saved);
      } catch {
        if (active) setSignedIn(null);
      }
    };
    void loadSession();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const updateStatus = () => setAutoSyncStatus(getYanxuSyncV2AutoSyncStatus());
    window.addEventListener(YANXU_SYNC_V2_AUTO_STATUS_EVENT, updateStatus);
    return () => window.removeEventListener(YANXU_SYNC_V2_AUTO_STATUS_EVENT, updateStatus);
  }, []);

  useEffect(() => {
    const handleTicket = async (ticket: string) => {
      if (!ticket || handledTickets.current.has(ticket)) return;
      handledTickets.current.add(ticket);
      const normalized = origin.trim().replace(/\/+$/, '');
      if (!normalized) {
        setNotice('飞书授权已返回，请先填写同步服务器地址。');
        return;
      }
      setBusy(true);
      setNotice('正在验证飞书授权…');
      try {
        const result = await yanxuSyncV2FeishuResolve(normalized, ticket, allowInsecureHttp);
        const session = await yanxuSyncV2Session();
        setSignedIn(session ?? { username: result.username, displayName: result.displayName });
        setPassword('');
        setData(null);
        notifyYanxuSyncV2SignedIn();
        setNotice(
          result.created
            ? '飞书授权成功，已自动创建并保存云端账号。'
            : '飞书授权登录成功，已自动识别账号。',
        );
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    };

    let unlisten: (() => void) | undefined;
    void listen<string>('yanxu-feishu-auth', (event) => {
      void handleTicket(event.payload);
    })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => undefined);
    void yanxuSyncV2TakeFeishuTicket().then((ticket) => {
      if (ticket) void handleTicket(ticket);
    });
    return () => unlisten?.();
  }, [origin, allowInsecureHttp]);

  const rememberOrigin = () => {
    const trimmed = origin.trim().replace(/\/+$/, '');
    setOrigin(trimmed);
    if (trimmed) localStorage.setItem(ORIGIN_KEY, trimmed);
    else localStorage.removeItem(ORIGIN_KEY);
    return trimmed;
  };

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = () =>
    run(async () => {
      const normalized = rememberOrigin();
      const result = await yanxuSyncV2TestConnection(normalized);
      setConnection(result);
      setNotice('连接成功：已识别言序同步服务 v2。');
    });

  const authenticate = () =>
    run(async () => {
      const normalized = rememberOrigin();
      const inputPassword = password;
      const result = await yanxuSyncV2Login(
        normalized,
        username.trim(),
        inputPassword,
        allowInsecureHttp,
      );
      setSignedIn({ username: result.username, displayName: result.displayName });
      setPassword('');
      setData(null);
      notifyYanxuSyncV2SignedIn();
      setNotice('登录成功。');
    });

  const startFeishuLogin = () =>
    run(async () => {
      const normalized = rememberOrigin();
      const authorizationUrl = await yanxuSyncV2FeishuStart(normalized, allowInsecureHttp);
      await openExternal(authorizationUrl);
      setNotice('已在浏览器打开飞书授权，完成授权后将自动返回言序。');
    });

  const uploadLocalSnapshot = () =>
    run(async () => {
      const included = [uploadHistory ? '历史文本' : '', uploadCorrectionRules ? '识别规则' : '']
        .filter(Boolean)
        .join('、');
      const message = `将本机词库、自定义风格包和使用统计上传并更新云端快照${included ? `；同时上传${included}` : ''}。${!uploadHistory || !uploadCorrectionRules ? '未启用的类别会保留云端已有副本。' : ''}继续吗？`;
      if (!window.confirm(message)) return;
      const snapshot = await yanxuSyncV2CreateSnapshot(uploadHistory, uploadCorrectionRules);
      const current = await yanxuSyncV2ReadData();
      const { activity, history, ...baseApplicationData } = snapshot;
      const applicationData: Record<string, unknown> = { ...baseApplicationData };
      const existingApplication = current.applicationData as Record<string, unknown>;
      if (uploadHistory) applicationData.history = history;
      else if (Array.isArray(existingApplication.history))
        applicationData.history = existingApplication.history;
      else delete applicationData.history;
      if (!uploadCorrectionRules) {
        if (Array.isArray(existingApplication.correctionRules))
          applicationData.correctionRules = existingApplication.correctionRules;
        else delete applicationData.correctionRules;
      }
      const saved = await yanxuSyncV2WriteData(current.revision, applicationData, { activity });
      setData(saved);
      setNotice('本机数据已上传。云端快照已更新。');
    });

  const mergeCloudSnapshot = () =>
    run(async () => {
      if (
        !window.confirm(
          '把云端词库、纠正规则、自定义风格包和使用统计合并到本机？本机已有词条和规则会保留；同 ID 的自定义风格包会以云端版本更新。',
        )
      )
        return;
      const current = await yanxuSyncV2ReadData();
      const application = current.applicationData as Record<string, unknown>;
      const habits = current.usageHabits as Record<string, unknown>;
      const snapshot = {
        ...application,
        activity: Array.isArray(habits.activity) ? habits.activity : [],
        history: Array.isArray(application.history) ? application.history : [],
      } as unknown as YanxuSyncV2Snapshot;
      const result = await yanxuSyncV2RestoreSnapshot(snapshot);
      setData(current);
      setNotice(
        `合并完成：新增词库 ${result.vocabularyAdded} 项、识别规则 ${result.correctionRulesAdded} 项、历史记录 ${result.historyEntriesMerged} 条；风格包新增 ${result.stylePacksAdded}、更新 ${result.stylePacksUpdated}；统计 ${result.activityDaysMerged} 天。`,
      );
    });

  return (
    <Card>
      <div style={{ display: 'grid', gap: 12 }}>
        <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>
          服务器地址
          <input
            style={inputStyle}
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value);
              setConnection(null);
            }}
            placeholder="https://服务器地址"
            autoComplete="url"
            spellCheck={false}
          />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>
            已有账号用户名（可选）
            <input
              style={inputStyle}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              maxLength={32}
            />
          </label>
          <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>
            已有账号密码（可选）
            <input
              style={inputStyle}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={signedIn ? 'current-password' : 'new-password'}
              maxLength={128}
            />
            {!signedIn && (
              <span style={{ color: 'var(--ol-ink-3)' }}>
                仅供已有用户名/密码账号登录；飞书授权不需要绑定或注册。
              </span>
            )}
          </label>
        </div>

        {/^http:\/\//i.test(origin.trim()) &&
          !/http:\/\/(localhost|127\.0\.0\.1|\[::1\])([/:]|$)/i.test(origin.trim()) && (
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                fontSize: 12,
                color: 'var(--ol-warning, #a35b00)',
              }}
            >
              <input
                type="checkbox"
                checked={allowInsecureHttp}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setAllowInsecureHttp(checked);
                  localStorage.setItem('yanxu-sync-v2-allow-insecure-http', String(checked));
                }}
              />
              仅用于测试：HTTP
              会明文传输密码、飞书授权码与票据、登录令牌及同步内容；请勿使用真实账号或数据。
            </label>
          )}

        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: '10px 12px',
            border: '1px solid var(--ol-line)',
            borderRadius: 9,
          }}
        >
          <strong style={{ fontSize: 12 }}>默认上传内容</strong>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={uploadHistory}
              onChange={(event) => {
                const checked = event.target.checked;
                setUploadHistory(checked);
                localStorage.setItem(UPLOAD_HISTORY_KEY, String(checked));
              }}
            />
            上传历史记录文本（原始转写、识别文本和最终文本；按本机保留策略同步，不上传录音文件）
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={uploadCorrectionRules}
              onChange={(event) => {
                const checked = event.target.checked;
                setUploadCorrectionRules(checked);
                localStorage.setItem(UPLOAD_RULES_KEY, String(checked));
              }}
            />
            上传识别规则（包含替换前后文本和启用状态）
          </label>
          <span style={{ color: 'var(--ol-ink-3)', fontSize: 11 }}>
            选项保存在本机；关闭后上传时保留云端已有内容。云端数据可读取，建议通过 HTTPS 连接。
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            style={buttonStyle}
            disabled={busy || !origin.trim()}
            onClick={() => void testConnection()}
          >
            {busy ? '请稍候…' : '测试连接'}
          </button>
          <button
            style={{ ...buttonStyle, background: 'var(--ol-surface)', color: 'var(--ol-ink)' }}
            disabled={busy || !origin.trim() || !username.trim() || !password}
            onClick={() => void authenticate()}
          >
            登录
          </button>
          {!signedIn && (
            <button
              style={{ ...buttonStyle, background: 'var(--ol-surface)', color: 'var(--ol-ink)' }}
              disabled={busy || !origin.trim()}
              onClick={() => void startFeishuLogin()}
            >
              飞书授权登录
            </button>
          )}
        </div>

        {connection && (
          <div style={{ fontSize: 12, color: 'var(--ol-ink-3)' }}>
            协议 v{connection.protocolVersion} · {connection.authentication.join('、')} ·
            单次数据上限 {Math.floor(connection.maxDataBytes / 1024 / 1024)} MiB
          </div>
        )}
        {signedIn && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 10,
                fontSize: 13,
              }}
            >
              <span>已登录：{signedIn.displayName || signedIn.username}</span>
              <button
                style={{ ...buttonStyle, background: 'var(--ol-surface)', color: 'var(--ol-ink)' }}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const current = await yanxuSyncV2ReadData();
                    setData(current);
                    setNotice('云端数据读取成功；尚未写入或替换本机资料。');
                  })
                }
              >
                读取云端状态
              </button>
              <button
                style={buttonStyle}
                disabled={busy}
                onClick={() => void uploadLocalSnapshot()}
              >
                上传本机数据
              </button>
              <button
                style={{ ...buttonStyle, background: 'var(--ol-surface)', color: 'var(--ol-ink)' }}
                disabled={busy}
                onClick={() => void mergeCloudSnapshot()}
              >
                合并云端数据到本机
              </button>
              <button
                style={{ ...buttonStyle, background: 'var(--ol-surface)', color: 'var(--ol-ink)' }}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await yanxuSyncV2Logout();
                    setSignedIn(null);
                    setData(null);
                    setNotice('已退出登录。');
                  })
                }
              >
                退出
              </button>
            </div>
            <span style={{ color: 'var(--ol-ink-3)', fontSize: 12 }}>{autoSyncStatus}</span>
          </div>
        )}
        {data && (
          <div style={{ fontSize: 12, color: 'var(--ol-ink-3)' }}>
            云端版本：{data.revision}；上次更新时间：{data.updatedAt ?? '尚无数据'}。
          </div>
        )}
        {notice && (
          <div
            role="status"
            style={{
              fontSize: 12,
              color: notice.includes('失败') ? 'var(--ol-danger)' : 'var(--ol-ink-2)',
            }}
          >
            {notice}
          </div>
        )}
        <div
          style={{
            borderTop: '1px solid var(--ol-line)',
            paddingTop: 10,
            color: 'var(--ol-ink-3)',
            fontSize: 12,
          }}
        >
          同步范围：词库、自定义风格包、每日使用统计，以及上方启用的历史文本和识别规则。恢复采用合并方式；录音文件、账号凭据、API
          密钥或设备路径不会同步。历史文本和识别规则包含个人内容，服务端可读取同步数据。
        </div>
      </div>
    </Card>
  );
}
