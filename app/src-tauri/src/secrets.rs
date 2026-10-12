use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::AppResult;
use crate::paths::{config_dir, read_to_string, write_atomic};

/// 只存在本机的东西：大模型 API Key、同步用的 GitHub 令牌。
///
/// **硬约束（对应需求"配置保留在本地不允许放在公网"）**：
/// 1. 只写 `<app_config_dir>/secrets.json`（安卓为应用私有目录）；
/// 2. 永不出现在存档、导出包、同步内容里 —— 见 [`redact_for_transfer`]；
/// 3. 前端只能拿到掩码（是否已设置 + 末 4 位），拿不到明文。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalSecrets {
    #[serde(default)]
    pub llm_api_key: String,
    #[serde(default)]
    pub sync_token: String,
}

/// 给前端看的掩码视图：只有"有没有"和"末四位"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskedSecrets {
    pub llm_key_set: bool,
    pub llm_key_hint: String,
    pub sync_token_set: bool,
    pub sync_token_hint: String,
}

impl LocalSecrets {
    pub fn masked(&self) -> MaskedSecrets {
        MaskedSecrets {
            llm_key_set: !self.llm_api_key.is_empty(),
            llm_key_hint: hint(&self.llm_api_key),
            sync_token_set: !self.sync_token.is_empty(),
            sync_token_hint: hint(&self.sync_token),
        }
    }
}

fn hint(secret: &str) -> String {
    if secret.is_empty() {
        return String::new();
    }
    let tail: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("****{}", tail)
}

pub struct SecretsState {
    pub inner: Mutex<LocalSecrets>,
}

impl SecretsState {
    pub fn load(app: &AppHandle) -> AppResult<Self> {
        let path = secrets_path(app)?;
        let secrets = if path.exists() {
            serde_json::from_str::<LocalSecrets>(&read_to_string(&path)?).unwrap_or_default()
        } else {
            LocalSecrets::default()
        };
        Ok(Self {
            inner: Mutex::new(secrets),
        })
    }

    pub fn snapshot(&self) -> LocalSecrets {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn persist(&self, app: &AppHandle) -> AppResult<()> {
        let value = self.snapshot();
        let path = secrets_path(app)?;
        let json = serde_json::to_vec_pretty(&value)?;
        write_atomic(&path, &json)?;
        restrict_permissions(&path);
        Ok(())
    }

    /// 只更新"非空"的字段：前端留空表示"不改动"，避免误清空已存的 Key。
    pub fn update(&self, llm_api_key: Option<String>, sync_token: Option<String>) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| crate::error::AppError::Other("密钥状态被占用".into()))?;
        if let Some(k) = llm_api_key {
            guard.llm_api_key = k.trim().to_string();
        }
        if let Some(t) = sync_token {
            guard.sync_token = t.trim().to_string();
        }
        Ok(())
    }

    pub fn clear_llm_key(&self) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| crate::error::AppError::Other("密钥状态被占用".into()))?;
        guard.llm_api_key.clear();
        Ok(())
    }

    pub fn clear_sync_token(&self) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| crate::error::AppError::Other("密钥状态被占用".into()))?;
        guard.sync_token.clear();
        Ok(())
    }
}

fn secrets_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join("secrets.json"))
}

/// 尽量收紧权限（Android / Linux / macOS）；Windows 走用户目录 ACL。
fn restrict_permissions(path: &PathBuf) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// 出网/入库前的兜底清洗：递归删掉任何看起来像密钥的字段。
///
/// 这是第二道防线——第一道是"根本不放进去"。存档与同步都会过这一层，
/// 万一将来有人往 GameState 里塞了 apiKey，也不会被推到 GitHub。
pub fn redact_for_transfer(value: &mut serde_json::Value) {
    const SENSITIVE: [&str; 6] = [
        "apiKey",
        "api_key",
        "token",
        "sync_token",
        "authorization",
        "secret",
    ];
    match value {
        serde_json::Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for k in keys {
                let lower = k.to_ascii_lowercase();
                if SENSITIVE.iter().any(|s| lower == s.to_ascii_lowercase()) {
                    map.remove(&k);
                    continue;
                }
                if let Some(child) = map.get_mut(&k) {
                    redact_for_transfer(child);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                redact_for_transfer(item);
            }
        }
        _ => {}
    }
}
