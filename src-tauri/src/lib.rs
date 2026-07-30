use serde::{Deserialize, Serialize};
use std::{
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use thiserror::Error;
use uuid::Uuid;

const OBS_VERSION: &str = "32.2.1";

#[derive(Default)]
struct ObsRuntime {
    child: Option<Child>,
    pid: Option<u32>,
    executable: Option<PathBuf>,
    install_root: Option<PathBuf>,
    port: Option<u16>,
    password: Option<String>,
    started_at_ms: Option<u64>,
    websocket_config_path: Option<PathBuf>,
    websocket_was_enabled: Option<bool>,
    session_file: Option<PathBuf>,
}

#[derive(Debug, Error)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("File operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Tauri path operation failed: {0}")]
    Tauri(#[from] tauri::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsLaunchSession {
    websocket_url: String,
    password: String,
    pid: u32,
    version: String,
    started_at_ms: u64,
    recording_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedObsSession {
    pid: u32,
    executable: PathBuf,
    install_root: PathBuf,
    port: u16,
    password: String,
    started_at_ms: u64,
    websocket_config_path: PathBuf,
    websocket_was_enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsProcessStatus {
    running: bool,
    pid: Option<u32>,
    version: String,
    staged: bool,
    started_at_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupResult {
    started: bool,
    requires_user_action: bool,
    message: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn recording_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let path = app.path().video_dir()?.join("Streamz");
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn obs_session_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app.path().app_local_data_dir()?.join("obs-session.json"))
}

fn write_persisted_session(
    path: &std::path::Path,
    session: &PersistedObsSession,
) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_vec(session)
        .map_err(|error| AppError::Message(format!("Could not encode OBS session: {error}")))?;
    fs::write(&temporary, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

fn read_persisted_session(path: &std::path::Path) -> Option<PersistedObsSession> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

#[cfg(unix)]
fn process_matches(pid: u32, executable: &std::path::Path) -> bool {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output();
    output
        .ok()
        .filter(|result| result.status.success())
        .map(|result| {
            String::from_utf8_lossy(&result.stdout).contains(&executable.to_string_lossy().as_ref())
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn process_matches(pid: u32, executable: &std::path::Path) -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output();
    let executable_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("obs64.exe");
    output
        .ok()
        .filter(|result| result.status.success())
        .map(|result| {
            String::from_utf8_lossy(&result.stdout)
                .to_ascii_lowercase()
                .contains(&executable_name.to_ascii_lowercase())
        })
        .unwrap_or(false)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn process_matches(_pid: u32, _executable: &std::path::Path) -> bool {
    false
}

fn session_is_running(session: &PersistedObsSession) -> bool {
    process_matches(session.pid, &session.executable)
}

#[cfg(unix)]
fn orphaned_streamz_obs_pids() -> Vec<u32> {
    let output = Command::new("ps").args(["-axo", "pid=,command="]).output();
    let Some(output) = output.ok().filter(|result| result.status.success()) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| {
            line.contains("--websocket_password")
                && line.contains("--websocket_port")
                && line.contains("--disable-missing-files-check")
        })
        .filter_map(|line| line.split_whitespace().next()?.parse::<u32>().ok())
        .collect()
}

#[cfg(target_os = "windows")]
fn orphaned_streamz_obs_pids() -> Vec<u32> {
    let script = "Get-CimInstance Win32_Process -Filter \"Name='obs64.exe'\" | \
        Where-Object { $_.CommandLine -match '--websocket_password' -and \
        $_.CommandLine -match '--websocket_port' -and \
        $_.CommandLine -match '--disable-missing-files-check' } | \
        Select-Object -ExpandProperty ProcessId";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output();
    let Some(output) = output.ok().filter(|result| result.status.success()) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

#[cfg(not(any(unix, target_os = "windows")))]
fn orphaned_streamz_obs_pids() -> Vec<u32> {
    Vec::new()
}

#[cfg(unix)]
fn terminate_pid(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    for _ in 0..20 {
        if !Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
}

#[cfg(target_os = "windows")]
fn terminate_pid(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

#[cfg(not(any(unix, target_os = "windows")))]
fn terminate_pid(_pid: u32) {}

fn free_loopback_port() -> Result<u16, AppError> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let listener = TcpListener::bind(address)?;
    Ok(listener.local_addr()?.port())
}

fn websocket_config_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .config_dir()?
        .join("obs-studio")
        .join("plugin_config")
        .join("obs-websocket")
        .join("config.json"))
}

fn set_websocket_enabled(path: &std::path::Path, enabled: bool) -> Result<(), AppError> {
    let mut config = if path.is_file() {
        let contents = fs::read(path)?;
        serde_json::from_slice::<serde_json::Value>(&contents).map_err(|error| {
            AppError::Message(format!(
                "Could not read OBS WebSocket settings at {}: {error}",
                path.display()
            ))
        })?
    } else {
        serde_json::json!({})
    };
    let object = config.as_object_mut().ok_or_else(|| {
        AppError::Message(format!(
            "OBS WebSocket settings at {} are not a JSON object.",
            path.display()
        ))
    })?;
    object.insert("server_enabled".into(), enabled.into());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let contents = serde_json::to_vec_pretty(&config).map_err(|error| {
        AppError::Message(format!("Could not encode OBS WebSocket settings: {error}"))
    })?;
    fs::write(path, contents)?;
    Ok(())
}

fn enable_websocket_for_session(app: &AppHandle) -> Result<(PathBuf, bool), AppError> {
    let path = websocket_config_path(app)?;
    let was_enabled = if path.is_file() {
        let contents = fs::read(&path)?;
        serde_json::from_slice::<serde_json::Value>(&contents)
            .ok()
            .and_then(|config| config.get("server_enabled")?.as_bool())
            .unwrap_or(false)
    } else {
        false
    };
    set_websocket_enabled(&path, true)?;
    Ok((path, was_enabled))
}

fn restore_websocket_setting(runtime: &mut ObsRuntime) {
    if let (Some(path), Some(was_enabled)) = (
        runtime.websocket_config_path.take(),
        runtime.websocket_was_enabled.take(),
    ) {
        let _ = set_websocket_enabled(&path, was_enabled);
    }
}

fn resource_obs_roots(app: &AppHandle) -> Result<Vec<PathBuf>, AppError> {
    let resource_dir = app.path().resource_dir()?;
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("obs");
    Ok(vec![
        resource_dir.join("resources").join("obs"),
        resource_dir.join("obs"),
        development,
    ])
}

#[cfg(target_os = "windows")]
fn copy_directory(source: &std::path::Path, destination: &std::path::Path) -> Result<(), AppError> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else {
            fs::copy(source_path, destination_path)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn resolve_obs(app: &AppHandle) -> Result<(PathBuf, PathBuf), AppError> {
    // A camera system extension can only be activated by a signed host app in
    // /Applications. Prefer a normal OBS installation when present so Streamz
    // can use OBS Virtual Camera after the user's one-time macOS approval.
    let installed_root = PathBuf::from("/Applications/OBS.app");
    let installed_executable = installed_root.join("Contents").join("MacOS").join("OBS");
    if installed_executable.is_file() {
        return Ok((installed_executable, installed_root));
    }

    for candidate in resource_obs_roots(app)? {
        let root = candidate.join("macos").join("OBS.app");
        let executable = root.join("Contents").join("MacOS").join("OBS");
        if executable.is_file() {
            return Ok((executable, root));
        }
    }
    Err(AppError::Message(
        "Bundled OBS is not ready. Restart `pnpm tauri dev` so its automatic OBS preflight can finish.".into(),
    ))
}

#[cfg(target_os = "windows")]
fn resolve_obs(app: &AppHandle) -> Result<(PathBuf, PathBuf), AppError> {
    let source = resource_obs_roots(app)?
        .into_iter()
        .map(|root| root.join("windows"))
        .find(|root| root.join("bin").join("64bit").join("obs64.exe").is_file())
        .ok_or_else(|| {
            AppError::Message(
                "Bundled OBS is not ready. Restart `pnpm tauri dev` so its automatic OBS preflight can finish.".into(),
            )
        })?;

    let destination = app
        .path()
        .app_local_data_dir()?
        .join("obs-runtime")
        .join(OBS_VERSION);
    let marker = destination.join(".streamz-ready");
    if !marker.exists() {
        if destination.exists() {
            fs::remove_dir_all(&destination)?;
        }
        copy_directory(&source, &destination)?;
        fs::write(&marker, OBS_VERSION)?;
        fs::write(destination.join("portable_mode.txt"), "")?;
    }

    Ok((
        destination.join("bin").join("64bit").join("obs64.exe"),
        destination,
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn resolve_obs(_app: &AppHandle) -> Result<(PathBuf, PathBuf), AppError> {
    Err(AppError::Message(
        "The Streamz OBS prototype currently supports macOS and Windows.".into(),
    ))
}

fn launch_session_from_runtime(
    runtime: &ObsRuntime,
    recording_path: &std::path::Path,
) -> Option<ObsLaunchSession> {
    Some(ObsLaunchSession {
        websocket_url: format!("ws://127.0.0.1:{}", runtime.port?),
        password: runtime.password.clone()?,
        pid: runtime.pid?,
        version: OBS_VERSION.into(),
        started_at_ms: runtime.started_at_ms?,
        recording_path: recording_path.to_string_lossy().into_owned(),
    })
}

fn hydrate_runtime(runtime: &mut ObsRuntime, session_file: PathBuf, session: PersistedObsSession) {
    runtime.pid = Some(session.pid);
    runtime.executable = Some(session.executable);
    runtime.install_root = Some(session.install_root);
    runtime.port = Some(session.port);
    runtime.password = Some(session.password);
    runtime.started_at_ms = Some(session.started_at_ms);
    runtime.websocket_config_path = Some(session.websocket_config_path);
    runtime.websocket_was_enabled = Some(session.websocket_was_enabled);
    runtime.session_file = Some(session_file);
}

fn clear_runtime(runtime: &mut ObsRuntime) {
    runtime.child = None;
    runtime.pid = None;
    runtime.executable = None;
    runtime.install_root = None;
    runtime.password = None;
    runtime.port = None;
    runtime.started_at_ms = None;
    restore_websocket_setting(runtime);
    if let Some(path) = runtime.session_file.take() {
        let _ = fs::remove_file(path);
    }
}

fn terminate_runtime(runtime: &mut ObsRuntime) -> Result<(), AppError> {
    if let Some(mut child) = runtime.child.take() {
        if child.try_wait()?.is_none() {
            child.kill()?;
            let _ = child.wait();
        }
    } else if let (Some(pid), Some(executable)) = (runtime.pid, runtime.executable.as_ref()) {
        if process_matches(pid, executable) {
            terminate_pid(pid);
        }
    }
    clear_runtime(runtime);
    Ok(())
}

#[tauri::command]
fn launch_obs(
    app: AppHandle,
    state: State<'_, Mutex<ObsRuntime>>,
) -> Result<ObsLaunchSession, AppError> {
    let recording_path = recording_path(&app)?;
    let session_file = obs_session_path(&app)?;
    let mut runtime = state
        .lock()
        .map_err(|_| AppError::Message("OBS runtime lock was poisoned.".into()))?;

    if runtime.child.is_some() {
        let (running, pid) = {
            let child = runtime.child.as_mut().expect("checked above");
            (child.try_wait()?.is_none(), child.id())
        };
        if running {
            runtime.pid = Some(pid);
            if let Some(session) = launch_session_from_runtime(&runtime, &recording_path) {
                return Ok(session);
            }
        }
        clear_runtime(&mut runtime);
    }

    if let Some(session) = read_persisted_session(&session_file) {
        if session_is_running(&session) {
            hydrate_runtime(&mut runtime, session_file.clone(), session);
            if let Some(launch_session) = launch_session_from_runtime(&runtime, &recording_path) {
                return Ok(launch_session);
            }
        } else {
            let _ = fs::remove_file(&session_file);
        }
    }

    for pid in orphaned_streamz_obs_pids() {
        terminate_pid(pid);
    }

    let (executable, install_root) = resolve_obs(&app)?;
    let (websocket_config_path, websocket_was_enabled) = enable_websocket_for_session(&app)?;
    let port = free_loopback_port()?;
    let password = Uuid::new_v4().simple().to_string();
    let started_at_ms = now_ms();

    let mut command = Command::new(&executable);
    command
        .arg("--multi")
        .arg("--minimize-to-tray")
        .arg("--disable-updater")
        .arg("--disable-missing-files-check")
        .arg("--websocket_ipv4_only")
        .arg("--websocket_port")
        .arg(port.to_string())
        .arg("--websocket_password")
        .arg(&password)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    command.arg("--portable");

    if let Some(parent) = executable.parent() {
        command.current_dir(parent);
    }

    let child = command.spawn().map_err(|error| {
        let _ = set_websocket_enabled(&websocket_config_path, websocket_was_enabled);
        AppError::Message(format!(
            "Could not start bundled OBS at {}: {error}",
            executable.display()
        ))
    })?;
    let pid = child.id();

    runtime.child = Some(child);
    runtime.pid = Some(pid);
    runtime.executable = Some(executable);
    runtime.install_root = Some(install_root);
    runtime.port = Some(port);
    runtime.password = Some(password.clone());
    runtime.started_at_ms = Some(started_at_ms);
    runtime.websocket_config_path = Some(websocket_config_path);
    runtime.websocket_was_enabled = Some(websocket_was_enabled);
    runtime.session_file = Some(session_file.clone());

    if let Err(error) = write_persisted_session(
        &session_file,
        &PersistedObsSession {
            pid,
            executable: runtime.executable.clone().expect("set above"),
            install_root: runtime.install_root.clone().expect("set above"),
            port,
            password: password.clone(),
            started_at_ms,
            websocket_config_path: runtime.websocket_config_path.clone().expect("set above"),
            websocket_was_enabled,
        },
    ) {
        let _ = terminate_runtime(&mut runtime);
        return Err(error);
    }

    Ok(ObsLaunchSession {
        websocket_url: format!("ws://127.0.0.1:{port}"),
        password,
        pid,
        version: OBS_VERSION.into(),
        started_at_ms,
        recording_path: recording_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn get_obs_process_status(
    app: AppHandle,
    state: State<'_, Mutex<ObsRuntime>>,
) -> Result<ObsProcessStatus, AppError> {
    let staged = resolve_obs(&app).is_ok();
    let mut runtime = state
        .lock()
        .map_err(|_| AppError::Message("OBS runtime lock was poisoned.".into()))?;
    let (running, pid) = if let Some(child) = runtime.child.as_mut() {
        if child.try_wait()?.is_none() {
            let pid = child.id();
            runtime.pid = Some(pid);
            (true, Some(pid))
        } else {
            clear_runtime(&mut runtime);
            (false, None)
        }
    } else if let (Some(pid), Some(executable)) = (runtime.pid, runtime.executable.as_ref()) {
        if process_matches(pid, executable) {
            (true, Some(pid))
        } else {
            clear_runtime(&mut runtime);
            (false, None)
        }
    } else {
        (false, None)
    };

    Ok(ObsProcessStatus {
        running,
        pid,
        version: OBS_VERSION.into(),
        staged,
        started_at_ms: runtime.started_at_ms,
    })
}

#[tauri::command]
fn reveal_obs(state: State<'_, Mutex<ObsRuntime>>) -> Result<(), AppError> {
    let runtime = state
        .lock()
        .map_err(|_| AppError::Message("OBS runtime lock was poisoned.".into()))?;
    let install_root = runtime
        .install_root
        .clone()
        .ok_or_else(|| AppError::Message("OBS is not running.".into()))?;

    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-a").arg(install_root).spawn()?;
    }

    #[cfg(target_os = "windows")]
    {
        let pid = runtime
            .pid
            .ok_or_else(|| AppError::Message("OBS is not running.".into()))?;
        let script = format!(
            "$p=Get-Process -Id {pid}; \
             $sig='[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd,int nCmdShow); \
             [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'; \
             $u=Add-Type -MemberDefinition $sig -Name Native -Namespace Streamz -PassThru; \
             $u::ShowWindowAsync($p.MainWindowHandle,9); \
             $u::SetForegroundWindow($p.MainWindowHandle)"
        );
        Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .spawn()?;
    }

    Ok(())
}

#[tauri::command]
fn install_virtual_camera(state: State<'_, Mutex<ObsRuntime>>) -> Result<SetupResult, AppError> {
    #[cfg(target_os = "macos")]
    {
        let _ = state;
        return Ok(SetupResult {
            started: false,
            requires_user_action: true,
            message: "OBS Virtual Camera needs the signed OBS app in /Applications. Open OBS once, start Virtual Camera, then enable OBS under System Settings → Privacy & Security → Extensions (or Login Items & Extensions → Camera Extensions) and restart OBS.".into(),
        });
    }

    #[cfg(target_os = "windows")]
    {
        let runtime = state
            .lock()
            .map_err(|_| AppError::Message("OBS runtime lock was poisoned.".into()))?;
        let root = runtime.install_root.clone().ok_or_else(|| {
            AppError::Message("Launch OBS before installing Virtual Camera.".into())
        })?;
        let installer = root
            .join("data")
            .join("obs-plugins")
            .join("win-dshow")
            .join("virtualcam-install.bat");
        if !installer.exists() {
            return Err(AppError::Message(format!(
                "OBS Virtual Camera installer was not found at {}.",
                installer.display()
            )));
        }
        let escaped = installer.to_string_lossy().replace('\'', "''");
        let script =
            format!("Start-Process cmd.exe -Verb RunAs -ArgumentList '/c','\"{escaped}\"'");
        Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .spawn()?;
        return Ok(SetupResult {
            started: true,
            requires_user_action: true,
            message: "Approve the Windows administrator prompt, then restart OBS.".into(),
        });
    }

    #[allow(unreachable_code)]
    Ok(SetupResult {
        started: false,
        requires_user_action: true,
        message: "Virtual Camera setup is not supported on this platform.".into(),
    })
}

#[tauri::command]
fn shutdown_obs(force: bool, state: State<'_, Mutex<ObsRuntime>>) -> Result<(), AppError> {
    let mut runtime = state
        .lock()
        .map_err(|_| AppError::Message("OBS runtime lock was poisoned.".into()))?;
    if !force {
        return Err(AppError::Message(
            "A graceful OBS shutdown must stop streaming and Virtual Camera first.".into(),
        ));
    }
    terminate_runtime(&mut runtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_session_round_trips_private_connection_details() {
        let directory = std::env::temp_dir().join(format!("streamz-test-{}", Uuid::new_v4()));
        let path = directory.join("obs-session.json");
        let session = PersistedObsSession {
            pid: 42,
            executable: PathBuf::from("/Applications/OBS.app/Contents/MacOS/OBS"),
            install_root: PathBuf::from("/Applications/OBS.app"),
            port: 44_55,
            password: "private-password".into(),
            started_at_ms: 123,
            websocket_config_path: directory.join("config.json"),
            websocket_was_enabled: false,
        };

        write_persisted_session(&path, &session).expect("session should be written");
        let restored = read_persisted_session(&path).expect("session should be readable");

        assert_eq!(restored.pid, session.pid);
        assert_eq!(restored.port, session.port);
        assert_eq!(restored.password, session.password);
        assert_eq!(restored.executable, session.executable);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn launch_session_requires_complete_runtime_state() {
        let mut runtime = ObsRuntime::default();
        assert!(launch_session_from_runtime(&runtime, std::path::Path::new("/tmp")).is_none());

        runtime.pid = Some(42);
        runtime.port = Some(44_55);
        runtime.password = Some("secret".into());
        runtime.started_at_ms = Some(123);
        let session = launch_session_from_runtime(&runtime, std::path::Path::new("/tmp"))
            .expect("complete runtime should produce a session");
        assert_eq!(session.pid, 42);
        assert_eq!(session.websocket_url, "ws://127.0.0.1:4455");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(ObsRuntime::default()))
        .invoke_handler(tauri::generate_handler![
            launch_obs,
            reveal_obs,
            get_obs_process_status,
            install_virtual_camera,
            shutdown_obs
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut runtime) = window.state::<Mutex<ObsRuntime>>().lock() {
                    let _ = terminate_runtime(&mut runtime);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Streamz");
}
