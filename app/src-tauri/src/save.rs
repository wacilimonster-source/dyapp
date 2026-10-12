//! 存档读写。
//!
//! 一个存档 = 四个文件（见 docs/05 第 9 节）：
//!   meta.json （小、常读）/ state.json （唯一权威状态）/ chat.jsonl （追加式叙事流）/ world.json （解锁足迹）
//! 拆开的原因：状态要频繁整体读写与同步，叙事流是追加型大文件。分开后同步只传变化的文件。
//!
//! 所有写入都走 `write_atomic`（临时文件 + rename），掉电不会留下半截存档。

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::paths::{read_to_string, sanitize_id, save_dir, saves_dir, write_atomic};
use crate::secrets::redact_for_transfer;

/// 当前存档结构版本，用于日后迁移。
pub const SAVE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMeta {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default = "default_version")]
    pub save_version: u32,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub playtime_ms: i64,
}

fn default_version() -> u32 {
    SAVE_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBundle {
    pub meta: SaveMeta,
    #[serde(default)]
    pub state: Value,
    #[serde(default)]
    pub turns: Vec<Value>,
    #[serde(default)]
    pub world: Value,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn meta_path(dir: &Path) -> std::path::PathBuf {
    dir.join("meta.json")
}
fn state_path(dir: &Path) -> std::path::PathBuf {
    dir.join("state.json")
}
fn chat_path(dir: &Path) -> std::path::PathBuf {
    dir.join("chat.jsonl")
}
fn world_path(dir: &Path) -> std::path::PathBuf {
    dir.join("world.json")
}

/* ============================ 读 ============================ */

/// 读单个存档。缺文件按空处理（刚建的档还没有 chat.jsonl 是正常的）。
pub fn read_bundle(app: &AppHandle, save_id: &str) -> AppResult<SaveBundle> {
    let id = sanitize_id(save_id);
    let dir = save_dir(app, &id)?;

    let meta: SaveMeta = if meta_path(&dir).exists() {
        serde_json::from_str(&read_to_string(&meta_path(&dir))?)?
    } else {
        SaveMeta {
            id: id.clone(),
            name: id.clone(),
            created_at: now_ms(),
            updated_at: now_ms(),
            save_version: SAVE_VERSION,
            summary: String::new(),
            playtime_ms: 0,
        }
    };

    // state.json 是权威状态：损坏必须报错，不能静默变成 null ——
    // 前端拿到空状态可能触发"重置式覆盖"，等于把损坏升级成丢档。
    let state: Value = if state_path(&dir).exists() {
        serde_json::from_str(&read_to_string(&state_path(&dir))?).map_err(|e| {
            AppError::Data(format!(
                "存档 {id} 的 state.json 已损坏（{e}）；请用「导入」恢复备份，不要在此档上继续游玩"
            ))
        })?
    } else {
        Value::Null
    };

    // world.json 只是解锁足迹等附属数据：坏了不阻塞读档，但要留痕
    let world: Value = if world_path(&dir).exists() {
        match serde_json::from_str(&read_to_string(&world_path(&dir))?) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[save] {id} 的 world.json 损坏，已按空处理：{e}");
                json!({})
            }
        }
    } else {
        json!({})
    };

    let mut turns: Vec<Value> = Vec::new();
    if chat_path(&dir).exists() {
        for line in read_to_string(&chat_path(&dir))?.lines() {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(t) {
                Ok(v) => turns.push(v),
                // 单行坏了不该让整个档读不出来：跳过并继续
                Err(_) => continue,
            }
        }
    }

    Ok(SaveBundle {
        meta,
        state,
        turns,
        world,
    })
}

/* ============================ 写 ============================ */

/// 写存档。`updated_at` 由本函数刷新——时间戳是冲突判定的依据，不接受前端传值。
pub fn write_bundle(app: &AppHandle, save_id: &str, bundle: SaveBundle) -> AppResult<SaveMeta> {
    let id = sanitize_id(save_id);
    let dir = save_dir(app, &id)?;
    let now = now_ms();

    let created = if meta_path(&dir).exists() {
        serde_json::from_str::<SaveMeta>(&read_to_string(&meta_path(&dir))?)
            .map(|m| m.created_at)
            .unwrap_or(now)
    } else {
        now
    };

    // 出盘前的兜底清洗：万一状态里混进了 apiKey 之类，也不落到磁盘上（更不会被同步出去）
    let mut state = bundle.state;
    redact_for_transfer(&mut state);
    let mut world = bundle.world;
    redact_for_transfer(&mut world);

    let meta = SaveMeta {
        id: id.clone(),
        name: if bundle.meta.name.trim().is_empty() {
            id.clone()
        } else {
            bundle.meta.name.trim().to_string()
        },
        created_at: created,
        updated_at: now,
        save_version: SAVE_VERSION,
        summary: bundle.meta.summary,
        playtime_ms: bundle.meta.playtime_ms,
    };

    write_atomic(
        &meta_path(&dir),
        serde_json::to_vec_pretty(&meta)?.as_slice(),
    )?;
    write_atomic(
        &state_path(&dir),
        serde_json::to_vec_pretty(&state)?.as_slice(),
    )?;
    write_atomic(
        &world_path(&dir),
        serde_json::to_vec_pretty(&world)?.as_slice(),
    )?;

    let mut lines = String::new();
    for t in &bundle.turns {
        lines.push_str(&serde_json::to_string(t)?);
        lines.push('\n');
    }
    write_atomic(&chat_path(&dir), lines.as_bytes())?;

    Ok(meta)
}

/// 删除存档目录。不可恢复。
pub fn delete_save(app: &AppHandle, save_id: &str) -> AppResult<()> {
    let id = sanitize_id(save_id);
    let dir = save_dir(app, &id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/* ============================ 导入 / 导出 ============================ */

/// 导出为单文件 JSON 包（跨设备迁移、备份用）。
pub fn export_bundle(app: &AppHandle, save_id: &str) -> AppResult<String> {
    let bundle = read_bundle(app, save_id)?;
    let mut value = serde_json::to_value(&bundle)?;
    redact_for_transfer(&mut value);
    Ok(serde_json::to_string_pretty(&value)?)
}

/// 导入单文件 JSON 包。id 冲突时自动加后缀，绝不覆盖已有存档。
pub fn import_bundle(app: &AppHandle, bundle_json: &str) -> AppResult<SaveMeta> {
    let bundle: SaveBundle = serde_json::from_str(bundle_json)
        .map_err(|e| AppError::Data(format!("存档包格式不对：{}", e)))?;

    let raw_id = if bundle.meta.id.trim().is_empty() {
        format!("import-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"))
    } else {
        bundle.meta.id.clone()
    };

    // 冲突就换 id，不覆盖。
    // 注意：sanitize_id 只取前 64 字符，所以拼后缀前必须先把主干截短 ——
    // 否则主干已满 64 位时，`{raw}-2` 截断后与初始 id 完全相同，循环空转 98 次
    // 后报"同 id 存档过多"，用户永远导不进来。
    let stem = sanitize_id(&raw_id);
    let mut id = stem.clone();
    let mut n = 1;
    while save_dir(app, &id)?.join("state.json").exists() {
        n += 1;
        let short: String = stem.chars().take(56).collect();
        id = sanitize_id(&format!("{short}-{n}"));
        if n > 99 {
            return Err(AppError::Other("同 id 存档过多，换一个包再试".into()));
        }
    }

    write_bundle(app, &id, bundle)
}

/* ============================ Tauri commands ============================ */

#[tauri::command]
pub fn save_list(app: AppHandle) -> AppResult<Vec<SaveMeta>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(saves_dir(&app)?)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let dir = entry.path();
        if !state_path(&dir).exists() {
            continue; // 只有目录没有状态：视为未完成，不列出
        }
        let meta = match std::fs::read_to_string(meta_path(&dir))
            .ok()
            .and_then(|s| serde_json::from_str::<SaveMeta>(&s).ok())
        {
            Some(m) => m,
            None => SaveMeta {
                id: id.clone(),
                name: id.clone(),
                created_at: 0,
                updated_at: 0,
                save_version: SAVE_VERSION,
                summary: String::new(),
                playtime_ms: 0,
            },
        };
        out.push(meta);
    }
    // 最近更新的排前面
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn save_read(app: AppHandle, save_id: String) -> AppResult<SaveBundle> {
    read_bundle(&app, &save_id)
}

#[tauri::command]
pub fn save_write(app: AppHandle, save_id: String, bundle: SaveBundle) -> AppResult<SaveMeta> {
    write_bundle(&app, &save_id, bundle)
}

#[tauri::command]
pub fn save_delete(app: AppHandle, save_id: String) -> AppResult<()> {
    delete_save(&app, &save_id)
}

#[tauri::command]
pub fn save_export(app: AppHandle, save_id: String) -> AppResult<String> {
    export_bundle(&app, &save_id)
}

#[tauri::command]
pub fn save_import(app: AppHandle, bundle_json: String) -> AppResult<SaveMeta> {
    import_bundle(&app, &bundle_json)
}
