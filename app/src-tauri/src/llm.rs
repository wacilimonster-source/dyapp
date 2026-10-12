//! 最小可用的大模型客户端。
//!
//! 参照 PocketTavern 的调用约定，但**只保留本项目用到的部分**：
//! - 统一 `ProviderConfig`（base_url / endpoint_path / system_role / supports_stream / requires_api_key）
//! - 只实现 OpenAI 兼容的 `POST {base}/chat/completions`（SSE 流式 + 非流式）
//! - 流式增量规范化为 `delta` / `reasoning` / `usage` / `done` / `error` 五类事件
//! - 只做两个模型槽位：叙事模型（主）与裁决模型（辅，可选）
//!
//! 不做的：多 provider 适配层、工具调用循环、embedding、图片/语音、本地 llama.cpp。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::error::{api_error, AppError, AppResult};
use crate::paths::{config_dir, read_to_string, write_atomic};
use crate::secrets::SecretsState;

pub const DEFAULT_TIMEOUT_SECS: u64 = 600;
const REQUEST_TIMEOUT_SECS: u64 = 30;

/* ============================ 配置模型 ============================ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub endpoint_path: String,
    pub system_role: String,
    pub supports_stream: bool,
    pub requires_api_key: bool,
    #[serde(default)]
    pub default_headers: HashMap<String, String>,
}

impl ProviderConfig {
    pub fn preset(id: &str) -> Self {
        match id {
            "ollama" => Self {
                id: "ollama".into(),
                name: "Ollama（本地）".into(),
                base_url: "http://127.0.0.1:11434/v1".into(),
                endpoint_path: "/chat/completions".into(),
                system_role: "system".into(),
                supports_stream: true,
                requires_api_key: false,
                default_headers: HashMap::new(),
            },
            // 实测：该渠道要求 x-opencode-session 头，且对 stream:false 会挂住 —
            // 客户端一律走流式，会话头由用户在「附加请求头」里填。
            "opencodego" => Self {
                id: "opencodego".into(),
                name: "opencodego（需会话头）".into(),
                base_url: "https://opencode.ai/zen/go/v1".into(),
                endpoint_path: "/chat/completions".into(),
                system_role: "system".into(),
                supports_stream: true,
                requires_api_key: true,
                default_headers: HashMap::new(),
            },
            "custom" => Self {
                id: "custom".into(),
                name: "自定义（OpenAI 兼容）".into(),
                base_url: String::new(),
                endpoint_path: "/chat/completions".into(),
                system_role: "system".into(),
                supports_stream: true,
                requires_api_key: true,
                default_headers: HashMap::new(),
            },
            _ => Self {
                id: "openai".into(),
                name: "OpenAI".into(),
                base_url: "https://api.openai.com/v1".into(),
                endpoint_path: "/chat/completions".into(),
                system_role: "system".into(),
                supports_stream: true,
                requires_api_key: true,
                default_headers: HashMap::new(),
            },
        }
    }

    pub fn chat_url(&self) -> String {
        join_url(&self.base_url, &self.endpoint_path)
    }

    pub fn path(&self, suffix: &str) -> String {
        join_url(&self.base_url, suffix)
    }
}

fn join_url(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if path.is_empty() {
        return base.to_string();
    }
    if path.starts_with('/') {
        format!("{}{}", base, path)
    } else {
        format!("{}/{}", base, path)
    }
}

/// 一个模型槽位：模型名 + 采样参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSlot {
    pub model: String,
    #[serde(default = "d_temperature")]
    pub temperature: f64,
    #[serde(default = "d_top_p")]
    pub top_p: f64,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// 附加到请求体的厂商私有字段（如 prompt caching、enable_thinking）
    #[serde(default)]
    pub extra_body: HashMap<String, Value>,
}

fn d_temperature() -> f64 {
    0.85
}
fn d_top_p() -> f64 {
    0.95
}

impl Default for ModelSlot {
    fn default() -> Self {
        Self {
            model: String::new(),
            temperature: d_temperature(),
            top_p: d_top_p(),
            max_tokens: None,
            extra_body: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    pub provider: ProviderConfig,
    /// 叙事模型（主）：负责正文演出
    pub narrator: ModelSlot,
    /// 裁决模型（辅，可选）：负责 effects 抽取与近况压缩
    #[serde(default)]
    pub arbiter: Option<ModelSlot>,
    #[serde(default = "d_timeout")]
    pub timeout_secs: u64,
}

fn d_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            provider: ProviderConfig::preset("openai"),
            narrator: ModelSlot::default(),
            arbiter: None,
            timeout_secs: d_timeout(),
        }
    }
}

pub struct LlmState {
    pub inner: Mutex<LlmSettings>,
}

impl LlmState {
    pub fn load(app: &AppHandle) -> AppResult<Self> {
        let path = settings_path(app)?;
        let settings = if path.exists() {
            serde_json::from_str::<LlmSettings>(&read_to_string(&path)?)
                .unwrap_or_else(|_| LlmSettings::default())
        } else {
            LlmSettings::default()
        };
        Ok(Self {
            inner: Mutex::new(settings),
        })
    }

    pub fn snapshot(&self) -> LlmSettings {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn persist(&self, app: &AppHandle) -> AppResult<()> {
        let value = self.snapshot();
        // 注意：这份文件里**没有** apiKey —— Key 在 secrets.json，两者物理隔离。
        let json = serde_json::to_vec_pretty(&value)?;
        write_atomic(&settings_path(app)?, &json)?;
        Ok(())
    }
}

fn settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join("llm.json"))
}

/* ============================ 请求 ============================ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub request_id: String,
    pub messages: Vec<ChatMessage>,
    /// 用裁决模型而非叙事模型
    #[serde(default)]
    pub use_arbiter: bool,
    #[serde(default)]
    pub stream: bool,
    /// 要求返回严格 JSON（用于 effects 抽取）
    #[serde(default)]
    pub json_mode: bool,
    #[serde(default)]
    pub overrides: Option<ModelSlot>,
}

fn client(timeout_secs: u64) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent("dyapp/0.1 (daoyuan-standalone)")
        .build()
        .map_err(AppError::from)
}

fn headers(provider: &ProviderConfig, api_key: &str) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
    let mut map = HeaderMap::new();
    map.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if provider.requires_api_key && !api_key.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", api_key.trim())) {
            map.insert(AUTHORIZATION, v);
        }
    }
    for (k, v) in &provider.default_headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            map.insert(name, value);
        }
    }
    map
}

fn build_body(slot: &ModelSlot, messages: &[ChatMessage], stream: bool, json_mode: bool) -> Value {
    let mut body = json!({
        "model": slot.model,
        "messages": messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
        "temperature": slot.temperature,
        "top_p": slot.top_p,
        "stream": stream,
    });
    if let Some(max) = slot.max_tokens {
        body["max_tokens"] = json!(max);
    }
    if stream {
        // 让流式响应带上 usage（OpenAI 兼容端支持时才有）
        body["stream_options"] = json!({ "include_usage": true });
    }
    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    if let Some(obj) = body.as_object_mut() {
        for (k, v) in &slot.extra_body {
            obj.insert(k.clone(), v.clone());
        }
    }
    body
}

/// 挑出本次调用要用的槽位。
fn pick_slot(settings: &LlmSettings, req: &ChatRequest) -> AppResult<(ProviderConfig, ModelSlot)> {
    let slot = if let Some(o) = &req.overrides {
        o.clone()
    } else if req.use_arbiter {
        settings
            .arbiter
            .clone()
            .ok_or_else(|| AppError::NotConfigured("裁决模型（可在设置里留空）".into()))?
    } else {
        settings.narrator.clone()
    };
    if slot.model.trim().is_empty() {
        return Err(AppError::NotConfigured("模型名未填写".into()));
    }
    if settings.provider.base_url.trim().is_empty() {
        return Err(AppError::NotConfigured("接口地址（base URL）未填写".into()));
    }
    Ok((settings.provider.clone(), slot))
}

/* ============================ 流式 ============================ */

/// 统一的对话请求：**一律用流式**。
///
/// 为什么即使是"要 JSON"也走流式：部分中转/网关（实测 opencodego 渠道）对
/// `stream:false` 会一直挂着不返回，而流式能正常。流式对 OpenAI 兼容端点通用，
/// 因此把非流式路径删掉，改为一律流式累积——少一条分支，少一类线上故障。
async fn chat_fetch(
    provider: &ProviderConfig,
    slot: &ModelSlot,
    key: &str,
    messages: &[ChatMessage],
    json_mode: bool,
    timeout_secs: u64,
    mut on_delta: Option<&mut (dyn FnMut(&str) + Send)>,
) -> AppResult<String> {
    let body = build_body(slot, messages, true, json_mode);
    let http = client(timeout_secs)?;
    let resp = http
        .post(provider.chat_url())
        .headers(headers(provider, key))
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(api_error(status.as_u16(), &text));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(AppError::from)?;
        buf.extend_from_slice(&chunk);

        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&raw).trim().to_string();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = payload.trim();
            if payload == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            if let Some(text) = delta_text(&value) {
                full.push_str(&text);
                if let Some(cb) = on_delta.as_deref_mut() {
                    cb(&text);
                }
            }
            if let Some(u) = value.get("usage").filter(|u| !u.is_null()) {
                let _ = u; // usage 目前只透传给 UI 的成本估算，尚未落库
            }
        }
    }

    Ok(full)
}

/// 流式叙事：边收边把增量推给界面。
pub async fn chat_stream(
    app: AppHandle,
    secrets: SecretsState,
    llm: LlmState,
    req: ChatRequest,
) -> AppResult<()> {
    let channel = format!("api://{}", req.request_id);
    let settings = llm.snapshot();
    let (provider, slot) = pick_slot(&settings, &req)?;
    let key = secrets.snapshot().llm_api_key;

    if provider.requires_api_key && key.is_empty() {
        return Err(AppError::NotConfigured(
            "API Key（在「模型配置」里填写）".into(),
        ));
    }

    let app_for_cb = app.clone();
    let channel_for_cb = channel.clone();
    let mut cb = move |text: &str| {
        emit(
            &app_for_cb,
            &channel_for_cb,
            "delta",
            json!({ "text": text }),
        );
    };
    let result = chat_fetch(
        &provider,
        &slot,
        &key,
        &req.messages,
        req.json_mode,
        settings.timeout_secs,
        Some(&mut cb),
    )
    .await;

    match result {
        Ok(text) => {
            emit(&app, &channel, "done", json!({ "text": text }));
            Ok(())
        }
        Err(e) => {
            emit(&app, &channel, "error", json!({ "message": e.to_string() }));
            Err(e)
        }
    }
}

/// 非流式语义的"裁决"调用：内部同样走流式累积，然后把整段当 JSON 解析。
pub async fn complete_json(
    _app: AppHandle,
    secrets: SecretsState,
    llm: LlmState,
    req: ChatRequest,
) -> AppResult<Value> {
    let settings = llm.snapshot();
    let (provider, slot) = pick_slot(&settings, &req)?;
    let key = secrets.snapshot().llm_api_key;
    if provider.requires_api_key && key.is_empty() {
        return Err(AppError::NotConfigured(
            "API Key（在「模型配置」里填写）".into(),
        ));
    }

    let text = chat_fetch(
        &provider,
        &slot,
        &key,
        &req.messages,
        req.json_mode,
        settings.timeout_secs,
        None,
    )
    .await?;

    // 有些端点会把 JSON 包在 ```json 围栏里，这里做一次容错剥离
    let cleaned = strip_code_fence(&text);
    serde_json::from_str::<Value>(&cleaned).map_err(|e| {
        AppError::Data(format!(
            "模型未返回合法 JSON：{}（原文前 200 字：{}）",
            e,
            cleaned.chars().take(200).collect::<String>()
        ))
    })
}

/// 取增量正文（OpenAI 兼容：choices[0].delta.content）。
fn delta_text(value: &Value) -> Option<String> {
    value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 剥掉 ```json 围栏：部分端点会把 JSON 包进代码块。
fn strip_code_fence(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```json") {
        return rest.trim_end_matches("```").trim().to_string();
    }
    if let Some(rest) = t.strip_prefix("```") {
        return rest.trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

/// 往界面推一个事件。频道名形如 `api://<requestId>`。
fn emit(app: &AppHandle, channel: &str, kind: &str, data: Value) {
    let _ = app.emit(channel, json!({ "type": kind, "data": data }));
}

#[tauri::command]
pub fn llm_settings_get(
    llm: tauri::State<'_, LlmState>,
    secrets: tauri::State<'_, SecretsState>,
) -> Value {
    json!({
        "settings": llm.snapshot(),
        "secrets": secrets.snapshot().masked(),
    })
}

#[tauri::command]
pub fn llm_settings_set(
    app: AppHandle,
    llm: tauri::State<'_, LlmState>,
    settings: LlmSettings,
) -> AppResult<()> {
    {
        let mut guard = llm
            .inner
            .lock()
            .map_err(|_| AppError::Other("模型配置被占用".into()))?;
        *guard = settings;
    }
    llm.persist(&app)
}

/// Key 单独入口：前端留空 = 不改动；显式清空走 `llm_key_clear`。
#[tauri::command]
pub fn llm_key_set(
    app: AppHandle,
    secrets: tauri::State<'_, SecretsState>,
    api_key: String,
) -> AppResult<()> {
    secrets.update(Some(api_key), None)?;
    secrets.persist(&app)
}

#[tauri::command]
pub fn llm_key_clear(app: AppHandle, secrets: tauri::State<'_, SecretsState>) -> AppResult<()> {
    secrets.clear_llm_key()?;
    secrets.persist(&app)
}

#[tauri::command]
pub async fn llm_models(
    secrets: tauri::State<'_, SecretsState>,
    llm: tauri::State<'_, LlmState>,
) -> AppResult<Vec<String>> {
    // 先快照再 await，绝不跨 await 持锁
    let key = secrets.snapshot().llm_api_key;
    let settings = llm.snapshot();
    list_models_snapshot(settings, key).await
}

async fn list_models_snapshot(settings: LlmSettings, key: String) -> AppResult<Vec<String>> {
    let provider = settings.provider;
    if provider.base_url.trim().is_empty() {
        return Err(AppError::NotConfigured("接口地址（base URL）未填写".into()));
    }
    let http = client(REQUEST_TIMEOUT_SECS)?;
    let resp = http
        .get(provider.path("/models"))
        .headers(headers(&provider, &key))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(api_error(status.as_u16(), &text));
    }
    let value: Value = resp.json().await?;
    let mut names: Vec<String> = value
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn llm_chat_stream(
    app: AppHandle,
    secrets: tauri::State<'_, SecretsState>,
    llm: tauri::State<'_, LlmState>,
    req: ChatRequest,
) -> AppResult<()> {
    // 把状态克隆出来，避免跨 await 持有 State 借用
    let secrets_state = SecretsState {
        inner: Mutex::new(secrets.inner.lock().map(|g| g.clone()).unwrap_or_default()),
    };
    let llm_state = LlmState {
        inner: Mutex::new(llm.snapshot()),
    };
    chat_stream(app, secrets_state, llm_state, req).await
}

#[tauri::command]
pub async fn llm_complete_json(
    app: AppHandle,
    secrets: tauri::State<'_, SecretsState>,
    llm: tauri::State<'_, LlmState>,
    req: ChatRequest,
) -> AppResult<Value> {
    let secrets_state = SecretsState {
        inner: Mutex::new(secrets.inner.lock().map(|g| g.clone()).unwrap_or_default()),
    };
    let llm_state = LlmState {
        inner: Mutex::new(llm.snapshot()),
    };
    complete_json(app, secrets_state, llm_state, req).await
}

/* ============================ 真实渠道测试 ============================ */

#[cfg(test)]
mod live_tests {
    use super::*;

    /// 只有同时提供三个环境变量时才真的发请求，否则**静默跳过**。
    /// 这样 CI（无凭据）永远不会触发，密钥也永远不进仓库。
    fn creds() -> Option<(String, String, String)> {
        let base = std::env::var("DY_LLM_BASE_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let key = std::env::var("DY_LLM_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let model = std::env::var("DY_LLM_MODEL")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        Some((base, key, model))
    }

    fn provider_from_env(base: &str) -> ProviderConfig {
        let mut p = ProviderConfig::preset("custom");
        p.base_url = base.to_string();
        // 实测渠道要求会话头；测试里给它一个稳定值
        let mut h = HashMap::new();
        h.insert(
            "x-opencode-session".to_string(),
            "dyapp-rust-live-test".to_string(),
        );
        p.default_headers = h;
        p
    }

    #[tokio::test]
    async fn 真实渠道_流式叙事可用() {
        let Some((base, key, model)) = creds() else {
            eprintln!("跳过：未提供 DY_LLM_BASE_URL / DY_LLM_API_KEY / DY_LLM_MODEL");
            return;
        };
        let provider = provider_from_env(&base);
        let slot = ModelSlot {
            model,
            temperature: 0.8,
            top_p: 0.95,
            max_tokens: Some(128),
            extra_body: HashMap::new(),
        };
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: "只回复四个字：可以开始".into(),
        }];

        let mut chunks = 0usize;
        let mut cb = |_t: &str| chunks += 1;
        let text = chat_fetch(&provider, &slot, &key, &msgs, false, 120, Some(&mut cb))
            .await
            .expect("真实渠道调用失败");

        assert!(!text.trim().is_empty(), "返回内容为空");
        assert!(chunks > 0, "没有收到任何流式增量（说明走的不是流式路径）");
        println!(
            "
[Rust 真实调用] 增量 {chunks} 次，正文：{text}
"
        );
    }

    #[tokio::test]
    async fn 真实渠道_json模式可解析() {
        let Some((base, key, model)) = creds() else {
            eprintln!("跳过：未提供 DY_LLM_* 环境变量");
            return;
        };
        let provider = provider_from_env(&base);
        let slot = ModelSlot {
            model,
            temperature: 0.2,
            top_p: 0.9,
            max_tokens: Some(256),
            extra_body: HashMap::new(),
        };
        let msgs = vec![
            ChatMessage {
                role: "system".into(),
                content: "只输出一个 JSON 对象，不要解释、不要代码围栏。".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "按 {\"ok\":true,\"n\":3} 的形状返回，n 为 3。".into(),
            },
        ];

        let text = chat_fetch(&provider, &slot, &key, &msgs, true, 120, None)
            .await
            .expect("真实渠道调用失败");
        let cleaned = strip_code_fence(&text);
        let v: Value = serde_json::from_str(&cleaned).expect("流式累积的文本不是合法 JSON");
        assert_eq!(v.get("n").and_then(|x| x.as_i64()), Some(3));
        println!(
            "
[Rust 真实调用 · JSON 模式] {v}
"
        );
    }
}
