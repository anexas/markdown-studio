use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

const MAX_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_STYLESHEET_BYTES: u64 = 512 * 1024;
const MAX_TREE_CHILDREN: usize = 500;
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd"];
const SKIPPED_DIRECTORIES: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "__pycache__"];

fn is_markdown(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => {
            let lowered = ext.to_ascii_lowercase();
            MARKDOWN_EXTENSIONS.contains(&lowered.as_str())
        }
        None => false,
    }
}

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

#[derive(Serialize)]
pub struct DocPayload {
    pub content: String,
    pub eol: String,
    pub bom: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

/// Reads a markdown document as UTF-8, normalizing line endings for the editor and
/// remembering what was found so the file round-trips unchanged.
#[tauri::command]
pub fn read_document(path: String) -> Result<DocPayload, String> {
    let file = PathBuf::from(&path);
    if !is_markdown(&file) {
        return Err("Not a Markdown file".into());
    }

    let meta = fs::metadata(&file).map_err(|err| format!("Cannot open file: {err}"))?;
    if !meta.is_file() {
        return Err("That path is not a file".into());
    }
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "File is larger than {} MB",
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }

    let bytes = fs::read(&file).map_err(|err| format!("Cannot read file: {err}"))?;
    let (bytes, bom) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (rest.to_vec(), true),
        None => (bytes, false),
    };

    let text = String::from_utf8(bytes)
        .map_err(|_| "File is not valid UTF-8 text. Only UTF-8 (with or without BOM) is supported.".to_string())?;

    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let content = text.replace("\r\n", "\n");

    Ok(DocPayload {
        content,
        eol: eol.to_string(),
        bom,
    })
}

/// Writes through a temporary file in the same directory, then renames over the
/// target. A crash or power loss mid-save leaves the original file intact.
#[tauri::command]
pub fn write_document(path: String, content: String, eol: String, bom: bool) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if !is_markdown(&file) {
        return Err("Refusing to write a non-Markdown file".into());
    }

    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|err| format!("Cannot create folder: {err}"))?;
        }
    }

    let mut bytes: Vec<u8> = Vec::with_capacity(content.len() + 3);
    if bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    if eol == "\r\n" {
        bytes.extend_from_slice(content.replace('\n', "\r\n").as_bytes());
    } else {
        bytes.extend_from_slice(content.as_bytes());
    }

    write_atomic(&file, &bytes)
}

/// Writes through a temporary file in the same directory, then renames over the target.
fn write_atomic(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = file
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?;
    let temp = file.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));

    {
        let mut handle = fs::File::create(&temp).map_err(|err| format!("Cannot write file: {err}"))?;
        handle
            .write_all(bytes)
            .map_err(|err| format!("Cannot write file: {err}"))?;
        handle
            .sync_all()
            .map_err(|err| format!("Cannot flush file: {err}"))?;
    }

    fs::rename(&temp, file).map_err(|err| {
        let _ = fs::remove_file(&temp);
        format!("Cannot replace file: {err}")
    })?;

    Ok(())
}

/// Last-write time of a document in milliseconds, so the app can notice another program
/// rewriting the file. `None` means the path is missing or unreadable.
#[tauri::command]
pub fn document_stamp(path: String) -> Option<u64> {
    let meta = fs::metadata(Path::new(&path)).ok()?;
    if !meta.is_file() {
        return None;
    }
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|since| since.as_millis() as u64)
}

/// Reads the user's custom stylesheet. CSS only, and small: it is applied to the preview,
/// the rendered pane and the HTML export, not executed.
#[tauri::command]
pub fn read_stylesheet(path: String) -> Result<String, String> {
    let file = PathBuf::from(&path);
    let is_css = file
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("css"))
        .unwrap_or(false);
    if !is_css {
        return Err("Pick a .css file".into());
    }

    let meta = fs::metadata(&file).map_err(|err| format!("Cannot open stylesheet: {err}"))?;
    if !meta.is_file() {
        return Err("That path is not a file".into());
    }
    if meta.len() > MAX_STYLESHEET_BYTES {
        return Err(format!(
            "Stylesheet is larger than {} KB",
            MAX_STYLESHEET_BYTES / 1024
        ));
    }

    let bytes = fs::read(&file).map_err(|err| format!("Cannot read stylesheet: {err}"))?;
    String::from_utf8(bytes).map_err(|_| "Stylesheet is not UTF-8 text".to_string())
}

/// Writes a self-contained HTML export. The edited document stays Markdown, so this target
/// is validated separately rather than going through `write_document`.
#[tauri::command]
pub fn export_html(path: String, html: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    let allowed = file
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lowered = ext.to_ascii_lowercase();
            lowered == "html" || lowered == "htm"
        })
        .unwrap_or(false);
    if !allowed {
        return Err("An HTML export must end in .html or .htm".into());
    }
    if html.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "Export is larger than {} MB",
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }

    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|err| format!("Cannot create folder: {err}"))?;
        }
    }

    write_atomic(&file, html.as_bytes())
}

/// Lists one directory level for the folder sidebar: sub-folders plus markdown files.
#[tauri::command]
pub fn list_folder(path: String) -> Result<Vec<TreeEntry>, String> {
    let dir = PathBuf::from(&path);
    let meta = fs::metadata(&dir).map_err(|err| format!("Cannot read folder: {err}"))?;
    if !meta.is_dir() {
        return Err("That path is not a folder".into());
    }

    let read = fs::read_dir(&dir).map_err(|err| format!("Cannot read folder: {err}"))?;
    let mut entries: Vec<TreeEntry> = Vec::new();

    for item in read.flatten() {
        if entries.len() >= MAX_TREE_CHILDREN {
            break;
        }

        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let file_type = match item.file_type() {
            Ok(kind) => kind,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }

        let entry_path = item.path();
        if file_type.is_dir() {
            if SKIPPED_DIRECTORIES.contains(&name.to_ascii_lowercase().as_str()) {
                continue;
            }
            entries.push(TreeEntry {
                name,
                path: entry_path.to_string_lossy().to_string(),
                is_dir: true,
            });
        } else if file_type.is_file() && is_markdown(&entry_path) {
            entries.push(TreeEntry {
                name,
                path: entry_path.to_string_lossy().to_string(),
                is_dir: false,
            });
        }
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
    });

    Ok(entries)
}

/// Loads a raster image referenced by a document and returns it as a data URL.
/// SVG is rejected outright: it can execute script inside the webview.
#[tauri::command]
pub fn read_image(doc_dir: String, rel_path: String) -> Result<String, String> {
    let raw = rel_path
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('"');

    if raw.is_empty() {
        return Err("Empty image path".into());
    }

    let lowered = raw.to_ascii_lowercase();
    if lowered.starts_with("http:")
        || lowered.starts_with("https:")
        || lowered.starts_with("//")
        || lowered.starts_with("data:")
    {
        return Err("remote image blocked".into());
    }
    if lowered.ends_with(".svg") {
        return Err("SVG images are blocked".into());
    }

    let base = PathBuf::from(&doc_dir);
    let candidate = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        base.join(raw)
    };

    let resolved = candidate
        .canonicalize()
        .map_err(|_| "image not found".to_string())?;
    let meta = fs::metadata(&resolved).map_err(|_| "image not found".to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "image larger than {} MB",
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }

    let ext = resolved
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = image_mime(&ext).ok_or_else(|| "unsupported image type".to_string())?;

    let bytes = fs::read(&resolved).map_err(|_| "image not found".to_string())?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Opens a validated web link in the user's default browser. Only http(s)/mailto
/// are allowed, so a malicious document cannot launch local handlers.
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let lowered = url.to_ascii_lowercase();
    let allowed = lowered.starts_with("https://") || lowered.starts_with("http://") || lowered.starts_with("mailto:");
    if !allowed {
        return Err("Only http, https and mailto links can be opened externally.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("Could not open link: {err}"))
}

/// Markdown paths the process was launched with ("Open with", or a shell argument).
#[tauri::command]
pub fn initial_args() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| is_markdown(Path::new(arg)))
        .collect()
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    let package = app.package_info();
    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdstudio-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips_crlf_with_bom() {
        let dir = scratch("crlf");
        let file = dir.join("doc.md");
        let original: &[u8] = b"\xEF\xBB\xBF# Title\r\n\r\nLine two\r\n";
        fs::write(&file, original).unwrap();

        let path = file.to_string_lossy().to_string();
        let doc = read_document(path.clone()).unwrap();
        assert_eq!(doc.eol, "\r\n");
        assert!(doc.bom);
        assert_eq!(doc.content, "# Title\n\nLine two\n");

        write_document(path, doc.content.clone(), doc.eol.clone(), doc.bom).unwrap();
        assert_eq!(fs::read(&file).unwrap(), original);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trips_lf_without_bom() {
        let dir = scratch("lf");
        let file = dir.join("plain.markdown");
        let original: &[u8] = b"# Title\n\n- one\n- two\n";
        fs::write(&file, original).unwrap();

        let path = file.to_string_lossy().to_string();
        let doc = read_document(path.clone()).unwrap();
        assert_eq!(doc.eol, "\n");
        assert!(!doc.bom);
        assert_eq!(doc.content, "# Title\n\n- one\n- two\n");

        write_document(path, doc.content.clone(), doc.eol.clone(), doc.bom).unwrap();
        assert_eq!(fs::read(&file).unwrap(), original);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_new_file_and_leaves_no_temp_files() {
        let dir = scratch("new");
        let file = dir.join("created.md");
        let path = file.to_string_lossy().to_string();

        write_document(path.clone(), "hello\n".into(), "\n".into(), false).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello\n");

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files should not survive a save");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_utf8_documents() {
        let dir = scratch("encoding");
        let file = dir.join("utf16.md");
        fs::write(&file, [0xFF, 0xFE, 0x23, 0x00]).unwrap();
        assert!(read_document(file.to_string_lossy().to_string()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_markdown_paths() {
        let dir = scratch("extension");
        let exe = dir.join("danger.exe").to_string_lossy().to_string();
        assert!(write_document(exe.clone(), "x".into(), "\n".into(), false).is_err());
        assert!(read_document(exe).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_svg_and_remote_images() {
        let dir = scratch("images");
        let base = dir.to_string_lossy().to_string();
        assert!(read_image(base.clone(), "evil.svg".into()).is_err());
        assert!(read_image(base.clone(), "https://example.com/a.png".into()).is_err());
        assert!(read_image(base, "data:image/png;base64,AAAA".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn loads_png_as_data_url() {
        let dir = scratch("png");
        // Smallest valid PNG header plus padding; only the MIME mapping matters here.
        let png = dir.join("pixel.png");
        fs::write(&png, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]).unwrap();

        let result = read_image(dir.to_string_lossy().to_string(), "pixel.png".into()).unwrap();
        assert!(result.starts_with("data:image/png;base64,"), "unexpected: {result}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exports_html_and_rejects_markdown_targets() {
        let dir = scratch("export");
        let page = dir.join("page.html");
        export_html(page.to_string_lossy().to_string(), "<!doctype html><p>x</p>".into()).unwrap();
        assert!(fs::read_to_string(&page).unwrap().contains("<p>x</p>"));

        let md = dir.join("page.md");
        assert!(export_html(md.to_string_lossy().to_string(), "x".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_css_only_and_stamps_files() {
        let dir = scratch("style");
        let css = dir.join("theme.css");
        fs::write(&css, "body { color: red; }").unwrap();
        let css_path = css.to_string_lossy().to_string();
        assert_eq!(read_stylesheet(css_path.clone()).unwrap(), "body { color: red; }");

        let js = dir.join("theme.js");
        fs::write(&js, "alert(1)").unwrap();
        assert!(read_stylesheet(js.to_string_lossy().to_string()).is_err());

        let stamp = document_stamp(css_path).expect("an existing file has a stamp");
        assert!(stamp > 0);
        assert!(document_stamp(dir.join("missing.css").to_string_lossy().to_string()).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_only_markdown_and_folders() {
        let dir = scratch("listing");
        fs::write(dir.join("a.md"), "# a").unwrap();
        fs::write(dir.join("notes.txt"), "text").unwrap();
        fs::write(dir.join(".hidden.md"), "# hidden").unwrap();
        fs::create_dir(dir.join("sub")).unwrap();
        fs::create_dir(dir.join("node_modules")).unwrap();

        let entries = list_folder(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();

        assert!(names.contains(&"a.md"));
        assert!(names.contains(&"sub"));
        assert!(!names.contains(&"notes.txt"));
        assert!(!names.contains(&".hidden.md"));
        assert!(!names.contains(&"node_modules"));
        assert!(entries[0].is_dir, "folders sort before files");

        let _ = fs::remove_dir_all(&dir);
    }
}
