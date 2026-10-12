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
use crate::paths::{
    config_dir, ensure_dir, read_to_string, sanitize_id, save_dir, saves_dir, write_atomic,
};
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

/// 按 blob sha 取文件内容（Git Blobs API，支持到 100MB）。
///
/// 为什么需要：GitHub Contents API 对 >1MB 的文件**不返回内联 content**
/// （`encoding: "none"`）。原先对缺失 content 直接 `unwrap_or("")`，
/// base64 解码空串会"成功"得到空文件 —— 长局的 chat.jsonl 一拉就变成空的。
async fn get_blob(token: &str, cfg: &SyncConfig, sha: &str) -> AppResult<Vec<u8>> {
    use base64::Engine;
    if sha.trim().is_empty() {
        return Err(AppError::Data(
            "远端文件没有内联内容，也没有 sha，无法按 blob 读取".into(),
        ));
    }
    let url = format!(
        "{}/repos/{}/git/blobs/{}",
        API,
        cfg.repo.trim(),
        urlencoding::encode(sha)
    );
    let (status, value) = get_json(token, &url).await?;
    if !(200..300).contains(&status) {
        return Err(api_error(status, &value.to_string()));
    }
    let encoding = value
        .get("encoding")
        .and_then(|v| v.as_str())
        .unwrap_or("base64");
    let content = value.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if encoding == "base64" {
        let cleaned = content.replace(['\n', '\r'], "");
        base64::engine::general_purpose::STANDARD
            .decode(cleaned)
            .map_err(|e| AppError::Data(format!("远端 blob 解码失败：{}", e)))
    } else {
        Ok(content.as_bytes().to_vec())
    }
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
    let encoding = value.get("encoding").and_then(|v| v.as_str()).unwrap_or("");
    // 只有 encoding=base64 才有内联内容；其余（大文件的 "none"）走 Blobs API
    if encoding != "base64" {
        let bytes = get_blob(token, cfg, &sha).await?;
        return Ok(Some((bytes, sha)));
    }
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

/// chat.jsonl 逐行清洗：单行解析失败按原样保留（多半是坏行，读取时也会被跳过）。
///
/// 上传与 `save_write` 都会走这一层 —— 用户把 Key 贴进对话被记录后，
/// 原样推送会把它送上 GitHub。
fn redact_jsonl(bytes: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = Vec::with_capacity(bytes.len());
    for line in text.split('\n') {
        let t = line.trim_end_matches('\r');
        if t.trim().is_empty() {
            continue;
        }
        let mut wrote = false;
        if let Ok(mut v) = serde_json::from_str::<Value>(t) {
            redact_for_transfer(&mut v);
            if let Ok(s) = serde_json::to_string(&v) {
                out.extend_from_slice(s.as_bytes());
                out.push(b'\n');
                wrote = true;
            }
        }
        if !wrote {
            out.extend_from_slice(t.as_bytes());
            out.push(b'\n');
        }
    }
    out
}

/// 推送一个存档的核心逻辑。**单档推送与批量推送共用这一条路径** ——
/// 原先 `sync_push_all` 自己重写了一遍上传，既没有 updatedAt 冲突检查也没有远端备份，
/// "首次换设备"批量推送时会把另一台设备的新进度整批静默覆盖。
async fn push_one(
    app: &AppHandle,
    cfg: &SyncConfig,
    token: &str,
    save_id: &str,
    force: bool,
) -> AppResult<Value> {
    let id = sanitize_id(save_id);
    let dir = save_dir(app, &id)?;
    crate::save::heal_save_dir(&dir); // 先收拾换盘残骸再读
    let remote_dir = format!("{}/{}", cfg.base_path.trim_end_matches('/'), id);
    let remote = list_dir(token, cfg, &remote_dir).await?;

    // 未 force 时：远端更新则中止，避免把另一台设备的进度盖掉
    if !force {
        if let Some((bytes, _)) = get_file(token, cfg, &format!("{}/meta.json", remote_dir)).await?
        {
            let remote_updated = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.get("updatedAt").and_then(|x| x.as_u64()));
            if let (Some(r), Some(l)) = (remote_updated, local_updated_at(app, &id)) {
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
                get_file(token, cfg, &format!("{}/{}", remote_dir, name)).await?
            {
                let bdir = remote_backup.get_or_insert_with(|| {
                    dir.join(format!(
                        "remote-backup-{}",
                        chrono::Local::now().format("%Y%m%d-%H%M%S")
                    ))
                });
                ensure_dir(bdir)?;
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
        // 兜底：JSON 先过一遍敏感字段清洗；叙事流逐行清洗。
        // 清洗结果同时参与 sha 比对与上传，避免"本地脏 → 每次都重传"的空转。
        if name == "chat.jsonl" {
            bytes = redact_jsonl(&bytes);
        } else if name.ends_with(".json") {
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
            token,
            cfg,
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
    push_one(&app, &cfg, &token, &save_id, force).await
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
    crate::save::heal_save_dir(&dir); // 先收拾换盘残骸再拉
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

    // 落盘用"临时目录 → 整体换盘"（与 save.rs 同机制）：
    // 拉取中途崩溃不会再留下"meta 新、chat 旧"的混合态。
    let tmp = crate::save::stage_files(&dir, &fetched)?;
    // 远端缺哪个文件就保留本地那一份（旧版行为兼容：拉取不该删掉远端没有的附属数据）
    for name in SAVE_FILES {
        if fetched.iter().any(|(n, _)| n == name) {
            continue;
        }
        let src = dir.join(name);
        if src.exists() {
            std::fs::copy(&src, tmp.join(name))?;
        }
    }
    let mut backup_name: Option<String> = None;
    // 覆盖前的本机副本写进**临时目录**里：commit 换盘时会把它带进新档，
    // 若留在旧目录则会被换盘后的清理一并删掉。
    let has_local = SAVE_FILES.iter().any(|n| dir.join(n).exists());
    if has_local {
        let bname = format!("conflict-{stamp}");
        let bdir = tmp.join(&bname);
        ensure_dir(&bdir)?;
        for other in SAVE_FILES {
            let src = dir.join(other);
            if src.exists() {
                std::fs::copy(&src, bdir.join(other))?;
            }
        }
        backup_name = Some(bname);
    }
    crate::save::commit_stage(&dir)?;

    let written: Vec<String> = fetched.into_iter().map(|(name, _)| name).collect();
    Ok(json!({
        "saveId": id,
        "written": written,
        "backup": backup_name,
        "remoteUpdatedAt": remote_updated,
    }))
}

/// 一次把本机所有存档推到远端（首次换设备时最常用）。
///
/// **每一档都走 `push_one`**：与单档推送共享同一个冲突检查（远端更新则跳过该档）
/// 与同一套敏感清洗。原先这里自己重写了一遍上传逻辑，既不看 `updatedAt`、
/// 也不做任何提示，批量推送会把另一台设备的新进度整批静默覆盖。
#[tauri::command]
pub async fn sync_push_all(
    app: AppHandle,
    sync: tauri::State<'_, SyncState>,
    secrets: tauri::State<'_, SecretsState>,
) -> AppResult<Value> {
    let ids = local_save_ids(&app)?;
    // 配置与令牌在整批里不变，提到循环外
    let cfg = sync.snapshot();
    let token = secrets.snapshot().sync_token;
    require(&token, &cfg.repo)?;

    let mut report = Vec::new();
    for id in ids {
        // 逐个走同步逻辑，单个失败不影响其余（错误如实记入该条）
        match push_one(&app, &cfg, &token, &id, false).await {
            Ok(v) => report.push(json!({
                "id": id,
                "uploaded": v.get("uploaded").cloned().unwrap_or_else(|| json!([])),
                "error": Value::Null,
            })),
            Err(e) => report.push(json!({
                "id": id,
                "uploaded": [],
                "error": e.to_string(),
            })),
        }
    }
    Ok(json!({ "saves": report }))
}
