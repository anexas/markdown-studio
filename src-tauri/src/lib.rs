mod commands;
mod menu;

use tauri::{Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

fn window_state_flags() -> StateFlags {
    // Restore geometry, but never the visibility flag: the window is shown explicitly
    // once the menu is attached, which avoids a white flash on startup.
    StateFlags::all() & !StateFlags::VISIBLE
}

pub fn run() {
    tauri::Builder::default()
        // The single-instance plugin must be registered first so a second launch is
        // routed into the running window instead of starting a new process.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            let _ = app.emit("single-instance-open", args);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_document,
            commands::write_document,
            commands::list_folder,
            commands::read_image,
            commands::open_external,
            commands::initial_args,
            commands::app_info,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = menu::build(&handle)?;
            app.set_menu(menu)?;

            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                let _ = window.set_focus();
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .run(tauri::generate_context!())
        .expect("error while running Markdown Studio");
}
