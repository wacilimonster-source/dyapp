// Windows 发行版不弹控制台窗口；调试构建保留，方便看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dyapp_lib::run()
}
