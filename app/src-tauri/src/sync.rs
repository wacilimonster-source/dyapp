//! 多端进度互通：用 GitHub 仓库当同步盘。
//!
//! 为什么是 GitHub：用户自带账号、零服务端、天然版本历史、可以回滚到任意一次同步。
//!
//! 边界（对应需求）：
//! - **只同步进度**（存档四件套：meta/state/chat/world）。
//! - **绝不同步密钥**：API Key 与 GitHub 令牌都在 `secrets.json`，不进存档；
//!   上传前还会过一遍 [`crate::secrets::redact_for_transfer`] 兜底。
//! - 冲突策略：v0.1 采用"按 `meta.updatedAt` 的后来者胜"，覆盖前把本地副本另存为
//!   `*.conflict-<时间戳>`，不静默丢数据。

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tauri::AppHandle;

use crate::error::{api_error, AppError, AppResult};
use crate::paths::{config_dir, read_to_string, sanitize_id, save_dir, saves_dir, write_atomic};
use crate::secrets::{redact_for_transfer, SecretsState};

const API: &str = "https://api.github.com";
const SAVE_FILES: [&str; 4] = ["meta.json", "state.json", "chat.jsonl", "world.json"];

/* ============================ 配置 ============================ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    /// `owner/repo`；建议用**私有**仓库
    pub repo: String,
    #[serde(default = "d_branch")]
    pub branch: String,
    #[serde(default = "d_path")]
    pub base_path: String,
    #[serde(default)]
    pub auto_push: bool,
}

fn d_branch() -> String {
    "main".into()
}
fn d_path() -> String {
    "saves".into()
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            repo: String::new(),
            branch: d_branch(),
            base_path: d_path(),
            auto_push: false,
        }
    }
}

pub struct SyncState {
    pub inner: Mutex<SyncConfig>,
}

impl SyncState {
    pub fn load(app: &AppHandle) -> AppResult<Self> {
        let path = config_path(app)?;
        let cfg = if path.exists() {
            serde_json::from_str::<SyncConfig>(&read_to_string(&path)?).unwrap_or_default()
        } else {
            SyncConfig::default()
        };
        Ok(Self {
            inner: Mutex::new(cfg),
        })
    }

    pub fn snapshot(&self) -> SyncConfig {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn persist(&self, app: &AppHandle) -> AppResult<()> {
        let json = serde_json::to_vec_pretty(&self.snapshot())?;
        write_atomic(&config_path(app)?, &json)?;
        Ok(())
    }
}

fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join("sync.json"))
}

/* ============================ GitHub Contents API ============================ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub sha: String,
    pub size: u64,
    pub is_dir: bool,
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .user_agent("dyapp/0.1 (daoyuan-standalone)")
        .build()
        .map_err(AppError::from)
}

fn require(token: &str, repo: &str) -> AppResult<()> {
    if token.trim().is_empty() {
        return Err(AppError::NotConfigured(
            "GitHub 令牌（需要有该仓库 Contents 读写权限）".into(),
        ));
    }
    if !repo.trim().contains('/') {
        return Err(AppError::NotConfigured("仓库（格式 owner/repo）".into()));
    }
    Ok(())
}

fn urlencoded(segment: &str) -> String {
    // 路径分段编码，保留 `/` 作为分隔符
    segment
        .split('/')
        .map(|s| urlencoding::encode(s).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

async fn get_json(token: &str, url: &str) -> AppResult<(u16, Value)> {
    let resp = client()?
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    Ok((status, value))
}

/// 列出一个目录；目录不存在返回空列表（首次同步时很常见，不该当错误）。
async fn list_dir(token: &str, cfg: &SyncConfig, path: &str) -> AppResult<Vec<RemoteEntry>> {
    let url = format!(
        "{}/repos/{}/contents/{}?ref={}",
        API,
        cfg.repo.trim(),
        urlencoded(path),
        urlencoding::encode(&cfg.branch)
    );
    let (status, value) = get_json(token, &url).await?;
    if status == 404 {
        return Ok(Vec::new());
    }
    if !(200..300).contains(&status) {
        return Err(api_error(status, &value.to_string()));
    }
    let mut out = Vec::new();
    if let Some(arr) = value.as_array() {
        for item in arr {
            out.push(RemoteEntry {
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                path: item
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                sha: item
                    .get("sha")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                size: item.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                is_dir: item.get("type").and_then(|v| v.as_str()) == Some("dir"),
            });
        }
    }
    Ok(out)
}

async fn get_file(
    token: &str,
    cfg: &SyncConfig,
    path: &str,
) -> AppResult<Option<(Vec<u8>, String)>> {
    use base64::Engine;
    let url = format!(
        "{}/repos/{}/contents/{}?ref={}",
        API,
        cfg.repo.trim(),
        urlencoded(path),
        urlencoding::encode(&cfg.branch)
    );
    let (status, value) = get_json(token, &url).await?;
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(api_error(status, &value.to_string()));
    }
    let sha = value
        .get("sha")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let content = value
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .replace(['\n', '\r'], "");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|e| AppError::Data(format!("远端文件解码失败：{}", e)))?;
    Ok(Some((bytes, sha)))
}

/// 写入文件；`sha` 为已有文件的 blob sha（新建时传 None）。
async fn put_file(
    token: &str,
    cfg: &SyncConfig,
    path: &str,
    bytes: &[u8],
    sha: Option<&str>,
    message: &str,
) -> AppResult<()> {
    use base64::Engine;
    let url = format!(
        "{}/repos/{}/contents/{}",
        API,
        cfg.repo.trim(),
        urlencoded(path)
    );
    let mut body = json!({
        "message": message,
        "content": base64::engine::general_purpose::STANDARD.encode(bytes),
        "branch": cfg.branch,
    });
    if let Some(s) = sha {
        body["sha"] = json!(s);
    }
    let resp = client()?
        .put(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&body)
        .send()
        .await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = resp.text().await.unwrap_or_default();
        return Err(api_error(status, &text));
    }
    Ok(())
}

/// git blob 的 SHA-1：`sha1("blob <len>\0" + content)`。
/// 用它和远端 sha 比对，内容没变就不提交，避免每次同步都产生一个空 commit。
fn git_blob_sha(content: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", content.len()).as_bytes());
    hasher.update(content);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/* ============================ 本地侧 ============================ */

fn local_save_ids(app: &AppHandle) -> AppResult<Vec<String>> {
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(saves_dir(app)?)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // 写入中（.tmp-writing）/ 换盘中（.old-backup）的残骸不是存档，别列也别推
        if !crate::save::is_save_dir_name(&name) {
            continue;
        }
        ids.push(name);
    }
    ids.sort();
    Ok(ids)
}

fn local_updated_at(app: &AppHandle, save_id: &str) -> Option<u64> {
    let meta = save_dir(app, save_id).ok()?.join("meta.json");
    let text = read_to_string(&meta).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("updatedAt").and_then(|v| v.as_u64()).or_else(|| {
        value
            .get("meta")
            .and_then(|m| m.get("updatedAt"))
            .and_then(|v| v.as_u64())
    })
}

/* ============================ Tauri commands ============================ */

#[tauri::command]
pub fn sync_config_get(
    sync: tauri::State<'_, SyncState>,
    secrets: tauri::State<'_, SecretsState>,
) -> Value {
    json!({
        "config": sync.snapshot(),
        "secrets": secrets.masked(),
    })
}

#[tauri::command]
pub fn sync_config_set(
    app: AppHandle,
    sync: tauri::State<'_, SyncState>,
    config: SyncConfig,
) -> AppResult<()> {
    {
        let mut guard = sync
            .inner
            .lock()
            .map_err(|_| AppError::Other("同步配置被占用".into()))?;
        *guard = config;
    }
    sync.persist(&app)
}

#[tauri::command]
pub fn sync_token_set(
    app: AppHandle,
    secrets: tauri::State<'_, SecretsState>,
    token: String,
) -> AppResult<()> {
    secrets.update(None, Some(token))?;
    secrets.persist(&app)
}

#[tauri::command]
pub fn sync_token_clear(app: AppHandle, secrets: tauri::State<'_, SecretsState>) -> AppResult<()> {
    secrets.clear_sync_token()?;
    secrets.persist(&app)
}

#[tauri::command]
pub fn sync_local_saves(app: AppHandle) -> AppResult<Vec<Value>> {
    let mut out = Vec::new();
    for id in local_save_ids(&app)? {
        out.push(json!({
            "id": id,
            "updatedAt": local_updated_at(&app, &id),
        }));
    }
    Ok(out)
}

/// 列出远端已有的存档 id。
#[tauri::command]
pub async fn sync_remote_saves(
    sync: tauri::State<'_, SyncState>,
    secrets: tauri::State<'_, SecretsState>,
) -> AppResult<Vec<RemoteEntry>> {
    let cfg = sync.snapshot();
    let token = secrets.snapshot().sync_token;
    require(&token, &cfg.repo)?;
    list_dir(&token, &cfg, &cfg.base_path).await
}

/// 推送一个存档：只上传有变化的文件；远端更新则拒绝（除非 force）。
#[tauri::command]
pub async fn sync_push(
    app: AppHandle,
    sync: tauri::State<'_, SyncState>,
    secrets: tauri::State<'_, SecretsState>,
    save_id: String,
    force: bool,
) -> AppResult<Value> {
    let cfg = sync.snapshot();
    let token = secrets.snapshot().sync_token;
    require(&token, &cfg.repo)?;

    let id = sanitize_id(&save_id);
    let dir = save_dir(&app, &id)?;
    let remote_dir = format!("{}/{}", cfg.base_path.trim_end_matches('/'), id);
    let remote = list_dir(&token, &cfg, &remote_dir).await?;

    // 未 force 时：远端更新则中止，避免把另一台设备的进度盖掉
    if !force {
        if let Some((bytes, _)) =
            get_file(&token, &cfg, &format!("{}/meta.json", remote_dir)).await?
        {
            let remote_updated = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.get("updatedAt").and_then(|x| x.as_u64()));
            if let (Some(r), Some(l)) = (remote_updated, local_updated_at(&app, &id)) {
                if r > l {
                    return Err(AppError::Other(format!(
                        "远端版本更新（远端 {} / 本机 {}）。请先「拉取」，或改用强制推送。",
                        r, l
                    )));
                }
            }
        }
    }

    // force 会覆盖远端：先把远端那一版取下来存到本地。
    // 与 sync_pull 覆盖本机前会备份对称 —— 否则强制推送会让另一台设备的进度无声消失
    // （远端是 git，历史可回滚，但用户得知道去哪儿找；存在存档目录里就找得到）。
    let mut remote_backup: Option<PathBuf> = None;
    if force {
        for name in SAVE_FILES {
            let Some(existing) = remote.iter().find(|e| e.name == name && !e.is_dir) else {
                continue;
            };
            let path = dir.join(name);
            if !path.exists() {
                continue;
            }
            if git_blob_sha(&std::fs::read(&path)?) == existing.sha {
                continue; // 内容一致，不会覆盖掉任何东西
            }
            if let Some((bytes, _)) =
                get_file(&token, &cfg, &format!("{}/{}", remote_dir, name)).await?
            {
                let bdir = remote_backup.get_or_insert_with(|| {
                    dir.join(format!(
                        "remote-backup-{}",
                        chrono::Local::now().format("%Y%m%d-%H%M%S")
                    ))
                });
                crate::paths::ensure_dir(bdir)?;
                write_atomic(&bdir.join(name), &bytes)?;
            }
        }
    }

    let mut uploaded = Vec::new();
    for name in SAVE_FILES {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        let mut bytes = std::fs::read(&path)?;
        // 兜底：meta/state 是 JSON，先过一遍敏感字段清洗
        if name.ends_with(".json") {
            if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
                redact_for_transfer(&mut value);
                bytes = serde_json::to_vec_pretty(&value)?;
            }
        }
        let local_sha = git_blob_sha(&bytes);
        let existing = remote.iter().find(|e| e.name == name && !e.is_dir);
        if existing.map(|e| e.sha == local_sha).unwrap_or(false) {
            continue; // 内容一致，跳过
        }
        put_file(
            &token,
            &cfg,
            &format!("{}/{}", remote_dir, name),
            &bytes,
            existing.map(|e| e.sha.as_str()),
            &format!("sync: {} · {}", id, name),
        )
        .await?;
        uploaded.push(name.to_string());
    }

    Ok(json!({
        "saveId": id,
        "uploaded": uploaded,
        "remoteBackup": remote_backup
            .map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
    }))
}

/// 拉取一个存档：远端更新才覆盖；覆盖前把本地副本另存为 `.conflict-<时间戳>`。
#[tauri::command]
pub async fn sync_pull(
    app: AppHandle,
    sync: tauri::State<'_, SyncState>,
    secrets: tauri::State<'_, SecretsState>,
    save_id: String,
    force: bool,
) -> AppResult<Value> {
    let cfg = sync.snapshot();
    let token = secrets.snapshot().sync_token;
    require(&token, &cfg.repo)?;

    let id = sanitize_id(&save_id);
    let dir = save_dir(&app, &id)?;
    let remote_dir = format!("{}/{}", cfg.base_path.trim_end_matches('/'), id);

    let remote_meta = get_file(&token, &cfg, &format!("{}/meta.json", remote_dir)).await?;
    let Some((remote_meta_bytes, _)) = remote_meta else {
        return Err(AppError::Other(format!("远端没有存档「{}」", id)));
    };
    let remote_updated = serde_json::from_slice::<Value>(&remote_meta_bytes)
        .ok()
        .and_then(|v| v.get("updatedAt").and_then(|x| x.as_u64()))
        .unwrap_or(0);

    let local_updated = local_updated_at(&app, &id);
    if !force {
        if let Some(l) = local_updated {
            if l > remote_updated {
                return Err(AppError::Other(format!(
                    "本机版本更新（本机 {} / 远端 {}）。请先「推送」，或改用强制拉取。",
                    l, remote_updated
                )));
            }
        }
    }

    // 先备份本地，再覆盖：多端同步最怕的就是静默丢档
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut written = Vec::new();
    let mut backup_dir: Option<PathBuf> = None;

    // 先把远端四件套全部取到内存，全部成功后才落盘。
    // 原先边取边写：写到一半网络失败，本地 meta.json 已是远端新值、chat.jsonl 还是旧的，
    // 下次同步会据此误判"本地最新"并拒绝拉取 —— 状态与叙事流就此分叉。
    let mut fetched: Vec<(String, Vec<u8>)> = Vec::new();
    for name in SAVE_FILES {
        let Some((bytes, _)) = get_file(&token, &cfg, &format!("{}/{}", remote_dir, name)).await?
        else {
            continue;
        };
        fetched.push((name.to_string(), bytes));
    }

    for (name, bytes) in &fetched {
        let name = name.as_str();
        let target = dir.join(name);
        if target.exists() && backup_dir.is_none() {
            let bdir = dir.join(format!("conflict-{}", stamp));
            crate::paths::ensure_dir(&bdir)?;
            for other in SAVE_FILES {
                let src = dir.join(other);
                if src.exists() {
                    std::fs::copy(&src, bdir.join(other))?;
                }
            }
            backup_dir = Some(bdir);
        }
        write_atomic(&target, bytes)?;
        written.push(name.to_string());
    }

    Ok(json!({
        "saveId": id,
        "written": written,
        "backup": backup_dir.map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
        "remoteUpdatedAt": remote_updated,
    }))
}

/// 一次把本机所有存档推到远端（首次换设备时最常用）。
#[tauri::command]
pub async fn sync_push_all(
    app: AppHandle,
    sync: tauri::State<'_, SyncState>,
    secrets: tauri::State<'_, SecretsState>,
) -> AppResult<Value> {
    let ids = local_save_ids(&app)?;
    let mut report = Vec::new();
    // 配置与令牌在整批里不变，提到循环外（原先每轮都取一次快照）
    let cfg = sync.snapshot();
    let token = secrets.snapshot().sync_token;
    for id in ids {
        // 逐个走同步逻辑，单个失败不影响其余。
        // 原先这里的 `?` 会让任意一档读失败直接终止整批（注释说的和做的不一样）。
        if let Err(e) = require(&token, &cfg.repo) {
            report.push(json!({ "id": id, "uploaded": [], "error": e.to_string() }));
            continue;
        }
        let dir = match save_dir(&app, &id) {
            Ok(d) => d,
            Err(e) => {
                report.push(json!({ "id": id, "uploaded": [], "error": e.to_string() }));
                continue;
            }
        };
        let remote_dir = format!("{}/{}", cfg.base_path.trim_end_matches('/'), id);
        let remote = list_dir(&token, &cfg, &remote_dir)
            .await
            .unwrap_or_default();
        let mut uploaded = Vec::new();
        let mut failed: Option<String> = None;
        for name in SAVE_FILES {
            let path = dir.join(name);
            if !path.exists() {
                continue;
            }
            let mut bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) => {
                    failed = Some(format!("读取 {name} 失败：{e}"));
                    break;
                }
            };
            if name.ends_with(".json") {
                if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
                    redact_for_transfer(&mut value);
                    match serde_json::to_vec_pretty(&value) {
                        Ok(b) => bytes = b,
                        Err(e) => {
                            failed = Some(format!("序列化 {name} 失败：{e}"));
                            break;
                        }
                    }
                }
            }
            let local_sha = git_blob_sha(&bytes);
            let existing = remote.iter().find(|e| e.name == name && !e.is_dir);
            if existing.map(|e| e.sha == local_sha).unwrap_or(false) {
                continue;
            }
            match put_file(
                &token,
                &cfg,
                &format!("{}/{}", remote_dir, name),
                &bytes,
                existing.map(|e| e.sha.as_str()),
                &format!("sync: {} · {}", id, name),
            )
            .await
            {
                Ok(()) => uploaded.push(name.to_string()),
                Err(e) => {
                    failed = Some(e.to_string());
                    break;
                }
            }
        }
        report.push(json!({ "id": id, "uploaded": uploaded, "error": failed }));
    }
    Ok(json!({ "saves": report }))
}
