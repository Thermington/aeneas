//! The Aeneas app on a helped person's computer (docs/helpers.md): it runs the commands their helper's assistant
//! sends through their hub, and it looks for the devices on their home network. The page asks the hub for work
//! (web/src/lib/helperAgent.ts) and calls these two commands; the hub only hands out work while the person lets a
//! helper in and this computer is switched on for it in the app.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

/// At most this much output comes back from one command.
const MAX_OUTPUT: usize = 200_000;

#[derive(Serialize)]
pub struct CommandResult {
    exit_code: i32,
    output: String,
}

/// Runs one command for the helper: PowerShell on Windows (hidden, UTF-8 output), sh elsewhere. Stopped, with
/// everything it started, after `timeout_s`.
#[tauri::command]
pub async fn run_helper_command(command: String, timeout_s: u64) -> Result<CommandResult, String> {
    let limit = Duration::from_secs(timeout_s.clamp(5, 600));
    let mut cmd = shell(&command);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| format!("could not start the command: {e}"))?;
    let pid = child.id();
    match tokio::time::timeout(limit, child.wait_with_output()).await {
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&err);
            }
            Ok(CommandResult { exit_code: out.status.code().unwrap_or(1), output: cut(text) })
        }
        Ok(Err(e)) => Err(format!("the command could not be read: {e}")),
        Err(_) => {
            stop_tree(pid);
            Ok(CommandResult { exit_code: 124, output: format!("Stopped after {} seconds.", limit.as_secs()) })
        }
    }
}

fn cut(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        let mut at = MAX_OUTPUT;
        while !s.is_char_boundary(at) {
            at -= 1;
        }
        s.truncate(at);
        s.push_str("\n[cut]");
    }
    s
}

#[cfg(windows)]
fn shell(command: &str) -> tokio::process::Command {
    // Hidden: no console window flashes on the person's screen.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = tokio::process::Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"])
        .arg(format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; {command}"))
        .creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(not(windows))]
fn shell(command: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new("/bin/sh");
    c.args(["-c", command]);
    c
}

#[cfg(windows)]
fn stop_tree(pid: Option<u32>) {
    if let Some(pid) = pid {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(CREATE_NO_WINDOW).status();
    }
}

#[cfg(not(windows))]
fn stop_tree(_pid: Option<u32>) {}

// ---------- another device in the home, over SSH ----------

#[derive(Serialize)]
pub struct SshResult {
    exit_code: i32,
    output: String,
    /// The device's key, SHA256:... as OpenSSH shows it: the hub keeps the first one it sees for each address and
    /// sends it with every later job, so a device that answers with another key is refused before any password goes.
    host_key: String,
}

struct Pinned {
    expected: Option<String>,
    seen: Arc<std::sync::Mutex<Option<String>>>,
}

impl russh::client::Handler for Pinned {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        use russh::keys::{HashAlg, PublicKeyOrCertificate};
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
            PublicKeyOrCertificate::Certificate(c) => russh::keys::PublicKey::from(c.public_key().clone()).fingerprint(HashAlg::Sha256).to_string(),
        };
        if let Ok(mut s) = self.seen.lock() {
            *s = Some(fp.clone());
        }
        Ok(self.expected.as_deref().map_or(true, |e| e == fp))
    }
}

/// Runs one command on another device in the home (a storage box, a Raspberry Pi, a Mac with Remote Login) that
/// already takes SSH, signing in with the user name and password the person saved for their helper. The connection
/// is made from this computer, on their home network.
#[tauri::command]
pub async fn ssh_helper_command(ip: String, port: u16, username: String, password: String, command: String, timeout_s: u64, host_key: Option<String>) -> Result<SshResult, String> {
    let addr: Ipv4Addr = ip.parse().map_err(|_| "not an address on the home network".to_string())?;
    if !addr.is_private() {
        return Err("only devices on the home network".into());
    }
    Ok(ssh_inner(&ip, port, &username, &password, &command, timeout_s, host_key).await)
}

async fn ssh_inner(ip: &str, port: u16, username: &str, password: &str, command: &str, timeout_s: u64, host_key: Option<String>) -> SshResult {
    let Ok(addr) = ip.parse::<Ipv4Addr>() else {
        return SshResult { exit_code: 255, output: "not an address".into(), host_key: String::new() };
    };
    let (username, password, command) = (username.to_string(), password.to_string(), command.to_string());
    let limit = Duration::from_secs(timeout_s.clamp(5, 600));
    let seen = Arc::new(std::sync::Mutex::new(None::<String>));
    let handler = Pinned { expected: host_key.clone(), seen: seen.clone() };
    let config = Arc::new(russh::client::Config { inactivity_timeout: Some(limit), ..Default::default() });
    let key_now = || seen.lock().ok().and_then(|s| s.clone()).unwrap_or_default();
    let work = async {
        let mut session = match russh::client::connect(config, (addr, if port == 0 { 22 } else { port }), handler).await {
            Ok(s) => s,
            Err(e) => {
                let seen_key = key_now();
                if host_key.is_some() && !seen_key.is_empty() && host_key.as_deref() != Some(seen_key.as_str()) {
                    return Err("This device answered with a different key than before, so nothing was sent to it. If it was reset or replaced, the person who helps can forget its key and try again.".to_string());
                }
                return Err(format!("could not connect: {e}"));
            }
        };
        let auth = session.authenticate_password(username, password).await.map_err(|e| format!("could not sign in: {e}"))?;
        if !auth.success() {
            return Err("The device did not take that user name and password.".to_string());
        }
        let mut channel = session.channel_open_session().await.map_err(|e| e.to_string())?;
        channel.exec(true, command).await.map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        let mut code = None;
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { ref data } => out.extend_from_slice(data),
                russh::ChannelMsg::ExtendedData { ref data, .. } => out.extend_from_slice(data),
                russh::ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status as i32),
                _ => {}
            }
            if out.len() > MAX_OUTPUT * 2 {
                break;
            }
        }
        let _ = session.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        Ok((code.unwrap_or(1), String::from_utf8_lossy(&out).into_owned()))
    };
    match tokio::time::timeout(limit + Duration::from_secs(10), work).await {
        Ok(Ok((exit_code, output))) => SshResult { exit_code, output: cut(output), host_key: key_now() },
        Ok(Err(e)) => SshResult { exit_code: 255, output: e, host_key: key_now() },
        Err(_) => SshResult { exit_code: 124, output: format!("Stopped after {} seconds.", limit.as_secs()), host_key: key_now() },
    }
}

// ---------- the devices in the home ----------

/// Ports that say what a device is and how a helper could reach it.
const PORTS: [(u16, &str); 14] = [
    (22, "SSH"),
    (80, "web page"),
    (443, "web page"),
    (445, "file sharing"),
    (548, "Mac file sharing"),
    (554, "camera"),
    (631, "printer"),
    (1400, "Sonos speaker"),
    (3389, "Windows Remote Desktop"),
    (5900, "screen sharing"),
    (8009, "Chromecast or Google speaker"),
    (8080, "web page"),
    (9100, "printer"),
    (62078, "iPhone or iPad"),
];

/// Bonjour names devices announce for themselves.
const SERVICES: [&str; 12] = [
    "_device-info._tcp.local.",
    "_companion-link._tcp.local.",
    "_airplay._tcp.local.",
    "_raop._tcp.local.",
    "_googlecast._tcp.local.",
    "_ipp._tcp.local.",
    "_printer._tcp.local.",
    "_smb._tcp.local.",
    "_ssh._tcp.local.",
    "_rfb._tcp.local.",
    "_http._tcp.local.",
    "_hap._tcp.local.",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HomeDevice {
    name: String,
    ip: String,
    open: Vec<u16>,
    kind: String,
}

#[derive(Serialize)]
pub struct HomeScan {
    network: String,
    devices: Vec<HomeDevice>,
}

/// This computer's address on the home network: the one the system would send from. A UDP "connection" to an
/// address reserved for documentation picks the route and sends nothing.
fn local_v4() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(a) if a.is_private() => Some(a),
        _ => None,
    }
}

/// What a device most likely is, from the ports that answered and its address.
pub fn kind_of(ip: Ipv4Addr, open: &[u16], announced: &str) -> String {
    let has = |p: u16| open.contains(&p);
    let a = announced.to_lowercase();
    if has(62078) || a.contains("iphone") || a.contains("ipad") {
        return "iPhone or iPad".into();
    }
    if has(9100) || has(631) || a.contains("printer") {
        return "printer".into();
    }
    if has(3389) {
        return "Windows computer (Remote Desktop on)".into();
    }
    // Screen sharing with file sharing is how a Mac answers; Windows does not offer screen sharing on that port.
    if has(548) || (has(5900) && has(445)) || a.contains("macbook") || a.contains("imac") || a.contains("mac mini") || a.contains("mac studio") {
        return "Mac".into();
    }
    if has(8009) || a.contains("chromecast") || a.contains("google") {
        return "Chromecast or Google speaker".into();
    }
    if has(1400) || a.contains("sonos") {
        return "Sonos speaker".into();
    }
    if has(554) {
        return "camera".into();
    }
    if ip.octets()[3] == 1 && (has(80) || has(443)) {
        return "router".into();
    }
    // File sharing with a web page of its own is a storage box (NAS) far more often than a PC.
    if has(445) && (has(443) || has(8080) || has(5000)) {
        return "storage box (NAS) or file server".into();
    }
    if has(445) {
        return "Windows computer".into();
    }
    if has(22) {
        return "computer or device with SSH".into();
    }
    if has(5900) {
        return "computer with screen sharing".into();
    }
    if has(80) || has(443) || has(8080) {
        return "device with a web page".into();
    }
    "device".into()
}

/// Looks for the devices on this computer's home network: which answer on the ports above (about 15 seconds), and the
/// names they announce over Bonjour. Only the home network is asked; nothing leaves it.
#[tauri::command]
pub async fn scan_home_network() -> Result<HomeScan, String> {
    let me = local_v4().ok_or("This device is not on a home network now (no private address).")?;
    let [a, b, c, _] = me.octets();
    let names = tokio::task::spawn_blocking(|| announced_names(Duration::from_secs(4)));
    let sem = Arc::new(tokio::sync::Semaphore::new(96));
    let mut set = tokio::task::JoinSet::new();
    for host in 1u8..=254 {
        for (port, _) in PORTS {
            let ip = Ipv4Addr::new(a, b, c, host);
            let sem = sem.clone();
            set.spawn(async move {
                let _permit = sem.acquire_owned().await.ok()?;
                let addr = SocketAddr::new(IpAddr::V4(ip), port);
                match tokio::time::timeout(Duration::from_millis(500), tokio::net::TcpStream::connect(addr)).await {
                    Ok(Ok(_)) => Some((ip, port)),
                    _ => None,
                }
            });
        }
    }
    let mut open: BTreeMap<Ipv4Addr, Vec<u16>> = BTreeMap::new();
    while let Some(r) = set.join_next().await {
        if let Ok(Some((ip, port))) = r {
            open.entry(ip).or_default().push(port);
        }
    }
    let names = names.await.unwrap_or_default();
    for ip in names.keys() {
        if ip.octets()[..3] == [a, b, c] {
            open.entry(*ip).or_default();
        }
    }
    let devices = open
        .into_iter()
        .map(|(ip, mut ports)| {
            ports.sort_unstable();
            let announced = names.get(&ip).cloned().unwrap_or_default();
            let name = if ip == me { "This computer".to_string() } else { announced.clone() };
            HomeDevice { kind: kind_of(ip, &ports, &announced), name, ip: ip.to_string(), open: ports }
        })
        .collect();
    Ok(HomeScan { network: format!("{a}.{b}.{c}.0/24"), devices })
}

/// Bonjour names by address, listening `wait` for the common kinds of home devices.
fn announced_names(wait: Duration) -> BTreeMap<Ipv4Addr, String> {
    use mdns_sd::{IfKind, ServiceDaemon, ServiceEvent};
    let mut out = BTreeMap::new();
    let Ok(mdns) = ServiceDaemon::new() else { return out };
    let _ = mdns.disable_interface(IfKind::IPv6);
    let rxs: Vec<_> = SERVICES.iter().filter_map(|s| mdns.browse(s).ok()).collect();
    let deadline = std::time::Instant::now() + wait;
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        let mut any = false;
        for rx in &rxs {
            while let Ok(ev) = rx.try_recv() {
                any = true;
                if let ServiceEvent::ServiceResolved(s) = ev {
                    let name = s.get_fullname().split("._").next().unwrap_or("").replace("\\032", " ");
                    for a in s.get_addresses() {
                        if let IpAddr::V4(v4) = a.to_ip_addr() {
                            if v4.is_private() && !name.is_empty() {
                                out.entry(v4).or_insert_with(|| name.clone());
                            }
                        }
                    }
                }
            }
        }
        if !any {
            std::thread::sleep(left.min(Duration::from_millis(100)));
        }
    }
    for s in SERVICES {
        let _ = mdns.stop_browse(s);
    }
    let _ = mdns.shutdown();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_are_named_by_what_answers() {
        let ip = |d| Ipv4Addr::new(192, 168, 1, d);
        assert_eq!(kind_of(ip(1), &[80, 443], ""), "router");
        assert_eq!(kind_of(ip(20), &[80], ""), "device with a web page");
        assert_eq!(kind_of(ip(30), &[631, 9100], ""), "printer");
        assert_eq!(kind_of(ip(31), &[62078], ""), "iPhone or iPad");
        assert_eq!(kind_of(ip(32), &[], "Jane's iPhone"), "iPhone or iPad");
        assert_eq!(kind_of(ip(33), &[445, 3389], ""), "Windows computer (Remote Desktop on)");
        assert_eq!(kind_of(ip(34), &[22], ""), "computer or device with SSH");
        assert_eq!(kind_of(ip(35), &[22, 445, 5900], ""), "Mac");
        assert_eq!(kind_of(ip(36), &[22, 443, 445, 8080], "attic"), "storage box (NAS) or file server");
        assert_eq!(kind_of(ip(37), &[445], ""), "Windows computer");
    }

    #[tokio::test]
    async fn a_command_runs_and_one_that_runs_too_long_is_stopped() {
        let ok = run_helper_command("echo hello".into(), 10).await.unwrap();
        assert_eq!(ok.exit_code, 0);
        assert!(ok.output.contains("hello"));
        let slow = run_helper_command(if cfg!(windows) { "Start-Sleep 30".into() } else { "sleep 30".into() }, 5).await.unwrap();
        assert_eq!(slow.exit_code, 124);
    }

    /// A small SSH server on 127.0.0.1 that takes one user name and password and answers each command.
    async fn test_server(seed: u8) -> (u16, tokio::task::JoinHandle<()>) {
        use russh::server::{Auth, Msg, Server as _, Session};
        use russh::{Channel, ChannelId};
        #[derive(Clone)]
        struct S;
        impl russh::server::Server for S {
            type Handler = S;
            fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> S { S }
        }
        impl russh::server::Handler for S {
            type Error = russh::Error;
            async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
                Ok(if user == "mom" && password == "right-one" { Auth::Accept } else { Auth::reject() })
            }
            async fn channel_open_session(&mut self, _c: Channel<Msg>, reply: russh::server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
                reply.accept().await;
                Ok(())
            }
            async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
                session.channel_success(channel)?;
                session.data(channel, format!("ran: {}", String::from_utf8_lossy(data)).into_bytes())?;
                session.exit_status_request(channel, 0)?;
                session.eof(channel)?;
                session.close(channel)?;
                Ok(())
            }
        }
        let key = russh::keys::PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]));
        let config = Arc::new(russh::server::Config { keys: vec![key], auth_rejection_time: Duration::from_millis(10), auth_rejection_time_initial: Some(Duration::from_millis(0)), ..Default::default() });
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let task = tokio::spawn(async move { let _ = S.run_on_socket(config, &socket).await; });
        (port, task)
    }

    #[tokio::test]
    async fn ssh_signs_in_with_the_saved_password_and_refuses_a_device_with_another_key() {
        let (port, server) = test_server(7).await;
        // 127.0.0.1 stands in for a home address here.
        let first = ssh_inner("127.0.0.1", port, "mom", "right-one", "uptime", 10, None).await;
        assert_eq!(first.exit_code, 0, "{}", first.output);
        assert_eq!(first.output, "ran: uptime");
        assert!(first.host_key.starts_with("SHA256:"));
        let again = ssh_inner("127.0.0.1", port, "mom", "right-one", "df -h", 10, Some(first.host_key.clone())).await;
        assert_eq!(again.exit_code, 0);
        let wrong = ssh_inner("127.0.0.1", port, "mom", "wrong", "uptime", 10, None).await;
        assert_eq!(wrong.exit_code, 255);
        assert!(wrong.output.contains("did not take"), "{}", wrong.output);
        server.abort();
        // Another device at the same address (another key): refused before any password goes.
        let (port2, other) = test_server(9).await;
        let swapped = ssh_inner("127.0.0.1", port2, "mom", "right-one", "uptime", 10, Some(first.host_key)).await;
        assert_eq!(swapped.exit_code, 255);
        assert!(swapped.output.contains("different key"), "{}", swapped.output);
        other.abort();
    }

    /// By hand on a real network: cargo test --lib scan_this_network -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn scan_this_network() {
        let s = scan_home_network().await.unwrap();
        println!("{} on {}", s.devices.len(), s.network);
        for d in s.devices {
            println!("{:<15} {:<28} {:?} {}", d.ip, d.kind, d.open, d.name);
        }
    }

    #[test]
    fn long_output_is_cut_on_a_character() {
        let s = "é".repeat(MAX_OUTPUT);
        let c = cut(s);
        assert!(c.ends_with("[cut]"));
    }
}
