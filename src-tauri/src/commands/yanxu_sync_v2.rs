use super::*;
use parking_lot::Mutex;
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 17 * 1024 * 1024;
const MAX_SYNC_DATA_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YanxuSyncV2LocalSnapshot {
    pub schema_version: u32,
    pub vocabulary: Vec<DictionaryEntry>,
    pub correction_rules: Vec<CorrectionRule>,
    pub custom_style_packs: Vec<StylePack>,
    pub activity: Vec<ActivityDay>,
    #[serde(default)]
    pub history: Vec<DictationSession>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YanxuSyncV2RestoreResult {
    pub vocabulary_added: usize,
    pub correction_rules_added: usize,
    pub style_packs_added: usize,
    pub style_packs_updated: usize,
    pub activity_days_merged: usize,
    pub history_entries_merged: usize,
}

pub struct YanxuSyncV2State {
    session: Mutex<Option<Session>>,
    pending_feishu_ticket: Mutex<Option<String>>,
}

impl Default for YanxuSyncV2State {
    fn default() -> Self {
        Self {
            session: Mutex::new(load_saved_session()),
            pending_feishu_ticket: Mutex::new(None),
        }
    }
}

impl YanxuSyncV2State {
    pub fn set_pending_feishu_ticket(&self, ticket: String) {
        *self.pending_feishu_ticket.lock() = Some(ticket);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    origin: String,
    token: String,
    username: String,
    #[serde(default)]
    display_name: String,
    expires_at: i64,
}

const SYNC_SESSION_KEYRING_ACCOUNT: &str = "yanxu-sync-v2-session";

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn save_session(session: &Session) -> Result<(), String> {
    let entry = keyring::Entry::new("com.openless.app", SYNC_SESSION_KEYRING_ACCOUNT)
        .map_err(|_| "无法打开系统凭据库".to_string())?;
    let value = serde_json::to_string(session).map_err(|_| "无法保存登录状态".to_string())?;
    entry
        .set_password(&value)
        .map_err(|_| "无法将登录状态保存到系统凭据库".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn save_session(_session: &Session) -> Result<(), String> {
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn load_saved_session() -> Option<Session> {
    let entry = keyring::Entry::new("com.openless.app", SYNC_SESSION_KEYRING_ACCOUNT).ok()?;
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return None,
        Err(error) => {
            log::warn!(
                "[yanxu-sync] could not read saved session from system credential store: {error}"
            );
            return None;
        }
    };
    match serde_json::from_str::<Session>(&value) {
        Ok(session) if session.expires_at > chrono::Utc::now().timestamp() => Some(session),
        _ => {
            let _ = entry.delete_credential();
            None
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn load_saved_session() -> Option<Session> {
    None
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn delete_saved_session() {
    if let Ok(entry) = keyring::Entry::new("com.openless.app", SYNC_SESSION_KEYRING_ACCOUNT) {
        if let Err(error) = entry.delete_credential() {
            if !matches!(error, keyring::Error::NoEntry) {
                log::warn!("[yanxu-sync] could not remove saved session from system credential store: {error}");
            }
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn delete_saved_session() {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YanxuSyncV2Connection {
    pub protocol_version: u32,
    pub service: String,
    pub authentication: Vec<String>,
    pub end_to_end_encryption: bool,
    pub max_data_bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YanxuSyncV2Login {
    pub username: String,
    pub display_name: String,
    pub expires_in: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YanxuSyncV2Session {
    pub username: String,
    pub display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct FeishuResolveResponse {
    status: String,
    created: Option<bool>,
    session: Option<AuthResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YanxuSyncV2FeishuLogin {
    pub username: String,
    pub display_name: String,
    pub expires_in: u64,
    pub created: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeishuStartResponse {
    authorization_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YanxuSyncV2Data {
    pub revision: u64,
    pub updated_at: Option<String>,
    pub application_data: serde_json::Value,
    pub usage_habits: serde_json::Value,
}

#[tauri::command]
pub fn yanxu_sync_v2_create_snapshot(
    core: CoreState<'_>,
    include_history: bool,
    include_correction_rules: bool,
) -> Result<YanxuSyncV2LocalSnapshot, String> {
    let vocabulary = core.list_vocabulary().map_err(|error| error.to_string())?;
    let correction_rules = if include_correction_rules {
        core.list_correction_rules()
            .map_err(|error| error.to_string())?
    } else {
        Vec::new()
    };
    let mut custom_style_packs: Vec<StylePack> = core
        .list_style_packs(&core.get_preferences().active_style_pack_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|pack| pack.kind != StylePackKind::Builtin)
        .collect();
    for pack in &mut custom_style_packs {
        // A filesystem icon path is machine-specific. The textual style definition is portable.
        pack.icon_path = None;
        pack.active = false;
    }
    let snapshot = YanxuSyncV2LocalSnapshot {
        schema_version: 2,
        vocabulary,
        correction_rules,
        custom_style_packs,
        activity: core.list_activity().map_err(|error| error.to_string())?,
        history: if include_history {
            let mut records = core.list_history().map_err(|error| error.to_string())?;
            for record in &mut records {
                record.has_audio_recording = None;
            }
            records
        } else {
            Vec::new()
        },
    };
    ensure_snapshot_size(&snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
pub fn yanxu_sync_v2_restore_snapshot(
    core: CoreState<'_>,
    snapshot: YanxuSyncV2LocalSnapshot,
) -> Result<YanxuSyncV2RestoreResult, String> {
    ensure_snapshot_size(&snapshot)?;
    if snapshot.schema_version != 2 {
        return Err("同步数据版本不受支持".into());
    }

    let mut result = YanxuSyncV2RestoreResult {
        vocabulary_added: 0,
        correction_rules_added: 0,
        style_packs_added: 0,
        style_packs_updated: 0,
        activity_days_merged: snapshot.activity.len(),
        history_entries_merged: 0,
    };

    let existing_vocab = core.list_vocabulary().map_err(|error| error.to_string())?;
    for entry in snapshot.vocabulary {
        if existing_vocab
            .iter()
            .any(|local| local.phrase.eq_ignore_ascii_case(&entry.phrase))
        {
            continue;
        }
        let created = core
            .add_vocabulary(entry.phrase, entry.note)
            .map_err(|error| error.to_string())?;
        core.set_vocabulary_enabled(&created.id, entry.enabled)
            .map_err(|error| error.to_string())?;
        result.vocabulary_added += 1;
    }

    let existing_rules = core
        .list_correction_rules()
        .map_err(|error| error.to_string())?;
    for rule in snapshot.correction_rules {
        if existing_rules
            .iter()
            .any(|local| local.pattern == rule.pattern && local.replacement == rule.replacement)
        {
            continue;
        }
        let created = core
            .add_correction_rule(rule.pattern, rule.replacement)
            .map_err(|error| error.to_string())?;
        core.set_correction_rule_enabled(&created.id, rule.enabled)
            .map_err(|error| error.to_string())?;
        result.correction_rules_added += 1;
    }

    let existing_packs = core
        .list_style_packs(&core.get_preferences().active_style_pack_id)
        .map_err(|error| error.to_string())?;
    for mut pack in snapshot.custom_style_packs {
        if pack.kind == StylePackKind::Builtin {
            continue;
        }
        pack.icon_path = None;
        pack.active = false;
        match existing_packs.iter().find(|local| local.id == pack.id) {
            Some(local) if local.kind == StylePackKind::Builtin => continue,
            Some(_) => {
                core.update_style_pack(pack)
                    .map_err(|error| error.to_string())?;
                result.style_packs_updated += 1;
            }
            None => {
                core.create_style_pack(pack)
                    .map_err(|error| error.to_string())?;
                result.style_packs_added += 1;
            }
        }
    }

    core.merge_cloud_activity(&snapshot.activity)
        .map_err(|error| error.to_string())?;
    result.history_entries_merged = core
        .merge_cloud_history(&snapshot.history)
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn ensure_snapshot_size(snapshot: &YanxuSyncV2LocalSnapshot) -> Result<(), String> {
    let bytes = serde_json::to_vec(snapshot).map_err(|_| "无法编码本机同步数据".to_string())?;
    if bytes.len() > MAX_SYNC_DATA_BYTES - 1024 {
        return Err("本机同步数据超过 16 MiB 上限；请减少保留的历史记录或风格包内容".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    protocol_version: u32,
    service: String,
    authentication: Vec<String>,
    end_to_end_encryption: bool,
    max_data_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
    protocol_version: u32,
    access_token: String,
    token_type: String,
    expires_in: u64,
    account: Account,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountProfileResponse {
    username: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    username: String,
    #[serde(default)]
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataResponse {
    protocol_version: u32,
    revision: u64,
    updated_at: Option<String>,
    application_data: serde_json::Value,
    usage_habits: serde_json::Value,
}

#[tauri::command]
pub async fn yanxu_sync_v2_test_connection(
    origin: String,
) -> Result<YanxuSyncV2Connection, String> {
    let (origin, client) = make_client(&origin)?;
    let health_url = endpoint(&origin, "/v2/health");
    let health = client
        .get(health_url)
        .send()
        .await
        .map_err(|_| "服务器健康检查请求失败；请检查地址、端口和网络".to_string())?;
    if !health.status().is_success() {
        return Err(response_error("服务器健康检查", health).await);
    }
    let capabilities_url = endpoint(&origin, "/v2/capabilities");
    let response = client
        .get(capabilities_url)
        .send()
        .await
        .map_err(|_| "读取服务器能力失败；请检查地址、端口和网络".to_string())?;
    let caps: Capabilities = read_json(response, "服务器能力响应").await?;
    if caps.protocol_version != 2 || caps.service != "yanxu-sync" || caps.max_data_bytes == 0 {
        return Err("服务器协议版本或服务标识不匹配".into());
    }
    Ok(YanxuSyncV2Connection {
        protocol_version: caps.protocol_version,
        service: caps.service,
        authentication: caps.authentication,
        end_to_end_encryption: caps.end_to_end_encryption,
        max_data_bytes: caps.max_data_bytes,
    })
}

#[tauri::command]
pub async fn yanxu_sync_v2_register(
    state: tauri::State<'_, YanxuSyncV2State>,
    origin: String,
    username: String,
    password: String,
    allow_insecure_http: bool,
) -> Result<YanxuSyncV2Login, String> {
    authenticate(
        state,
        origin,
        username,
        password,
        "register",
        allow_insecure_http,
    )
    .await
}

#[tauri::command]
pub async fn yanxu_sync_v2_login(
    state: tauri::State<'_, YanxuSyncV2State>,
    origin: String,
    username: String,
    password: String,
    allow_insecure_http: bool,
) -> Result<YanxuSyncV2Login, String> {
    authenticate(
        state,
        origin,
        username,
        password,
        "login",
        allow_insecure_http,
    )
    .await
}

#[tauri::command]
pub fn yanxu_sync_v2_take_feishu_ticket(
    state: tauri::State<'_, YanxuSyncV2State>,
) -> Option<String> {
    state.pending_feishu_ticket.lock().take()
}

#[tauri::command]
pub async fn yanxu_sync_v2_feishu_start(
    origin: String,
    allow_insecure_http: bool,
) -> Result<String, String> {
    let (origin, client) = make_client(&origin)?;
    ensure_auth_transport(&origin, allow_insecure_http)?;
    let response = client
        .post(endpoint(&origin, "/v2/auth/feishu/start"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|_| "无法联系服务器以开始飞书登录".to_string())?;
    let start: FeishuStartResponse = read_json(response, "飞书授权地址").await?;
    let url = Url::parse(&start.authorization_url)
        .map_err(|_| "服务器返回的飞书授权地址无效".to_string())?;
    if url.scheme() != "https" || !matches!(url.host_str(), Some("accounts.feishu.cn")) {
        return Err("服务器返回的飞书授权地址无效".into());
    }
    Ok(start.authorization_url)
}

#[tauri::command]
pub async fn yanxu_sync_v2_feishu_resolve(
    state: tauri::State<'_, YanxuSyncV2State>,
    origin: String,
    ticket: String,
    allow_insecure_http: bool,
) -> Result<YanxuSyncV2FeishuLogin, String> {
    let (origin, client) = make_client(&origin)?;
    ensure_auth_transport(&origin, allow_insecure_http)?;
    let response = client
        .post(endpoint(&origin, "/v2/auth/feishu/resolve"))
        .json(&serde_json::json!({"ticket": ticket}))
        .send()
        .await
        .map_err(|_| "无法验证飞书授权结果".to_string())?;
    let result: FeishuResolveResponse = read_json(response, "飞书登录结果").await?;
    if result.status != "authenticated" {
        return Err("服务器未能自动创建或识别飞书账号".into());
    }
    let session = result
        .session
        .ok_or_else(|| "服务器登录响应格式不正确".to_string())?;
    let created = result.created.unwrap_or(false);
    let login = set_session(&state, &origin, session)?;
    Ok(YanxuSyncV2FeishuLogin {
        username: login.username,
        display_name: login.display_name,
        expires_in: login.expires_in,
        created,
    })
}

#[tauri::command]
pub fn yanxu_sync_v2_session(
    state: tauri::State<'_, YanxuSyncV2State>,
) -> Option<YanxuSyncV2Session> {
    state
        .session
        .lock()
        .as_ref()
        .map(|session| YanxuSyncV2Session {
            username: session.username.clone(),
            display_name: if session.display_name.is_empty() {
                if session.username.starts_with("fs_") {
                    "飞书用户".to_string()
                } else {
                    session.username.clone()
                }
            } else {
                session.display_name.clone()
            },
        })
}

#[tauri::command]
pub async fn yanxu_sync_v2_refresh_session(
    state: tauri::State<'_, YanxuSyncV2State>,
) -> Result<Option<YanxuSyncV2Session>, String> {
    let Some((origin, token)) = state
        .session
        .lock()
        .as_ref()
        .map(|session| (session.origin.clone(), session.token.clone()))
    else {
        return Ok(None);
    };
    let (origin, client) = make_client(&origin)?;
    let response = client
        .get(endpoint(&origin, "/v2/me/profile"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| "刷新云端账号姓名失败；请检查网络连接".to_string())?;
    let profile: AccountProfileResponse = read_json(response, "账号资料响应").await?;
    let display_name = if profile.display_name.trim().is_empty() {
        if profile.username.starts_with("fs_") {
            "飞书用户".to_string()
        } else {
            profile.username.clone()
        }
    } else {
        profile.display_name
    };

    let mut guard = state.session.lock();
    let Some(session) = guard.as_mut().filter(|session| session.token == token) else {
        return Ok(None);
    };
    session.username = profile.username.clone();
    session.display_name = display_name.clone();
    if let Err(error) = save_session(session) {
        log::warn!("[yanxu-sync] could not persist refreshed account profile: {error}");
    }
    Ok(Some(YanxuSyncV2Session {
        username: profile.username,
        display_name,
    }))
}

#[tauri::command]
pub async fn yanxu_sync_v2_read_data(
    state: tauri::State<'_, YanxuSyncV2State>,
) -> Result<YanxuSyncV2Data, String> {
    let (origin, token) = session_credentials(&state)?;
    let (origin, client) = make_client(&origin)?;
    let response = client
        .get(endpoint(&origin, "/v2/me/data"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "读取云端应用数据失败；请检查网络连接".to_string())?;
    let data: DataResponse = read_json(response, "云端数据响应").await?;
    if data.protocol_version != 2 || data.application_data.is_null() || data.usage_habits.is_null()
    {
        return Err("云端数据格式或协议版本不正确".into());
    }
    Ok(YanxuSyncV2Data {
        revision: data.revision,
        updated_at: data.updated_at,
        application_data: data.application_data,
        usage_habits: data.usage_habits,
    })
}

#[tauri::command]
pub async fn yanxu_sync_v2_write_data(
    state: tauri::State<'_, YanxuSyncV2State>,
    expected_revision: u64,
    application_data: serde_json::Value,
    usage_habits: serde_json::Value,
) -> Result<YanxuSyncV2Data, String> {
    if !application_data.is_object() || !usage_habits.is_object() {
        return Err("应用数据与使用习惯必须是对象".into());
    }
    let (origin, token) = session_credentials(&state)?;
    let (origin, client) = make_client(&origin)?;
    let body = serde_json::json!({
        "schemaVersion": 2,
        "applicationData": application_data,
        "usageHabits": usage_habits,
    });
    let encoded_body = serde_json::to_vec(&body).map_err(|_| "无法编码同步数据".to_string())?;
    if encoded_body.len() > MAX_SYNC_DATA_BYTES {
        return Err("同步数据超过服务器 16 MiB 上限；请减少保留的历史记录或风格包内容".into());
    }
    let response = client
        .put(endpoint(&origin, "/v2/me/data"))
        .bearer_auth(token)
        .header(
            reqwest::header::IF_MATCH,
            format!("\"{expected_revision}\""),
        )
        .body(encoded_body)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .send()
        .await
        .map_err(|_| "上传云端应用数据失败；请检查网络连接".to_string())?;
    let data: DataResponse = read_json(response, "云端保存响应").await?;
    if data.protocol_version != 2 {
        return Err("云端保存响应的协议版本不正确".into());
    }
    Ok(YanxuSyncV2Data {
        revision: data.revision,
        updated_at: data.updated_at,
        application_data: data.application_data,
        usage_habits: data.usage_habits,
    })
}

#[tauri::command]
pub async fn yanxu_sync_v2_logout(state: tauri::State<'_, YanxuSyncV2State>) -> Result<(), String> {
    let session = state.session.lock().take();
    delete_saved_session();
    let Some(session) = session else {
        return Ok(());
    };
    let (origin, client) = make_client(&session.origin)?;
    let response = client
        .delete(endpoint(&origin, "/v2/auth/session"))
        .bearer_auth(session.token)
        .send()
        .await
        .map_err(|_| "退出登录时无法联系服务器；本机登录状态已清除".to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(response_error("退出登录", response).await)
    }
}

async fn authenticate(
    state: tauri::State<'_, YanxuSyncV2State>,
    origin_input: String,
    username: String,
    password: String,
    action: &str,
    allow_insecure_http: bool,
) -> Result<YanxuSyncV2Login, String> {
    if password.is_empty() {
        return Err("请输入密码".into());
    }
    let (origin, client) = make_client(&origin_input)?;
    if origin.scheme() != "https"
        && !origin.host_str().is_some_and(is_loopback)
        && !allow_insecure_http
    {
        return Err("用户名和密码不能通过公网 HTTP 发送；请配置 HTTPS".into());
    }
    let url = endpoint(&origin, &format!("/v2/auth/{action}"));
    let response = client
        .post(url)
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|_| "登录请求未能到达服务器；请检查地址、端口和网络".to_string())?;
    let auth: AuthResponse = read_json(
        response,
        if action == "register" {
            "注册响应"
        } else {
            "登录响应"
        },
    )
    .await?;
    if auth.protocol_version != 2 || auth.token_type != "Bearer" || auth.access_token.is_empty() {
        return Err("服务器登录响应格式不正确".into());
    }
    set_session(&state, &origin, auth)
}

fn ensure_auth_transport(origin: &Url, allow_insecure_http: bool) -> Result<(), String> {
    if origin.scheme() != "https"
        && !origin.host_str().is_some_and(is_loopback)
        && !allow_insecure_http
    {
        return Err("飞书授权和账号绑定需要 HTTPS；请先配置 HTTPS".into());
    }
    Ok(())
}

fn set_session(
    state: &YanxuSyncV2State,
    origin: &Url,
    auth: AuthResponse,
) -> Result<YanxuSyncV2Login, String> {
    if auth.protocol_version != 2 || auth.token_type != "Bearer" || auth.access_token.is_empty() {
        return Err("服务器登录响应格式不正确".into());
    }
    let username = auth.account.username;
    let display_name = if auth.account.display_name.trim().is_empty() {
        if username.starts_with("fs_") {
            "飞书用户".to_string()
        } else {
            username.clone()
        }
    } else {
        auth.account.display_name
    };
    let session = Session {
        origin: origin.to_string().trim_end_matches('/').to_string(),
        token: auth.access_token,
        username: username.clone(),
        display_name: display_name.clone(),
        expires_at: chrono::Utc::now()
            .timestamp()
            .saturating_add(auth.expires_in as i64),
    };
    if let Err(error) = save_session(&session) {
        log::warn!("[yanxu-sync] could not persist login session: {error}");
    }
    *state.session.lock() = Some(session);
    Ok(YanxuSyncV2Login {
        username,
        display_name,
        expires_in: auth.expires_in,
    })
}

fn session_credentials(state: &YanxuSyncV2State) -> Result<(String, String), String> {
    state
        .session
        .lock()
        .as_ref()
        .map(|session| (session.origin.clone(), session.token.clone()))
        .ok_or_else(|| "请先登录同步账号".to_string())
}

fn make_client(origin: &str) -> Result<(Url, Client), String> {
    let url = Url::parse(origin.trim()).map_err(|_| "服务器地址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "/" | "")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "服务器地址须为根地址，例如 https://sync.example 或 http://127.0.0.1:8082".into(),
        );
    }
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(url.scheme() == "https")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "无法创建网络连接".to_string())?;
    Ok((url, client))
}

fn endpoint(origin: &Url, path: &str) -> Url {
    let mut url = origin.clone();
    url.set_path(path);
    url
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

async fn read_json<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    stage: &str,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(response_error(stage, response).await);
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_RESPONSE_BYTES)
    {
        return Err(format!("{stage}超过大小限制"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| format!("{stage}读取失败"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!("{stage}超过大小限制"));
    }
    serde_json::from_slice(&bytes).map_err(|_| format!("{stage}不是有效的 JSON 响应"))
}

async fn response_error(stage: &str, response: reqwest::Response) -> String {
    let status: StatusCode = response.status();
    let body = response
        .bytes()
        .await
        .ok()
        .filter(|body| body.len() <= 16 * 1024);
    let details = body
        .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok())
        .and_then(|value| value.get("error").cloned());
    let code = details
        .as_ref()
        .and_then(|error| error.get("code"))
        .and_then(serde_json::Value::as_str)
        .map(|value| safe_error_field(value, 48));
    let message = details
        .as_ref()
        .and_then(|error| error.get("message"))
        .and_then(serde_json::Value::as_str)
        .map(|value| safe_error_field(value, 160));
    let request_id = details
        .as_ref()
        .and_then(|error| error.get("requestId"))
        .and_then(serde_json::Value::as_str)
        .map(|value| safe_error_field(value, 64));

    let mut detail = Vec::new();
    if let Some(code) = code.filter(|value| !value.is_empty()) {
        detail.push(code);
    }
    if let Some(message) = message.filter(|value| !value.is_empty()) {
        detail.push(message);
    }
    let detail = if detail.is_empty() {
        String::new()
    } else {
        format!("，{}", detail.join("："))
    };
    let request_id = request_id
        .map(|id| format!("，请求编号 {id}"))
        .unwrap_or_default();
    format!(
        "{stage}失败（HTTP {}{detail}{request_id}）",
        status.as_u16()
    )
}

fn safe_error_field(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect()
}
