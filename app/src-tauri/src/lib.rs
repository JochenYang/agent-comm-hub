// Tauri entry point + tray + hide main window on close.
// M1: hub_process + commands wired up.
// M2: sqlite_store persistence + mcp_client passthrough + herdr_client's 11 tools + tray enhancements (dynamic icon + menu).

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

/// Decode PNG (RGB/RGBA) → (RGBA bytes, width, height).
fn decode_png_rgba(bytes: &[u8]) -> (Vec<u8>, u32, u32) {
    let mut decoder = png::Decoder::new(bytes);
    decoder.set_transformations(png::Transformations::ALPHA | png::Transformations::EXPAND);
    let mut reader = decoder.read_info().expect("png read_info");
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("png next_frame");
    let rgba = if info.color_type == png::ColorType::Rgba {
        buf[..info.buffer_size()].to_vec()
    } else {
        // ALPHA | EXPAND already guarantees RGBA output; if not, the PNG is malformed
        buf[..info.buffer_size()].to_vec()
    };
    (rgba, info.width, info.height)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize SQLite at startup; on failure, fall back to in-memory.
    let store = match default_store_path() {
        Ok(path) => {
            // rusqlite's Connection::open does not create the parent directory — when it is
            // missing, open fails and silently falls back to in-memory, so no data is ever
            // persisted and everything is lost on restart (previously tripped up on this).
            if let Some(parent) = path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    log::warn!("failed to create data dir {parent:?} ({e}); fallback to in-memory");
                }
            }
            Store::open(&path)
                .map(Arc::new)
                .unwrap_or_else(|e| {
                    log::warn!("SQLite open of {path:?} failed ({e}); fallback to in-memory");
                    Arc::new(Store::open_in_memory().expect("in-memory store"))
                })
        }
        Err(e) => {
            log::warn!("cannot resolve SQLite path ({e}); fallback to in-memory");
            Arc::new(Store::open_in_memory().expect("in-memory store"))
        }
    };

    // Apply the hub settings saved last time (SQLite config table) at startup — previously
    // the hub was launched with only HubConfig::default() and the saved port etc. never
    // took effect after a restart.
    let mut hub_config = HubConfig::default();
    commands::apply_saved_config(&mut hub_config, &store);
    let app_state = AppState::new(hub_config, store);

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            // Tray icon = brand logo (as the user requested; state changes are conveyed via the
            // tooltip text rather than green/grey/red status indicator dots).
            let (rgba, w, h) = decode_png_rgba(include_bytes!("../icons/icon.png"));
            let icon_logo = Image::new_owned(rgba, w, h);

            // Build tray menu: Open / Restart / Quit
            let open = MenuItem::with_id(app, "open", "Open main window", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart hub", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &restart, &sep, &quit])?;

            // Initial icon = brand logo
            let tray: TrayIcon = TrayIconBuilder::with_id("main-tray")
                .icon(icon_logo.clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("agent-comm-hub")
                .build(app)?;

            // Main window is visible:false by default; the frontend triggers `show` via `app_ready`.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }

            // Inject a tray setter into HubProcess: on emit_state, update the tooltip state text
            // (the icon stays the logo).
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

            // Save the tray handle into AppState so commands can swap icons too.
            // Note: TrayIcon is not Send/Sync, so it would live in a Mutex<Option<TrayIcon>>;
            // commands fetch it through AppState.
            // Commands don't need it directly right now; kept as a comment as a future extension point.

            // Keep the tray on the app handle; fetch it later via tray_by_id.
            drop(tray);

            Ok(())
        })
        // Close behavior is handled by the frontend (onCloseRequested → shows a three-option modal):
        // minimize to tray = window.hide(), quit = quit_app command, cancel = keep as is.
        // The Rust side no longer auto-hides (to avoid double interception conflicting with the frontend modal).
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
            commands::bridge_rename,
            commands::bridge_unregister_peer,
            commands::roster_list,
            commands::roster_forget,
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

/// SQLite file path: app_data_dir/store.sqlite.
fn default_store_path() -> Result<std::path::PathBuf, String> {
    let dir = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(std::path::PathBuf::from))
        .ok_or_else(|| "no APPDATA / HOME".to_string())?;
    Ok(dir.join("agent-comm-hub-app").join("store.sqlite"))
}