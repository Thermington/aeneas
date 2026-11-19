//! Installing a newer app from the hub (Settings, About, Update app; or when the owner asks for it from any device).
//! The page downloads the installer through whichever way it reaches the hub and streams it here in pieces
//! (`update_begin`, `update_chunk`, `update_finish`), so a phone never holds the whole file in memory. Nothing is run
//! unless the release key's signature fits this platform, that version and the saved bytes, against the key built into
//! the app, and the version is newer than this one: a changed hub or a changed download cannot put another program on
//! the device, nor an older Aeneas.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use ring::signature::{UnparsedPublicKey, ED25519};
use tauri::{AppHandle, Runtime};

/// The public half of the release key, shared with the hub (packages/shared/app-update-key.txt).
const KEY_FILE: &str = include_str!("../../../packages/shared/app-update-key.txt");
/// More than any installer the project ships (the Android app is about 25 MB, Windows about 4 MB).
const MAX_BYTES: u64 = 300 * 1024 * 1024;

#[cfg(windows)]
const THIS_PLATFORM: &str = "windows";
#[cfg(target_os = "android")]
const THIS_PLATFORM: &str = "android";
#[cfg(not(any(windows, target_os = "android")))]
const THIS_PLATFORM: &str = "";

fn release_key(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let line = text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#'))?;
    let raw = base64::engine::general_purpose::STANDARD.decode(line).ok()?;
    (raw.len() == 32).then_some(raw)
}

/// What the release key signs (the hub's appreleases.ts says the same).
pub fn signed_message(platform: &str, version: &str, sha256_hex: &str) -> String {
    format!("aeneas-app-update/1\n{platform}\n{version}\n{}", sha256_hex.to_lowercase())
}

fn parse_version(v: &str) -> Option<[u64; 3]> {
    let parts: Vec<u64> = v.trim().split('.').map(|p| p.parse().ok()).collect::<Option<Vec<_>>>()?;
    (parts.len() == 3).then(|| [parts[0], parts[1], parts[2]])
}

/// Whether `a` is a later version than `b`.
pub fn newer(a: &str, b: &str) -> bool {
    matches!((parse_version(a), parse_version(b)), (Some(x), Some(y)) if x > y)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Before anything is saved: an update for this kind of device, and newer than this app.
pub fn check_target(platform: &str, version: &str, current: &str, this_platform: &str) -> Result<(), String> {
    if this_platform.is_empty() || platform != this_platform {
        return Err("This update is for another kind of device.".into());
    }
    if !newer(version, current) {
        return Err(format!("This app is already {current}, so {version} is not an update."));
    }
    Ok(())
}

/// After it is saved: the release key's signature of this platform, version and file. `key` is the key file's text.
pub fn check_signature(platform: &str, version: &str, sha256_hex: &str, signature_b64: &str, key: &str) -> Result<(), String> {
    use base64::Engine;
    let key = release_key(key).ok_or("The app's release key is missing.")?;
    let sig = base64::engine::general_purpose::STANDARD.decode(signature_b64.trim()).map_err(|_| "The update's signature is not readable.".to_string())?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(signed_message(platform, version, sha256_hex).as_bytes(), &sig)
        .map_err(|_| "The update's signature does not match the release key, so it was not installed.".to_string())
}

/// The installer being saved: one at a time.
pub struct Pending {
    platform: String,
    version: String,
    path: PathBuf,
    file: std::fs::File,
    hash: ring::digest::Context,
    size: u64,
}

#[derive(Default)]
pub struct Updates(Mutex<Option<Pending>>);

/// Starts saving a new installer (a second start drops the first).
#[tauri::command]
pub async fn update_begin<R: Runtime>(app: AppHandle<R>, state: tauri::State<'_, Updates>, platform: String, version: String) -> Result<(), String> {
    check_target(&platform, &version, env!("CARGO_PKG_VERSION"), THIS_PLATFORM)?;
    let path = target_path(&app, &version)?;
    let file = std::fs::File::create(&path).map_err(|e| format!("could not save the update: {e}"))?;
    let mut slot = state.0.lock().map_err(|_| "busy")?;
    if let Some(old) = slot.take() {
        let _ = std::fs::remove_file(old.path);
    }
    *slot = Some(Pending { platform, version, path, file, hash: ring::digest::Context::new(&ring::digest::SHA256), size: 0 });
    Ok(())
}

/// One piece of the installer, base64 (the page sends about half a megabyte at a time).
#[tauri::command]
pub async fn update_chunk(state: tauri::State<'_, Updates>, b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "a piece of the update is not readable".to_string())?;
    let mut slot = state.0.lock().map_err(|_| "busy")?;
    let p = slot.as_mut().ok_or("no update is being saved")?;
    p.size += bytes.len() as u64;
    if p.size > MAX_BYTES {
        let gone = slot.take().map(|p| p.path);
        if let Some(path) = gone {
            let _ = std::fs::remove_file(path);
        }
        return Err("The update is larger than any Aeneas installer.".into());
    }
    p.hash.update(&bytes);
    p.file.write_all(&bytes).map_err(|e| format!("could not save the update: {e}"))
}

/// The whole installer is saved: checks the signature and starts it. Windows: the installer runs on its own (passive,
/// then it opens the new app) and this app quits so its files can be replaced; the answer is "installing". Android:
/// Android's own install prompt opens ("prompted"), or "permission" when the owner must first allow Aeneas to install
/// apps.
#[tauri::command]
pub async fn update_finish<R: Runtime>(app: AppHandle<R>, state: tauri::State<'_, Updates>, signature: String) -> Result<String, String> {
    let p = state.0.lock().map_err(|_| "busy")?.take().ok_or("no update is being saved")?;
    let Pending { platform, version, path, mut file, hash, .. } = p;
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    let sha = hex(hash.finish().as_ref());
    if let Err(e) = check_signature(&platform, &version, &sha, &signature, KEY_FILE) {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    install(&app, &path)
}

#[cfg(windows)]
fn target_path<R: Runtime>(_app: &AppHandle<R>, version: &str) -> Result<PathBuf, String> {
    Ok(std::env::temp_dir().join(format!("Aeneas-{version}-setup.exe")))
}

#[cfg(target_os = "android")]
fn target_path<R: Runtime>(app: &AppHandle<R>, version: &str) -> Result<PathBuf, String> {
    use tauri::Manager;
    let plugin = app.try_state::<crate::ApkInstaller<R>>().ok_or("the installer is not ready")?;
    #[derive(serde::Deserialize)]
    struct Dir {
        dir: String,
    }
    // The folder in the app's own cache that Android's installer is shown the file from.
    let dir: Dir = plugin.0.run_mobile_plugin("updatesDir", ()).map_err(|e| e.to_string())?;
    Ok(PathBuf::from(dir.dir).join(format!("Aeneas-{version}.apk")))
}

#[cfg(not(any(windows, target_os = "android")))]
fn target_path<R: Runtime>(_app: &AppHandle<R>, _version: &str) -> Result<PathBuf, String> {
    Err("This app installs updates only on Windows and Android.".into())
}

#[cfg(windows)]
fn install<R: Runtime>(app: &AppHandle<R>, path: &std::path::Path) -> Result<String, String> {
    // /P: passive (a progress window, no questions); /UPDATE: keeps the shortcuts as they are; /R: opens the new app.
    std::process::Command::new(path)
        .args(["/P", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| format!("could not start the installer: {e}"))?;
    // Quit after the answer has reached the page, so the installer can replace this app's files.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.exit(0);
    });
    Ok("installing".into())
}

#[cfg(target_os = "android")]
fn install<R: Runtime>(app: &AppHandle<R>, path: &std::path::Path) -> Result<String, String> {
    use tauri::Manager;
    let plugin = app.try_state::<crate::ApkInstaller<R>>().ok_or("the installer is not ready")?;
    #[derive(serde::Deserialize)]
    struct Out {
        state: String,
    }
    let out: Out = plugin
        .0
        .run_mobile_plugin("install", serde_json::json!({ "path": path.to_string_lossy() }))
        .map_err(|e| e.to_string())?;
    Ok(out.state)
}

#[cfg(not(any(windows, target_os = "android")))]
fn install<R: Runtime>(_app: &AppHandle<R>, _path: &std::path::Path) -> Result<String, String> {
    Err("This app installs updates only on Windows and Android.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn pair() -> (Ed25519KeyPair, String) {
        let rng = ring::rand::SystemRandom::new();
        let doc = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let kp = Ed25519KeyPair::from_pkcs8(doc.as_ref()).unwrap();
        let key = format!("# test key\n{}\n", base64::engine::general_purpose::STANDARD.encode(kp.public_key().as_ref()));
        (kp, key)
    }

    fn sha(bytes: &[u8]) -> String {
        hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
    }

    fn sign(kp: &Ed25519KeyPair, platform: &str, version: &str, bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(kp.sign(signed_message(platform, version, &sha(bytes)).as_bytes()).as_ref())
    }

    #[test]
    fn only_a_newer_update_for_this_platform_is_saved() {
        assert!(check_target("windows", "1.0.5", "1.0.4", "windows").is_ok());
        assert!(check_target("android", "1.0.5", "1.0.4", "windows").is_err(), "other platform");
        assert!(check_target("windows", "1.0.5", "1.0.5", "windows").is_err(), "not newer");
        assert!(check_target("windows", "1.0.4", "1.0.5", "windows").is_err(), "older");
        assert!(check_target("windows", "1.0.5", "1.0.4", "").is_err(), "a platform that does not install updates");
    }

    #[test]
    fn only_the_release_keys_signature_of_these_bytes_passes() {
        let (kp, key) = pair();
        let file = b"installer bytes";
        let sig = sign(&kp, "windows", "1.0.5", file);
        // Pieces hashed as they arrive give the same digest as the whole file.
        let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
        ctx.update(&file[..5]);
        ctx.update(&file[5..]);
        let streamed = hex(ctx.finish().as_ref());
        assert_eq!(streamed, sha(file));
        assert!(check_signature("windows", "1.0.5", &streamed, &sig, &key).is_ok());
        assert!(check_signature("windows", "1.0.5", &sha(b"changed"), &sig, &key).is_err(), "other bytes");
        assert!(check_signature("windows", "1.0.6", &streamed, &sig, &key).is_err(), "other version");
        assert!(check_signature("android", "1.0.5", &streamed, &sig, &key).is_err(), "other platform");
        let (other, _) = pair();
        assert!(check_signature("windows", "1.0.5", &streamed, &sign(&other, "windows", "1.0.5", file), &key).is_err(), "other key");
        assert!(check_signature("windows", "1.0.5", &streamed, "not base64!", &key).is_err());
    }

    #[test]
    fn the_shipped_key_is_readable_and_versions_compare_by_number() {
        assert!(release_key(KEY_FILE).is_some());
        assert!(newer("1.0.10", "1.0.9"));
        assert!(!newer("1.0", "0.9.9"));
        assert!(!newer("1.0.4", "1.0.4"));
    }
}
