use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// 配置目录：只放**本机**的东西（模型配置、密钥、同步凭据）。
/// 安卓上位于应用私有目录，其它 App 读不到。
pub fn config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    ensure_dir(&dir)?;
    Ok(dir)
}

/// 数据目录：存档所在。
pub fn data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    ensure_dir(&dir)?;
    Ok(dir)
}

pub fn saves_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = data_dir(app)?.join("saves");
    ensure_dir(&dir)?;
    Ok(dir)
}

pub fn save_dir(app: &AppHandle, save_id: &str) -> AppResult<PathBuf> {
    let safe = sanitize_id(save_id);
    let dir = saves_dir(app)?.join(&safe);
    ensure_dir(&dir)?;
    Ok(dir)
}

pub fn ensure_dir(dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// 存档 id 只允许字母数字与 `-` `_`，防止 `../` 逃逸出存档目录。
pub fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "save".to_string()
    } else {
        cleaned
    }
}

/// 原子写：先写临时文件再 rename，避免中途断电留下半截存档。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension("tmp-write");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn read_to_string(path: &Path) -> AppResult<String> {
    std::fs::read_to_string(path).map_err(|e| AppError::Io(format!("{}：{}", path.display(), e)))
}
