use serde::Serialize;

/// 统一错误类型：所有 Tauri command 返回 `Result<T, AppError>`，
/// 序列化后前端拿到的是**纯字符串**，不需要解析对象。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("网络请求失败：{0}")]
    Http(String),

    #[error("接口返回 {status}：{body}")]
    Api { status: u16, body: String },

    #[error("尚未配置：{0}")]
    NotConfigured(String),

    #[error("文件读写失败：{0}")]
    Io(String),

    #[error("数据格式错误：{0}")]
    Data(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Data(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            AppError::Http("请求超时".into())
        } else if e.is_connect() {
            AppError::Http("无法连接（检查网络或接口地址）".into())
        } else {
            AppError::Http(e.to_string())
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// 把接口的错误响应压成人类可读的一行，避免把整页 HTML 塞进 UI。
pub fn api_error(status: u16, body: &str) -> AppError {
    let snippet: String = body.chars().take(400).collect();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        let msg = v
            .get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .and_then(|m| m.as_str())
            .or_else(|| v.get("message").and_then(|m| m.as_str()))
            .unwrap_or("");
        if !msg.is_empty() {
            return AppError::Api {
                status,
                body: msg.to_string(),
            };
        }
    }
    AppError::Api {
        status,
        body: snippet,
    }
}
