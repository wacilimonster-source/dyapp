//! 预设存储：把 ST 的 Chat Completion 预设原样存在本机配置目录。
//!
//! 三条约定：
//! 1. **原样保存**——不做任何"清洗/规范化"，导出时逐字节还原，避免"用本 App 存一次预设就废了"。
//! 2. 归属本机配置（与 `llm.json` 同级），**不进存档、不参与 GitHub 同步**（决策 D6）：
//!    预设里常含个人写的台词/癖好文本，同步出去不合适，而且它不是"进度"。
//! 3. 明文存储（非密钥），无需加密。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::paths::{config_dir, ensure_dir, read_to_string, sanitize_id, write_atomic};

const INDEX: &str = "index.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PresetIndex {
    #[serde(default)]
    presets: Vec<PresetMeta>,
}

fn presets_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = config_dir(app)?.join("presets");
    ensure_dir(&dir)?;
    Ok(dir)
}

fn preset_path(app: &AppHandle, id: &str) -> AppResult<PathBuf> {
    Ok(presets_dir(app)?.join(format!("{}.json", sanitize_id(id))))
}

fn index_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(presets_dir(app)?.join(INDEX))
}

fn read_index(app: &AppHandle) -> PresetIndex {
    let path = match index_path(app) {
        Ok(p) => p,
        Err(_) => return PresetIndex::default(),
    };
    if !path.exists() {
        return PresetIndex::default();
    }
    read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<PresetIndex>(&s).ok())
        .unwrap_or_default()
}

fn write_index(app: &AppHandle, index: &PresetIndex) -> AppResult<()> {
    let json = serde_json::to_vec_pretty(index)?;
    write_atomic(&index_path(app)?, &json)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 从原始 JSON 里猜个展示名：ST 预设自己没有 name 字段，就退化成文件名。
fn guess_name(raw: &str, fallback: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| {
            v.get("name")
                .or_else(|| v.get("preset").and_then(|p| p.get("name")))
                .and_then(|n| n.as_str())
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// 列出现有预设。真实文件为准（index 只是缓存，丢了也能自愈）。
#[tauri::command]
pub fn preset_list(app: AppHandle) -> AppResult<Vec<PresetMeta>> {
    let dir = presets_dir(&app)?;
    let index = read_index(&app);
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name == INDEX || !file_name.ends_with(".json") {
            continue;
        }
        let id = file_name.trim_end_matches(".json").to_string();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let name = index
            .presets
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.clone())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| {
                read_to_string(&path)
                    .map(|raw| guess_name(&raw, &id))
                    .unwrap_or_else(|_| id.clone())
            });
        let updated_at = index
            .presets
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.updated_at)
            .unwrap_or(0);
        out.push(PresetMeta {
            id,
            name,
            updated_at,
            size,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    Ok(out)
}

/// 读取预设原文（逐字节，不做任何加工）。
#[tauri::command]
pub fn preset_read(app: AppHandle, id: String) -> AppResult<String> {
    let path = preset_path(&app, &id)?;
    if !path.exists() {
        return Err(AppError::Other(format!("没有这个预设：{id}")));
    }
    read_to_string(&path)
}

/// 写入预设。`raw` 必须是合法 JSON 文本；`name` 为空时自动取名。
#[tauri::command]
pub fn preset_write(
    app: AppHandle,
    id: String,
    raw: String,
    name: Option<String>,
) -> AppResult<PresetMeta> {
    // 先校验是合法 JSON，避免把坏文件落盘
    serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| AppError::Data(format!("预设不是合法 JSON：{e}")))?;

    let id = sanitize_id(&id);
    write_atomic(&preset_path(&app, &id)?, raw.as_bytes())?;

    let display = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| guess_name(&raw, &id));

    let mut index = read_index(&app);
    index.presets.retain(|p| p.id != id);
    let meta = PresetMeta {
        id: id.clone(),
        name: display,
        updated_at: now_ms(),
        size: raw.len() as u64,
    };
    index.presets.push(meta.clone());
    write_index(&app, &index)?;
    Ok(meta)
}

#[tauri::command]
pub fn preset_delete(app: AppHandle, id: String) -> AppResult<()> {
    let path = preset_path(&app, &id)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let mut index = read_index(&app);
    index.presets.retain(|p| p.id != sanitize_id(&id));
    write_index(&app, &index)?;
    Ok(())
}

/// 重命名（只改展示名，不动内容）。
#[tauri::command]
pub fn preset_rename(app: AppHandle, id: String, name: String) -> AppResult<PresetMeta> {
    let id = sanitize_id(&id);
    let path = preset_path(&app, &id)?;
    if !path.exists() {
        return Err(AppError::Other(format!("没有这个预设：{id}")));
    }
    let raw = read_to_string(&path)?;
    let mut index = read_index(&app);
    index.presets.retain(|p| p.id != id);
    let meta = PresetMeta {
        id: id.clone(),
        name: if name.trim().is_empty() {
            id.clone()
        } else {
            name.trim().to_string()
        },
        updated_at: now_ms(),
        size: raw.len() as u64,
    };
    index.presets.push(meta.clone());
    write_index(&app, &index)?;
    Ok(meta)
}

/// 导入一份预设：从原始 JSON 文本落盘，id 冲突就加后缀，绝不覆盖。
#[tauri::command]
pub fn preset_import(app: AppHandle, raw: String, name: Option<String>) -> AppResult<PresetMeta> {
    serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| AppError::Data(format!("预设不是合法 JSON：{e}")))?;
    let base = sanitize_id(&name.clone().unwrap_or_else(|| guess_name(&raw, "preset")));
    let mut id = base.clone();
    let mut n = 1;
    while preset_path(&app, &id)?.exists() {
        n += 1;
        id = format!("{base}-{n}");
        if n > 99 {
            return Err(AppError::Other("同名预设过多，请先清理".into()));
        }
    }
    preset_write(app, id, raw, name)
}

/// 顺手提供的目录路径（UI 上显示"预设存在哪"，便于用户自己备份）。
#[tauri::command]
pub fn preset_dir(app: AppHandle) -> AppResult<String> {
    Ok(presets_dir(&app)?.to_string_lossy().to_string())
}
