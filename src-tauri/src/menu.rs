use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// Builds the native Win32 menu bar. Menu events are forwarded to the frontend as
/// string ids over the `menu` event, so all behaviour lives in one place.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new = MenuItem::with_id(app, "new", "&New", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "open", "&Open...", true, Some("CmdOrCtrl+O"))?;
    let open_folder = MenuItem::with_id(app, "open-folder", "Open &Folder...", true, Some("CmdOrCtrl+Shift+O"))?;
    let save = MenuItem::with_id(app, "save", "&Save", true, Some("CmdOrCtrl+S"))?;
    let save_as = MenuItem::with_id(app, "save-as", "Save &As...", true, Some("CmdOrCtrl+Shift+S"))?;
    let close = MenuItem::with_id(app, "close", "&Close Tab", true, Some("CmdOrCtrl+W"))?;
    let print = MenuItem::with_id(app, "print", "&Print / Export PDF...", true, Some("CmdOrCtrl+P"))?;
    let exit = MenuItem::with_id(app, "exit", "E&xit", true, None::<&str>)?;

    let file = Submenu::new(app, "&File", true)?;
    file.append(&new)?;
    file.append(&open)?;
    file.append(&open_folder)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;
    file.append(&save)?;
    file.append(&save_as)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;
    file.append(&close)?;
    file.append(&print)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;
    file.append(&exit)?;

    let find = MenuItem::with_id(app, "find", "&Find...", true, Some("CmdOrCtrl+F"))?;
    let bold = MenuItem::with_id(app, "bold", "&Bold", true, Some("CmdOrCtrl+B"))?;
    let italic = MenuItem::with_id(app, "italic", "&Italic", true, Some("CmdOrCtrl+I"))?;
    let link = MenuItem::with_id(app, "link", "&Link", true, Some("CmdOrCtrl+K"))?;
    let h1 = MenuItem::with_id(app, "h1", "Heading &1", true, Some("CmdOrCtrl+Alt+1"))?;
    let h2 = MenuItem::with_id(app, "h2", "Heading &2", true, Some("CmdOrCtrl+Alt+2"))?;
    let h3 = MenuItem::with_id(app, "h3", "Heading &3", true, Some("CmdOrCtrl+Alt+3"))?;
    let h4 = MenuItem::with_id(app, "h4", "Heading &4", true, Some("CmdOrCtrl+Alt+4"))?;
    let code_block = MenuItem::with_id(app, "code-block", "&Code block", true, Some("CmdOrCtrl+Alt+C"))?;
    let table = MenuItem::with_id(app, "table", "&Table", true, Some("CmdOrCtrl+Alt+T"))?;

    let edit = Submenu::new(app, "&Edit", true)?;
    edit.append(&PredefinedMenuItem::undo(app, None)?)?;
    edit.append(&PredefinedMenuItem::redo(app, None)?)?;
    edit.append(&PredefinedMenuItem::separator(app)?)?;
    edit.append(&PredefinedMenuItem::cut(app, None)?)?;
    edit.append(&PredefinedMenuItem::copy(app, None)?)?;
    edit.append(&PredefinedMenuItem::paste(app, None)?)?;
    edit.append(&PredefinedMenuItem::select_all(app, None)?)?;
    edit.append(&PredefinedMenuItem::separator(app)?)?;
    edit.append(&find)?;
    edit.append(&PredefinedMenuItem::separator(app)?)?;
    edit.append(&bold)?;
    edit.append(&italic)?;
    edit.append(&link)?;
    edit.append(&PredefinedMenuItem::separator(app)?)?;
    edit.append(&h1)?;
    edit.append(&h2)?;
    edit.append(&h3)?;
    edit.append(&h4)?;
    edit.append(&PredefinedMenuItem::separator(app)?)?;
    edit.append(&code_block)?;
    edit.append(&table)?;

    let raw = MenuItem::with_id(app, "mode-raw", "&Raw", true, Some("CmdOrCtrl+1"))?;
    let split = MenuItem::with_id(app, "mode-split", "&Split", true, Some("CmdOrCtrl+2"))?;
    let preview = MenuItem::with_id(app, "mode-preview", "&Preview", true, Some("CmdOrCtrl+3"))?;
    let cycle = MenuItem::with_id(app, "mode-cycle", "Cycle view mode", true, Some("CmdOrCtrl+E"))?;
    let toggle_sidebar = MenuItem::with_id(app, "toggle-sidebar", "Folder &sidebar", true, Some("CmdOrCtrl+Shift+B"))?;
    let reload_folders = MenuItem::with_id(app, "reload-folders", "&Reload folder tree", true, Some("CmdOrCtrl+Shift+F5"))?;
    let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom &In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom &Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(app, "zoom-reset", "&Reset Zoom", true, Some("CmdOrCtrl+0"))?;

    let view = Submenu::new(app, "&View", true)?;
    view.append(&raw)?;
    view.append(&split)?;
    view.append(&preview)?;
    view.append(&PredefinedMenuItem::separator(app)?)?;
    view.append(&cycle)?;
    view.append(&PredefinedMenuItem::separator(app)?)?;
    view.append(&toggle_sidebar)?;
    view.append(&reload_folders)?;
    view.append(&PredefinedMenuItem::separator(app)?)?;
    view.append(&zoom_in)?;
    view.append(&zoom_out)?;
    view.append(&zoom_reset)?;

    let shortcuts = MenuItem::with_id(app, "shortcuts", "&Keyboard shortcuts", true, Some("F1"))?;
    let about = MenuItem::with_id(app, "about", "&About Markdown Studio", true, None::<&str>)?;

    let help = Submenu::new(app, "&Help", true)?;
    help.append(&shortcuts)?;
    help.append(&PredefinedMenuItem::separator(app)?)?;
    help.append(&about)?;

    let menu = Menu::new(app)?;
    menu.append(&file)?;
    menu.append(&edit)?;
    menu.append(&view)?;
    menu.append(&help)?;
    Ok(menu)
}
