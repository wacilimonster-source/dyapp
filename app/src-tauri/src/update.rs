//! 应用内更新：把 Release 附件下载到本机，再交给系统安装器。
//!
//! 为什么要在 Rust 侧做：WebView 里的 `<a target="_blank">` 在壳内根本不响应，
//! 用户点「下载 APK」只会停在发布页。
//!
//! 边界（这条链路下载完会**直接执行**，所以不能把 URL 当自由参数）：
//! - 只允许 https + GitHub 的下载域名，重定向之后还要再查一次域名；
//! - 文件名只取 URL 最后一段并剥掉所有路径字符，扩展名必须在白名单里；
//! - 安装前要求文件确实落在本应用的暂存目录内（防被指到任意路径去执行）。

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::error::{api_error, AppError, AppResult};
#[cfg(not(target_os = "android"))]
use crate::paths::{config_dir, ensure_dir};

/// GitHub 释放附件实际会跳到的域名（不同代际各有一个，都放行会扩大面，只列在用这几个）。
const ALLOWED_HOSTS: [&str; 4] = [
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// 允许被下载并执行的扩展名。
const ALLOWED_EXT: [&str; 2] = ["apk", "exe"];

const UA: &str = "dyapp-updater";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    /// 进度事件通道后缀；前端用同一个 requestId `listen('api://'+id)`。
    #[serde(default)]
    pub request_id: String,
}

fn host_allowed(host: &str) -> bool {
    ALLOWED_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// 校验并解析下载地址。
fn check_url(raw: &str) -> AppResult<reqwest::Url> {
    let url =
        reqwest::Url::parse(raw).map_err(|e| AppError::Data(format!("下载地址不合法：{e}")))?;
    if url.scheme() != "https" {
        return Err(AppError::Data("只允许 https 的下载地址".into()));
    }
    let host = url.host_str().unwrap_or("");
    if !host_allowed(host) {
        return Err(AppError::Data(format!("下载地址不在允许的域名内：{host}")));
    }
    Ok(url)
}

/// 从 URL 取一个绝对安全的文件名：只留最后一段，字符集收窄，扩展名白名单。
fn safe_filename(url: &reqwest::Url) -> AppResult<String> {
    let last = url
        .path_segments()
        .and_then(|mut s| s.by_ref().last())
        .unwrap_or("");
    let clean: String = last
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean = clean.trim_matches('.').trim_start_matches('.').to_string();
    if clean.is_empty() {
        return Err(AppError::Data("下载地址里没有可用的文件名".into()));
    }
    let ext = Path::new(&clean)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return Err(AppError::Data(format!(
            "只允许安装 {}，这个地址指向的是 .{ext}",
            ALLOWED_EXT.join(" / ")
        )));
    }
    Ok(clean)
}

/// 下载与安装都只认这个目录。
#[cfg(target_os = "android")]
fn staging_dir(_app: &AppHandle) -> AppResult<PathBuf> {
    // 安卓要落在 FileProvider 覆盖得到的根里，所以走 `getCacheDir()`
    // （`res/xml/file_paths.xml` 的 `<cache-path path="."/>` 正好覆盖它）。
    android::cache_dir()
}

#[cfg(not(target_os = "android"))]
fn staging_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = config_dir(app)?.join("updates");
    ensure_dir(&dir)?;
    Ok(dir)
}

fn emit_progress(app: &AppHandle, request_id: &str, received: u64, total: Option<u64>) {
    if request_id.is_empty() {
        return;
    }
    let _ = app.emit(
        &format!("api://{request_id}"),
        json!({
            "type": "progress",
            "data": { "received": received, "total": total }
        }),
    );
}

#[tauri::command]
pub async fn update_download(app: AppHandle, req: DownloadRequest) -> AppResult<Value> {
    let url = check_url(&req.url)?;
    let name = safe_filename(&url)?;
    let dir = staging_dir(&app)?;
    let path = dir.join(&name);
    // 同名残骸先删掉：否则上次断在半路的文件会被当成"已经下好了"
    if path.exists() {
        std::fs::remove_file(&path)?;
    }

    let client = reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .map_err(|e| AppError::Http(e.to_string()))?;
    let resp = client.get(url.clone()).send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(api_error(status.as_u16(), &body));
    }
    // 重定向之后仍然要在 GitHub 域名内，否则等于把"下载并执行"交给第三方
    let final_host = resp.url().host_str().unwrap_or("").to_string();
    if !host_allowed(&final_host) {
        return Err(AppError::Data(format!(
            "下载被重定向到站外域名：{final_host}"
        )));
    }

    let total = resp.content_length();
    let mut file = std::fs::File::create(&path)?;
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await? {
        file.write_all(&chunk)?;
        received += chunk.len() as u64;
        if last_emit.elapsed().as_millis() >= 200 {
            last_emit = std::time::Instant::now();
            emit_progress(&app, &req.request_id, received, total);
        }
    }
    file.flush()?;
    drop(file);

    if let Some(expect) = total {
        if expect != received {
            let _ = std::fs::remove_file(&path);
            return Err(AppError::Io(format!(
                "下载不完整：期望 {expect} 字节，实到 {received} 字节"
            )));
        }
    }
    emit_progress(&app, &req.request_id, received, total);
    Ok(json!({
        "path": path.to_string_lossy(),
        "name": name,
        "size": received,
    }))
}

#[tauri::command]
pub fn update_install(app: AppHandle, path: String) -> AppResult<Value> {
    let dir = staging_dir(&app)?;
    let target = PathBuf::from(&path);
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return Err(AppError::Data("只允许安装 .apk / .exe".into()));
    }
    // 只装自己刚下下来的那个文件：路径必须落在暂存目录内
    let canon_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let canon = target
        .canonicalize()
        .map_err(|_| AppError::NotConfigured("安装包不存在，请重新下载".into()))?;
    if !canon.starts_with(&canon_dir) {
        return Err(AppError::Data("拒绝安装非本应用下载的文件".into()));
    }
    install(&canon)?;
    Ok(json!({ "path": canon.to_string_lossy() }))
}

#[cfg(target_os = "windows")]
fn install(path: &Path) -> AppResult<()> {
    std::process::Command::new(path)
        .spawn()
        .map_err(|e| AppError::Io(format!("启动安装包失败：{e}")))?;
    Ok(())
}

#[cfg(target_os = "android")]
fn install(path: &Path) -> AppResult<()> {
    android::launch_installer(path)
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
fn install(_path: &Path) -> AppResult<()> {
    Err(AppError::Other(
        "这个平台不支持应用内安装，请手动运行下载好的文件".into(),
    ))
}

/// 安卓侧：拿 Activity Context 走 FileProvider + ACTION_VIEW 拉起系统安装器。
///
/// Tauri 2.12 没有把 Context 暴露给应用代码（`run_on_android_context` 在 sealed 模块里），
/// 所以用 `ndk-context` 直接取 —— 它返回的 context 通常就是当前 Activity，
/// 因此不需要 `FLAG_ACTIVITY_NEW_TASK` 也能起，但加上更稳。
#[cfg(target_os = "android")]
mod android {
    use std::path::PathBuf;

    use jni::objects::{JObject, JValue};
    use jni::sys::jint;
    use jni::{JNIEnv, JavaVM};

    use crate::error::{AppError, AppResult};

    const FLAG_GRANT_READ_URI_PERMISSION: jint = 0x0000_0001;
    const FLAG_ACTIVITY_NEW_TASK: jint = 0x1000_0000;
    const SUBDIR: &str = "dyapp-updates";

    fn jni_err(stage: &str, e: &jni::errors::Error) -> AppError {
        AppError::Other(format!("安卓调用失败（{stage}）：{e}"))
    }

    fn cache_dir_inner(env: &mut JNIEnv, context: &JObject) -> AppResult<PathBuf> {
        let file = env
            .call_method(context, "getCacheDir", "()Ljava/io/File;", &[])
            .and_then(|v| v.l())
            .map_err(|e| jni_err("getCacheDir", &e))?;
        let path_str = env
            .call_method(&file, "getAbsolutePath", "()Ljava/lang/String;", &[])
            .and_then(|v| v.l())
            .map_err(|e| jni_err("File.getAbsolutePath", &e))?;
        let s = env
            .get_string((&path_str).into())
            .map_err(|e| jni_err("读缓存目录路径", &e))?;
        Ok(PathBuf::from(s.to_string_lossy().as_ref()).join(SUBDIR))
    }

    /// 下载与安装共用的暂存目录：`getCacheDir()/dyapp-updates`。
    pub fn cache_dir() -> AppResult<PathBuf> {
        let actx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(actx.vm() as *mut _) }
            .map_err(|e| jni_err("取 JavaVM", &e))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| jni_err("附着线程", &e))?;
        let context = unsafe { JObject::from_raw(actx.context() as *mut _) };
        let dir = cache_dir_inner(&mut env, &context)?;
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    pub fn launch_installer(path: &std::path::Path) -> AppResult<()> {
        let actx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(actx.vm() as *mut _) }
            .map_err(|e| jni_err("取 JavaVM", &e))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| jni_err("附着线程", &e))?;
        let context = unsafe { JObject::from_raw(actx.context() as *mut _) };

        let authority = {
            let pkg = env
                .call_method(&context, "getPackageName", "()Ljava/lang/String;", &[])
                .and_then(|v| v.l())
                .map_err(|e| jni_err("getPackageName", &e))?;
            let s = env
                .get_string((&pkg).into())
                .map_err(|e| jni_err("读包名", &e))?;
            env.new_string(format!("{}.fileprovider", s.to_string_lossy()))
                .map_err(|e| jni_err("构造 authority", &e))?
        };
        let file = {
            let p = env
                .new_string(path.to_string_lossy().to_string())
                .map_err(|e| jni_err("构造路径", &e))?;
            env.new_object(
                "java/io/File",
                "(Ljava/lang/String;)V",
                &[JValue::Object(&p)],
            )
            .map_err(|e| jni_err("new File", &e))?
        };
        let uri = env
            .call_static_method(
                "androidx/core/content/FileProvider",
                "getUriForFile",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
                &[
                    JValue::Object(&context),
                    JValue::Object(&authority),
                    JValue::Object(&file),
                ],
            )
            .and_then(|v| v.l())
            .map_err(|e| jni_err("FileProvider.getUriForFile", &e))?;
        let mime = env
            .new_string("application/vnd.android.package-archive")
            .map_err(|e| jni_err("构造 MIME", &e))?;
        let action = env
            .new_string("android.intent.action.VIEW")
            .map_err(|e| jni_err("构造 action", &e))?;
        let intent = env
            .new_object(
                "android/content/Intent",
                "(Ljava/lang/String;)V",
                &[JValue::Object(&action)],
            )
            .map_err(|e| jni_err("new Intent", &e))?;
        env.call_method(
            &intent,
            "setDataAndType",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&uri), JValue::Object(&mime)],
        )
        .map_err(|e| jni_err("setDataAndType", &e))?;
        let flags = FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK;
        env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(flags)],
        )
        .map_err(|e| jni_err("addFlags", &e))?;
        env.call_method(
            &context,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )
        .map_err(|e| jni_err("startActivity", &e))?;
        throw_check(&mut env)?;
        Ok(())
    }

    /// JNI 不抛 Rust 异常：Java 侧留下的挂起异常要自己取出来，否则只看到一个"成功"的失败。
    fn throw_check(env: &mut JNIEnv) -> AppResult<()> {
        if !env
            .exception_check()
            .map_err(|e| jni_err("exception_check", &e))?
        {
            return Ok(());
        }
        let mut desc = "<挂起的 Java 异常>".to_string();
        if let Ok(throwable) = env.exception_occurred() {
            if let Ok(s) = env
                .call_method(&throwable, "toString", "()Ljava/lang/String;", &[])
                .and_then(|v| v.l())
            {
                if let Ok(cs) = env.get_string((&s).into()) {
                    desc = cs.to_string_lossy().into_owned();
                }
            }
        }
        let _ = env.exception_clear();
        Err(AppError::Other(format!("安卓抛出异常：{desc}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> AppResult<()> {
        check_url(s).and_then(|u| safe_filename(&u).map(|_| ()))
    }

    #[test]
    fn 只放行_github_的_https_下载地址() {
        assert!(check_url("https://github.com/a/b/releases/download/v1/x.apk").is_ok());
        assert!(check_url("https://objects.githubusercontent.com/x.apk").is_ok());
        assert!(
            url("http://github.com/a/b/releases/download/v1/x.apk").is_err(),
            "明文 http 必须拒"
        );
        assert!(url("https://evil.com/x.apk").is_err(), "站外域名必须拒");
        assert!(
            url("https://evil.com/github.com/x.apk").is_err(),
            "路径里藏域名不算数"
        );
        assert!(
            url("https://github.com.evil.test/x.apk").is_err(),
            "后缀伪装必须拒"
        );
    }

    #[test]
    fn 文件名只取最后一段且扩展名要在白名单() {
        let u = reqwest::Url::parse(
            "https://github.com/o/r/releases/download/v1/dyapp-1.0.0-windows-x64-setup.exe",
        )
        .unwrap();
        assert_eq!(
            safe_filename(&u).unwrap(),
            "dyapp-1.0.0-windows-x64-setup.exe"
        );

        let u = reqwest::Url::parse(
            "https://github.com/o/r/releases/download/v1/dyapp-1.0.0-universal.apk",
        )
        .unwrap();
        assert_eq!(safe_filename(&u).unwrap(), "dyapp-1.0.0-universal.apk");

        // 转义出来的分隔符不会还原成路径：只会被换成下划线
        let u =
            reqwest::Url::parse("https://github.com/o/r/releases/download/v1/..%2F..%2Fevil.exe")
                .unwrap();
        let n = safe_filename(&u).unwrap();
        assert!(!n.contains('/') && !n.contains('\\'), "不能有分隔符：{n}");
        assert!(n.ends_with(".exe"));

        let u = reqwest::Url::parse("https://github.com/o/r/releases/download/v1/tool.sh").unwrap();
        assert!(safe_filename(&u).is_err(), ".sh 不在白名单");

        let u = reqwest::Url::parse("https://github.com/o/r/releases/download/v1/").unwrap();
        assert!(safe_filename(&u).is_err(), "没有文件名");
    }

    #[test]
    fn 文件名里的路径与控制字符被剥掉() {
        let u = reqwest::Url::parse("https://github.com/o/r/releases/download/v1/%2e%2e%2fwin.exe")
            .unwrap();
        let n = safe_filename(&u).unwrap();
        assert!(!n.contains('/') && !n.contains('\\'), "不能有分隔符：{n}");
        assert!(!n.starts_with('.'), "不能以点开头（会被当隐藏文件）：{n}");
        assert!(n.ends_with(".exe"));
    }
}
