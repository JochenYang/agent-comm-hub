// Tauri 入口 + tray + 关闭主窗口隐藏。
// M1：hub_process + commands 接通。
// M2：sqlite_store 持久化 + mcp_client 透传 + herdr_client 11 个工具 + tray 增强（动态图标 + 菜单）。

mod commands;
mod herdr_client;
mod hub_process;
mod mcp_client;
mod sqlite_store;

use std::sync::Arc;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    Manager,
};

use commands::AppState;
use hub_process::{HubConfig, HubState};
use sqlite_store::Store;

/// 解码 PNG (RGB/RGBA) → (RGBA bytes, width, height)。
fn decode_png_rgba(bytes: &[u8]) -> (Vec<u8>, u32, u32) {
    let mut decoder = png::Decoder::new(bytes);
    decoder.set_transformations(png::Transformations::ALPHA | png::Transformations::EXPAND);
    let mut reader = decoder.read_info().expect("png read_info");
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("png next_frame");
    let rgba = if info.color_type == png::ColorType::Rgba {
        buf[..info.buffer_size()].to_vec()
    } else {
        // ALPHA | EXPAND 已经保证输出 RGBA；如果不是，说明 PNG 不规范
        buf[..info.buffer_size()].to_vec()
    };
    (rgba, info.width, info.height)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // SQLite 启动时初始化；失败则 fallback 到 in-memory。
    let store = match default_store_path() {
        Ok(path) => {
            // rusqlite 的 Connection::open 不会创建父目录 —— 目录不存在时 open 失败
            // 会静默 fallback 到 in-memory，所有数据不落盘、重启全丢（历史踩坑）。
            if let Some(parent) = path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    log::warn!("创建数据目录 {parent:?} 失败 ({e}); fallback to in-memory");
                }
            }
            Store::open(&path)
                .map(Arc::new)
                .unwrap_or_else(|e| {
                    log::warn!("SQLite open {path:?} 失败 ({e}); fallback to in-memory");
                    Arc::new(Store::open_in_memory().expect("in-memory store"))
                })
        }
        Err(e) => {
            log::warn!("无法解析 SQLite 路径 ({e}); fallback to in-memory");
            Arc::new(Store::open_in_memory().expect("in-memory store"))
        }
    };

    let app_state = AppState::new(HubConfig::default(), store);

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            // 托盘图标 = 品牌 logo（用户要求；状态变化通过 tooltip 文字表达，
            // 不再用绿/灰/红状态灯圆点）。
            let (rgba, w, h) = decode_png_rgba(include_bytes!("../icons/icon.png"));
            let icon_logo = Image::new_owned(rgba, w, h);

            // 构建 tray menu：Open / Restart / Quit
            let open = MenuItem::with_id(app, "open", "Open main window", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart hub", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &restart, &sep, &quit])?;

            // 初始图标 = 品牌 logo
            let tray: TrayIcon = TrayIconBuilder::with_id("main-tray")
                .icon(icon_logo.clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("agent-comm-hub")
                .build(app)?;

            // 主窗口默认 visible:false，前端加载完成后由 `app_ready` 触发 show。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }

            // 注入 tray setter 给 HubProcess：emit_state 时同步更新 tooltip 状态文字
            // （图标保持 logo 不变）。
            let state = app.state::<AppState>();
            let hub_clone = state.hub.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                hub_clone
                    .attach_tray_setter(move |s: HubState| {
                        let label = match s {
                            HubState::Running | HubState::Starting => "agent-comm-hub · running",
                            HubState::Stopped => "agent-comm-hub · stopped",
                            HubState::Stopping | HubState::Failed => "agent-comm-hub · error",
                        };
                        if let Some(t) = app_handle.tray_by_id("main-tray") {
                            let _ = t.set_tooltip(Some(label));
                        }
                    })
                    .await;
            });

            // 保存 tray handle 到 AppState 以便 commands 也能切图标。
            // 注意：TrayIcon 不是 Send/Sync，存到 Mutex<Option<TrayIcon>>；commands 通过 AppState 拿。
            // 当前 commands 不直接需要，注释保留未来扩展点。

            // 保留 tray 在 app handle 里，后续可通过 tray_by_id 取。
            drop(tray);

            Ok(())
        })
        // 关闭行为由前端接管（onCloseRequested → 弹三选一 modal）：
        // 最小化到托盘 = window.hide()，退出 = quit_app 命令，取消 = 保持。
        // Rust 侧不再自动 hide（避免与前端 modal 双重拦截冲突）。
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "open" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "restart" => {
                    let state = app.state::<AppState>();
                    let hub = state.hub.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = hub.restart().await;
                    });
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::hub_start,
            commands::hub_stop,
            commands::hub_restart,
            commands::hub_status,
            commands::hub_get_logs,
            commands::app_ready,
            commands::quit_app,
            commands::service_install,
            commands::service_uninstall,
            commands::hub_cli_version,
            commands::hub_cli_check_update,
            commands::hub_cli_update,
            commands::hub_cli_install,
            commands::hub_cli_setup,
            commands::bridge_peers,
            commands::bridge_status,
            commands::bridge_wait,
            commands::bridge_history,
            commands::history_local,
            commands::bridge_chat,
            commands::bridge_task,
            commands::bridge_ack,
            commands::config_get,
            commands::config_set,
            commands::hub_restart_with_saved_config,
            commands::unread_list,
            commands::unread_clear,
            commands::herdr_is_available,
            commands::herdr_agent_list,
            commands::herdr_agent_status,
            commands::herdr_agent_prompt,
            commands::herdr_agent_wait,
            commands::herdr_agent_read,
            commands::herdr_agent_keys,
            commands::herdr_pane_list,
            commands::herdr_pane_send_text,
            commands::herdr_pane_send_keys,
            commands::herdr_pane_read,
            commands::herdr_pane_wait_for_output,
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent-comm-hub-app");
}

/// SQLite 文件路径：app_data_dir/store.sqlite。
fn default_store_path() -> Result<std::path::PathBuf, String> {
    let dir = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(std::path::PathBuf::from))
        .ok_or_else(|| "no APPDATA / HOME".to_string())?;
    Ok(dir.join("agent-comm-hub-app").join("store.sqlite"))
}