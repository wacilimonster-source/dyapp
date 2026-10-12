mod crypto;
mod error;
mod llm;
mod paths;
mod preset;
mod save;
mod secrets;
mod sync;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(secrets::SecretsState::load(&handle)?);
            app.manage(llm::LlmState::load(&handle)?);
            app.manage(sync::SyncState::load(&handle)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 模型配置（Key 只存本地）
            llm::llm_settings_get,
            llm::llm_settings_set,
            llm::llm_key_set,
            llm::llm_key_clear,
            llm::llm_models,
            llm::llm_chat_stream,
            llm::llm_complete_json,
            // 存档
            save::save_list,
            save::save_read,
            save::save_write,
            save::save_delete,
            save::save_export,
            save::save_import,
            // 预设（ST Chat Completion 预设，原样存本机）
            preset::preset_list,
            preset::preset_read,
            preset::preset_write,
            preset::preset_delete,
            preset::preset_rename,
            preset::preset_import,
            preset::preset_dir,
            // 多端进度同步（GitHub）
            sync::sync_config_get,
            sync::sync_config_set,
            sync::sync_token_set,
            sync::sync_token_clear,
            sync::sync_local_saves,
            sync::sync_remote_saves,
            sync::sync_push,
            sync::sync_pull,
            sync::sync_push_all,
        ])
        .run(tauri::generate_context!())
        .expect("《道渊》启动失败");
}
