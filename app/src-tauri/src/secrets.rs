use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::crypto;
use crate::error::AppResult;
use crate::paths::config_dir;

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
    /// 上次加载密钥文件时的错误（解密失败/文件损坏）。前端据此提示用户，
    /// 而不是让"我的 Key 莫名其妙没了"。
    #[serde(default)]
    pub decrypt_error: Option<String>,
}

impl LocalSecrets {
    pub fn masked(&self) -> MaskedSecrets {
        MaskedSecrets {
            llm_key_set: !self.llm_api_key.is_empty(),
            llm_key_hint: hint(&self.llm_api_key),
            sync_token_set: !self.sync_token.is_empty(),
            sync_token_hint: hint(&self.sync_token),
            decrypt_error: None,
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
    /// 加载密钥时的错误。宁可让用户看到"文件坏了"，也不要静默变成"没配过"。
    pub load_error: Mutex<Option<String>>,
}

impl SecretsState {
    pub fn load(app: &AppHandle) -> AppResult<Self> {
        let dir = config_dir(app)?;

        // 首选加密文件。注意 Err 与 Ok(None) 必须分开：
        // 前者是"文件在但解不开"（损坏/被篡改/跨设备拷贝），
        // 原先用 `if let Ok(Some(..))` 把它和"没有文件"一起吞掉，
        // 用户会以为"我从没配过 Key"，而且重新填写还会覆盖掉可恢复的旧文件。
        match crypto::read_sealed(&dir, "secrets.enc") {
            Ok(Some(bytes)) => {
                let parsed = serde_json::from_slice::<LocalSecrets>(&bytes).unwrap_or_default();
                return Ok(Self {
                    inner: Mutex::new(parsed),
                    load_error: Mutex::new(None),
                });
            }
            Ok(None) => { /* 没有文件，正常首次运行 */ }
            Err(e) => {
                let msg = format!("密钥文件无法解密：{e}");
                eprintln!("[crypto] {msg}");
                return Ok(Self {
                    inner: Mutex::new(LocalSecrets::default()),
                    load_error: Mutex::new(Some(msg)),
                });
            }
        }

        // 迁移：旧版本的明文 secrets.json —— 加密后就地删除明文，不留在磁盘上
        if let Some(text) = crypto::read_legacy_plaintext(&dir, "secrets.json") {
            if crypto::looks_like_json(text.as_bytes()) {
                let parsed = serde_json::from_str::<LocalSecrets>(&text).unwrap_or_default();
                let state = Self {
                    inner: Mutex::new(parsed),
                    load_error: Mutex::new(None),
                };
                match state.persist(app) {
                    Ok(()) => {
                        let _ = std::fs::remove_file(dir.join("secrets.json"));
                        eprintln!("[crypto] 已把明文 secrets.json 迁移为加密存储，并删除明文");
                    }
                    Err(e) => eprintln!("[crypto] 明文迁移失败，仍按明文读取：{e}"),
                }
                return Ok(state);
            }
        }

        Ok(Self {
            inner: Mutex::new(LocalSecrets::default()),
            load_error: Mutex::new(None),
        })
    }

    /// 带加载错误的掩码视图：前端据此提示"密钥文件坏了"。
    pub fn masked(&self) -> MaskedSecrets {
        let mut m = self.snapshot().masked();
        m.decrypt_error = self.load_error.lock().ok().and_then(|g| g.clone());
        m
    }

    /// 从已快照的密钥构造（命令里跨 await 用）。
    pub fn from_snapshot(inner: LocalSecrets) -> Self {
        Self {
            inner: Mutex::new(inner),
            load_error: Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> LocalSecrets {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn persist(&self, app: &AppHandle) -> AppResult<()> {
        let value = self.snapshot();
        let mut json = serde_json::to_vec_pretty(&value)?;
        let result = crypto::write_sealed(&config_dir(app)?, "secrets.enc", &json);
        crypto::wipe(&mut json); // 减少明文在内存里的驻留窗口
        result
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
