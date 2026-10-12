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

/// 写路径：需要时创建目录。
pub fn save_dir(app: &AppHandle, save_id: &str) -> AppResult<PathBuf> {
    let safe = sanitize_id(save_id);
    let dir = saves_dir(app)?.join(&safe);
    ensure_dir(&dir)?;
    Ok(dir)
}

/// 读路径：**不创建目录**。
///
/// 原先读操作也走 `save_dir`，于是"读一个不存在的 id"会顺手造出一个空目录，
/// 而空目录又会被"本地存档列表"列出来（还会被批量推送尝试上传）。
pub fn save_dir_existing(app: &AppHandle, save_id: &str) -> AppResult<PathBuf> {
    Ok(saves_dir(app)?.join(sanitize_id(save_id)))
}

#[cfg(test)]
mod tests {
    use super::sanitize_id;

    #[test]
    fn 普通_id_原样保留() {
        assert_eq!(sanitize_id("save-20261012"), "save-20261012");
        assert_eq!(sanitize_id("preset_v2"), "preset_v2");
    }

    #[test]
    fn 空输入回落到常量() {
        assert_eq!(sanitize_id(""), "save");
        assert_eq!(sanitize_id("   "), "save");
    }

    /// 回归：中文名曾被过滤成空串，然后**全部塌缩到同一个 "save"**，
    /// 于是第二份中文存档/预设会互相撞名。现在应得到互不相同的确定性 id。
    #[test]
    fn 中文名得到稳定的不同_id() {
        let a = sanitize_id("默认预设");
        let b = sanitize_id("我的存档");
        assert!(a.starts_with("id-"), "应带哈希后缀：{a}");
        assert_ne!(a, b, "不同中文名不能撞成同一个 id");
        assert_eq!(a, sanitize_id("默认预设"), "同输入必须同结果（可复现）");
    }

    #[test]
    fn 路径逃逸被挡住() {
        assert_eq!(sanitize_id("../../etc/passwd"), "etcpasswd");
    }
}

pub fn ensure_dir(dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// 存档 / 预设 id 只允许字母数字与 `-` `_`，防止 `../` 逃逸出配置目录。
///
/// 实测坑：中文名（如"默认预设"）会被过滤成空串。原先一律回退到常量 `"save"`，
/// 于是**所有中文名都塌缩成同一个 id**——第二份中文存档/预设会互相撞名。
/// 现在改成附带一个确定性短哈希，既不碰撞也不引入随机性。
pub fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if !cleaned.is_empty() {
        return cleaned;
    }
    if id.trim().is_empty() {
        return "save".to_string();
    }
    // FNV-1a：快、无依赖、同输入同结果
    let mut h: u32 = 0x811c_9dc5;
    for b in id.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("id-{h:08x}")
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
