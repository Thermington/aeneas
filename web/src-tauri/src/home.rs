//! The home network route for the Windows and Android apps (contract, Devices, "Home route"): requests to the hub's
//! address on the home network go over HTTPS that accepts exactly one certificate, the hub's own, pinned by the SHA-256
//! of its DER bytes (lowercase hex, from `GET /link/routes`). There are no system roots and no host name check: the
//! hub's home address is a private IP that no public certificate names, and the pin is narrower than either. The
//! handshake signatures are still checked with the crypto provider's own functions, so someone holding only a copy of
//! the certificate (it is public) cannot finish a handshake.
//!
//! The device key is added here and only here: the page hands it over apart from the headers, and it goes out only on
//! this pinned client, to an https address, once the handshake accepted the pinned certificate. A plain or unpinned
//! connection never carries it.
//!
//! Bonjour (`_aeneas._tcp`, hub/src/announce.ts) is the last resort, which the page uses only when both the home
//! addresses and the remote route failed: it listens for a few seconds at most, takes an announcement only when its
//! `fp` is the pin, and the address found must still present the pinned certificate.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONNECTION, TRANSFER_ENCODING};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, SignatureScheme};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::task::AbortHandle;

/// Connecting on the home network takes milliseconds; this is the most it may take.
const CONNECT: Duration = Duration::from_secs(3);
/// The most an answer may stay silent (the live updates send a ping every 25 seconds).
const IDLE: Duration = Duration::from_secs(75);
/// A whole request when the page names no limit, and the most it may name. Live updates have no limit but IDLE.
const TOTAL: Duration = Duration::from_secs(180);
const TOTAL_MAX: Duration = Duration::from_secs(600);
/// A check that the hub answers at an address (the page asks for 1.5 seconds).
const PROBE_MAX: Duration = Duration::from_secs(5);
/// Listening for the hub's Bonjour announcement.
const BROWSE_MAX: Duration = Duration::from_secs(5);
const SERVICE: &str = "_aeneas._tcp.local.";

/// The SHA-256 of the hub's home certificate.
pub type Pin = [u8; 32];

/// A pin as the hub writes it: 64 hex characters. Capitals and colons between the bytes are accepted too.
pub fn parse_pin(fp: &str) -> Option<Pin> {
    let hex: Vec<u8> = fp.trim().bytes().filter(|b| *b != b':').collect();
    if hex.len() != 64 || !hex.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let mut pin = [0u8; 32];
    for (i, pair) in hex.chunks(2).enumerate() {
        pin[i] = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(pin)
}

fn sha256(der: &[u8]) -> Pin {
    let mut pin = [0u8; 32];
    pin.copy_from_slice(ring::digest::digest(&ring::digest::SHA256, der).as_ref());
    pin
}

/// Accepts the one certificate whose SHA-256 is the pin, and checks the handshake signatures as rustls always does.
#[derive(Debug)]
pub struct PinnedLeaf {
    pin: Pin,
    provider: Arc<CryptoProvider>,
}

impl PinnedLeaf {
    pub fn new(pin: Pin, provider: Arc<CryptoProvider>) -> Self {
        Self { pin, provider }
    }
}

impl ServerCertVerifier for PinnedLeaf {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if sha256(end_entity.as_ref()) == self.pin {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// TLS 1.3 or 1.2 with ring, trusting only the pinned certificate.
pub fn tls_config(pin: Pin) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedLeaf::new(pin, provider)))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// The only client that carries the device key: https only, no proxy, no redirects, hard timeouts.
fn pinned_client(pin: Pin) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls_config(pin)?)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT)
        .read_timeout(IDLE)
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("the home network connection could not start ({e})"))
}

/// A home address: https, with a host, and no user name or password in it.
pub fn home_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "the home address is not valid".to_string())?;
    if url.scheme() != "https" {
        return Err("the home network route is https only".into());
    }
    if url.host().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("the home address is not valid".into());
    }
    Ok(url)
}

/// The headers of a home request. The page's own Authorization is dropped: the key goes in only from `key`, here.
pub fn request_headers(headers: &[(String, String)], key: Option<&str>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let lk = k.to_ascii_lowercase();
        if matches!(
            lk.as_str(),
            "authorization" | "proxy-authorization" | "cookie" | "host" | "content-length" | "connection" | "transfer-encoding" | "accept-encoding"
        ) {
            continue;
        }
        let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) else { continue };
        map.append(name, value);
    }
    if let Some(key) = key.filter(|k| !k.is_empty()) {
        let mut value = HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| "the device key is not valid".to_string())?;
        value.set_sensitive(true);
        map.insert(AUTHORIZATION, value);
    }
    Ok(map)
}

/// What the page hears about one request, in order: the head, the body in pieces, then the end (or an error).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HomeEvent {
    Head { status: u16, headers: Vec<(String, String)> },
    Data { b64: String },
    End,
    /// `unsent`: the request never reached the hub (no connection), so the page may send it again another way.
    Error { message: String, unsent: bool },
}

/// Whether the handshake failed on the certificate (not the pinned one, or not signed with its key).
fn certificate_refused(e: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cur {
        if let Some(r) = err.downcast_ref::<rustls::Error>() {
            return matches!(r, rustls::Error::InvalidCertificate(_));
        }
        // An io::Error's source skips the error it wraps (one io::Error can wrap another), so that one comes next.
        cur = match err.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()) {
            Some(inner) => Some(inner as &(dyn std::error::Error + 'static)),
            None => err.source(),
        };
    }
    false
}

fn plain(e: &reqwest::Error) -> String {
    if certificate_refused(e) {
        "the hub on the home network did not show its own certificate".into()
    } else if e.is_timeout() {
        "the hub did not answer on the home network in time".into()
    } else if e.is_connect() {
        "could not connect to the hub on the home network".into()
    } else {
        "the connection to the hub on the home network broke off".into()
    }
}

pub struct Prepared {
    pub url: reqwest::Url,
    pub method: reqwest::Method,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    pub total: Option<Duration>,
}

/// Sends one request and streams the answer to `emit`. An error says whether the request never left.
pub async fn run(client: reqwest::Client, req: Prepared, emit: &(dyn Fn(HomeEvent) -> Result<(), String> + Sync)) -> Result<(), (String, bool)> {
    let mut rb = client.request(req.method, req.url).headers(req.headers);
    if !req.body.is_empty() {
        rb = rb.body(req.body);
    }
    if let Some(t) = req.total {
        rb = rb.timeout(t);
    }
    let mut res = rb.send().await.map_err(|e| (plain(&e), e.is_connect()))?;
    let headers = res
        .headers()
        .iter()
        .filter(|(k, _)| **k != TRANSFER_ENCODING && **k != CONNECTION)
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
        .collect();
    emit(HomeEvent::Head { status: res.status().as_u16(), headers }).map_err(|e| (e, false))?;
    while let Some(chunk) = res.chunk().await.map_err(|e| (plain(&e), false))? {
        emit(HomeEvent::Data { b64: base64::engine::general_purpose::STANDARD.encode(&chunk) }).map_err(|e| (e, false))?;
    }
    emit(HomeEvent::End).map_err(|e| (e, false))
}

/// Whether the hub answers `GET /health` at `base` with the pinned certificate within `limit`. No key goes with it.
pub async fn probe(client: &reqwest::Client, base: reqwest::Url, limit: Duration) -> bool {
    let limit = limit.clamp(Duration::from_millis(100), PROBE_MAX);
    let Ok(target) = base.join("/health") else { return false };
    matches!(tokio::time::timeout(limit, client.get(target).timeout(limit).send()).await, Ok(Ok(r)) if r.status().is_success())
}

/// One pinned client per pin, so its connection is kept between requests; and the requests running now.
#[derive(Default)]
pub struct Home {
    clients: Mutex<HashMap<Pin, reqwest::Client>>,
    running: Mutex<HashMap<u64, AbortHandle>>,
}

impl Home {
    fn client(&self, pin: Pin) -> Result<reqwest::Client, String> {
        let mut clients = self.clients.lock().map_err(|_| "the home network connection is not available".to_string())?;
        if let Some(c) = clients.get(&pin) {
            return Ok(c.clone());
        }
        let c = pinned_client(pin)?;
        clients.insert(pin, c.clone());
        Ok(c)
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn home_fetch(
    home: tauri::State<'_, Arc<Home>>,
    id: u64,
    url: String,
    fp: String,
    key: Option<String>,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    on_event: Channel<HomeEvent>,
) -> Result<(), String> {
    let pin = parse_pin(&fp).ok_or("the hub's home certificate is not known")?;
    let url = home_url(&url)?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "bad request method".to_string())?;
    let body = match body {
        Some(b) => base64::engine::general_purpose::STANDARD.decode(b).map_err(|_| "bad request body".to_string())?,
        None => Vec::new(),
    };
    // Live updates stay open for good: only silence ends them.
    let stream = headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("accept") && v.contains("text/event-stream"));
    let total = (!stream).then(|| timeout_ms.map(Duration::from_millis).unwrap_or(TOTAL).clamp(Duration::from_secs(1), TOTAL_MAX));
    let headers = request_headers(&headers, key.as_deref())?;
    let client = home.client(pin)?;
    let home = home.inner().clone();
    let task = tokio::spawn(async move {
        let emit = |ev: HomeEvent| on_event.send(ev).map_err(|e| e.to_string());
        if let Err((message, unsent)) = run(client, Prepared { url, method, headers, body, total }, &emit).await {
            let _ = on_event.send(HomeEvent::Error { message, unsent });
        }
    });
    if let Ok(mut r) = home.running.lock() {
        r.insert(id, task.abort_handle());
    }
    let _ = task.await;
    if let Ok(mut r) = home.running.lock() {
        r.remove(&id);
    }
    Ok(())
}

/// The page stopped waiting: the request is dropped, which closes its connection.
#[tauri::command]
pub fn home_cancel(home: tauri::State<'_, Arc<Home>>, id: u64) {
    if let Some(h) = home.running.lock().ok().and_then(|mut r| r.remove(&id)) {
        h.abort();
    }
}

#[tauri::command]
pub async fn home_probe(home: tauri::State<'_, Arc<Home>>, url: String, fp: String, timeout_ms: u64) -> Result<bool, String> {
    let pin = parse_pin(&fp).ok_or("the hub's home certificate is not known")?;
    let base = home_url(&url)?;
    let client = home.client(pin)?;
    Ok(probe(&client, base, Duration::from_millis(timeout_ms)).await)
}

/// Bonjour: the addresses where the hub with this pin announces itself now, listening at most `timeout_ms`.
#[tauri::command]
pub async fn home_browse(fp: String, timeout_ms: u64) -> Result<Vec<String>, String> {
    let pin = parse_pin(&fp).ok_or("the hub's home certificate is not known")?;
    let wait = Duration::from_millis(timeout_ms).clamp(Duration::from_millis(200), BROWSE_MAX);
    tokio::task::spawn_blocking(move || browse(pin, wait)).await.map_err(|e| e.to_string())?
}

fn browse(pin: Pin, wait: Duration) -> Result<Vec<String>, String> {
    use mdns_sd::{IfKind, ServiceDaemon, ServiceEvent};
    let mdns = ServiceDaemon::new().map_err(|e| format!("Bonjour could not start ({e})"))?;
    // IPv4 only: the hub announces its IPv4 home address, and an IPv6 link-local one cannot go in an address.
    let _ = mdns.disable_interface(IfKind::IPv6);
    let found = match mdns.browse(SERVICE) {
        Ok(rx) => {
            let deadline = Instant::now() + wait;
            let mut found = Vec::new();
            while found.is_empty() {
                let Some(left) = deadline.checked_duration_since(Instant::now()) else { break };
                match rx.recv_timeout(left) {
                    Ok(ServiceEvent::ServiceResolved(s)) => {
                        found = announced(s.get_property_val_str("fp"), &pin, s.get_addresses().iter().map(|a| a.to_ip_addr()), s.get_port());
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let _ = mdns.stop_browse(SERVICE);
            Ok(found)
        }
        Err(e) => Err(format!("Bonjour could not look for the hub ({e})")),
    };
    let _ = mdns.shutdown();
    found
}

/// The addresses an announcement names, as https addresses, when its fingerprint is the pin. Only private IPv4
/// addresses: the hub's home listener takes nothing else.
pub fn announced(fp: Option<&str>, pin: &Pin, addrs: impl Iterator<Item = IpAddr>, port: u16) -> Vec<String> {
    if port == 0 || fp.and_then(parse_pin).as_ref() != Some(pin) {
        return Vec::new();
    }
    let mut v4: Vec<Ipv4Addr> = addrs
        .filter_map(|a| match a {
            IpAddr::V4(a) if a.is_private() || a.is_link_local() => Some(a),
            _ => None,
        })
        .collect();
    v4.sort();
    v4.dedup();
    v4.into_iter().map(|a| format!("https://{a}:{port}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
    use std::sync::Mutex as StdMutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn provider() -> Arc<CryptoProvider> {
        Arc::new(rustls::crypto::ring::default_provider())
    }

    /// A certificate as the hub makes its own (EC P-256, self-signed), and its key.
    fn cert() -> (CertificateDer<'static>, Vec<u8>) {
        let c = rcgen::generate_simple_self_signed(vec!["aeneas-test.local".to_string()]).unwrap();
        (c.cert.der().clone(), c.signing_key.serialize_der())
    }

    fn hex(pin: &Pin) -> String {
        pin.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn dss(scheme: SignatureScheme, sig: &[u8]) -> DigitallySignedStruct {
        use rustls::internal::msgs::codec::{Codec, Reader};
        let mut bytes = u16::from(scheme).to_be_bytes().to_vec();
        bytes.extend_from_slice(&(sig.len() as u16).to_be_bytes());
        bytes.extend_from_slice(sig);
        DigitallySignedStruct::read(&mut Reader::init(&bytes)).unwrap()
    }

    fn sign(pkcs8: &[u8], msg: &[u8]) -> Vec<u8> {
        let rng = ring::rand::SystemRandom::new();
        let key = ring::signature::EcdsaKeyPair::from_pkcs8(&ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8, &rng).unwrap();
        key.sign(&rng, msg).unwrap().as_ref().to_vec()
    }

    #[test]
    fn a_pin_is_read_as_the_hub_writes_it() {
        let pin = [0xabu8; 32];
        assert_eq!(parse_pin(&hex(&pin)), Some(pin));
        assert_eq!(parse_pin(&hex(&pin).to_uppercase()), Some(pin));
        let colons = pin.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":");
        assert_eq!(parse_pin(&colons), Some(pin));
        assert_eq!(parse_pin(&hex(&pin)[..62]), None);
        assert_eq!(parse_pin(&format!("{}zz", &hex(&pin)[..62])), None);
        assert_eq!(parse_pin(&format!("+f{}", &hex(&pin)[2..])), None);
        assert_eq!(parse_pin(&format!("é{}", &hex(&pin)[2..])), None);
        assert_eq!(parse_pin(""), None);
    }

    #[test]
    fn only_the_pinned_certificate_is_accepted() {
        let (a, _) = cert();
        let (b, _) = cert();
        let v = PinnedLeaf::new(sha256(&a), provider());
        let name = ServerName::try_from("192.168.1.20").unwrap();
        assert!(v.verify_server_cert(&a, &[], &name, &[], UnixTime::now()).is_ok());
        assert!(v.verify_server_cert(&b, &[], &name, &[], UnixTime::now()).is_err());
        // The pinned certificate sent beside another leaf does not make that leaf acceptable.
        assert!(v.verify_server_cert(&b, std::slice::from_ref(&a), &name, &[], UnixTime::now()).is_err());
        // Any name or none: the pin is what counts.
        let other = ServerName::try_from("hub.example").unwrap();
        assert!(v.verify_server_cert(&a, &[], &other, &[], UnixTime::now()).is_ok());
    }

    #[test]
    fn handshake_signatures_are_still_checked() {
        let (der, key) = cert();
        let (_, other_key) = cert();
        let v = PinnedLeaf::new(sha256(&der), provider());
        let msg = b"the transcript a server signs in a handshake";
        let good = sign(&key, msg);
        let scheme = SignatureScheme::ECDSA_NISTP256_SHA256;
        assert!(v.verify_tls13_signature(msg, &der, &dss(scheme, &good)).is_ok());
        assert!(v.verify_tls12_signature(msg, &der, &dss(scheme, &good)).is_ok());
        // Signed with another key over the pinned certificate: refused.
        let forged = sign(&other_key, msg);
        assert!(v.verify_tls13_signature(msg, &der, &dss(scheme, &forged)).is_err());
        assert!(v.verify_tls12_signature(msg, &der, &dss(scheme, &forged)).is_err());
        // The right signature over another message: refused.
        assert!(v.verify_tls13_signature(b"something else", &der, &dss(scheme, &good)).is_err());
        assert!(v.supported_verify_schemes().contains(&scheme));
    }

    #[test]
    fn only_https_home_addresses() {
        assert!(home_url("https://192.168.1.20:8788").is_ok());
        assert!(home_url("http://192.168.1.20:8788").is_err());
        assert!(home_url("iroh://abc").is_err());
        assert!(home_url("https://user:pw@192.168.1.20:8788").is_err());
        assert!(home_url("not an address").is_err());
    }

    #[test]
    fn the_key_goes_in_only_from_rust() {
        let page = vec![
            ("Authorization".to_string(), "Bearer from-the-page".to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Host".to_string(), "elsewhere".to_string()),
            ("X-Bad".to_string(), "a\r\nInjected: 1".to_string()),
        ];
        let h = request_headers(&page, None).unwrap();
        assert!(h.get(AUTHORIZATION).is_none());
        assert!(h.get("host").is_none());
        assert!(h.get("x-bad").is_none());
        assert_eq!(h.get("content-type").unwrap(), "application/json");
        let h = request_headers(&page, Some("ead1_test")).unwrap();
        assert_eq!(h.get(AUTHORIZATION).unwrap(), "Bearer ead1_test");
        assert!(h.get(AUTHORIZATION).unwrap().is_sensitive());
        assert!(request_headers(&[], Some("bad\r\nkey")).is_err());
    }

    #[test]
    fn bonjour_answers_count_only_with_the_pin() {
        let pin = [7u8; 32];
        let addrs = || vec!["192.168.1.20".parse().unwrap(), "100.64.1.2".parse().unwrap(), "8.8.8.8".parse().unwrap(), "fe80::1".parse().unwrap(), "192.168.1.20".parse().unwrap()].into_iter();
        assert_eq!(announced(Some(&hex(&pin)), &pin, addrs(), 8788), vec!["https://192.168.1.20:8788".to_string()]);
        assert!(announced(Some(&hex(&[8u8; 32])), &pin, addrs(), 8788).is_empty());
        assert!(announced(None, &pin, addrs(), 8788).is_empty());
        assert!(announced(Some(&hex(&pin)), &pin, addrs(), 0).is_empty());
    }

    #[derive(Debug)]
    struct Fixed(Arc<rustls::sign::CertifiedKey>);
    impl rustls::server::ResolvesServerCert for Fixed {
        fn resolve(&self, _hello: rustls::server::ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
            Some(self.0.clone())
        }
    }

    /// A one-request HTTPS server on this machine's loopback that presents `cert` and signs with `key` (which need not
    /// belong to it). It answers `{"ok":true}`, or a request's body back as bytes, and hands back the request it read
    /// (head and body), or None when no request arrived.
    async fn serve_once(cert: CertificateDer<'static>, key: Vec<u8>) -> (u16, tokio::task::JoinHandle<Option<String>>) {
        let p = provider();
        let signing = p.key_provider.load_private_key(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key))).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(p)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(Fixed(Arc::new(rustls::sign::CertifiedKey::new(vec![cert], signing)))));
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.ok()?;
            let mut tls = acceptor.accept(tcp).await.ok()?;
            let mut got = Vec::new();
            let mut buf = vec![0u8; 8192];
            let head_end = loop {
                if let Some(i) = got.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
                let n = tls.read(&mut buf).await.ok()?;
                if n == 0 {
                    return None;
                }
                got.extend_from_slice(&buf[..n]);
            };
            let head = String::from_utf8_lossy(&got[..head_end]).to_ascii_lowercase();
            let length = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
            while got.len() < head_end + length {
                let n = tls.read(&mut buf).await.ok()?;
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
            }
            let body = &got[head_end..];
            let answer = if body.is_empty() {
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}".to_vec()
            } else {
                let mut a = format!("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                a.extend_from_slice(body);
                a
            };
            let _ = tls.write_all(&answer).await;
            let _ = tls.shutdown().await;
            Some(String::from_utf8_lossy(&got).to_string())
        });
        (port, task)
    }

    fn get(port: u16, key: Option<&str>) -> Prepared {
        Prepared {
            url: home_url(&format!("https://127.0.0.1:{port}/health")).unwrap(),
            method: reqwest::Method::GET,
            headers: request_headers(&[("Authorization".into(), "Bearer from-the-page".into())], key).unwrap(),
            body: Vec::new(),
            total: Some(Duration::from_secs(5)),
        }
    }

    async fn fetch(pin: Pin, req: Prepared) -> (Vec<HomeEvent>, Result<(), (String, bool)>) {
        let events = StdMutex::new(Vec::new());
        let emit = |ev: HomeEvent| {
            events.lock().unwrap().push(ev);
            Ok(())
        };
        let r = run(pinned_client(pin).unwrap(), req, &emit).await;
        (events.into_inner().unwrap(), r)
    }

    #[tokio::test]
    async fn the_pinned_hub_gets_the_key_over_tls() {
        let (der, key) = cert();
        let pin = sha256(&der);
        let (port, server) = serve_once(der, key).await;
        let (events, r) = fetch(pin, get(port, Some("ead1_test"))).await;
        assert!(r.is_ok(), "{r:?}");
        assert!(matches!(&events[0], HomeEvent::Head { status: 200, .. }));
        let body: Vec<u8> = events
            .iter()
            .filter_map(|e| match e {
                HomeEvent::Data { b64 } => Some(base64::engine::general_purpose::STANDARD.decode(b64).unwrap()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(body, b"{\"ok\":true}");
        assert_eq!(events.last(), Some(&HomeEvent::End));
        let seen = server.await.unwrap().expect("the request arrived");
        assert!(seen.to_ascii_lowercase().contains("authorization: bearer ead1_test\r\n"), "{seen}");
        assert!(!seen.contains("from-the-page"));
    }

    #[tokio::test]
    async fn binary_bodies_go_both_ways() {
        let (der, key) = cert();
        let pin = sha256(&der);
        let (port, server) = serve_once(der, key).await;
        let bytes: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
        let req = Prepared {
            url: home_url(&format!("https://127.0.0.1:{port}/images/library")).unwrap(),
            method: reqwest::Method::POST,
            headers: request_headers(&[("Content-Type".into(), "image/png".into())], Some("ead1_test")).unwrap(),
            body: bytes.clone(),
            total: Some(Duration::from_secs(5)),
        };
        let (events, r) = fetch(pin, req).await;
        assert!(r.is_ok(), "{r:?}");
        let back: Vec<u8> = events
            .iter()
            .filter_map(|e| match e {
                HomeEvent::Data { b64 } => Some(base64::engine::general_purpose::STANDARD.decode(b64).unwrap()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(back, bytes);
        let seen = server.await.unwrap().unwrap().to_ascii_lowercase();
        assert!(seen.starts_with("post /images/library http/1.1\r\n"));
        assert!(seen.contains("content-type: image/png\r\n"));
    }

    #[tokio::test]
    async fn another_certificate_never_sees_the_key() {
        let (der, key) = cert();
        let (pinned, _) = cert();
        let (port, server) = serve_once(der, key).await;
        let (events, r) = fetch(sha256(&pinned), get(port, Some("ead1_test"))).await;
        let (message, unsent) = r.unwrap_err();
        assert!(unsent, "a refused handshake sent nothing");
        assert_eq!(message, "the hub on the home network did not show its own certificate");
        assert!(events.is_empty());
        assert_eq!(server.await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_copy_of_the_certificate_without_its_key_gets_nowhere() {
        let (der, _) = cert();
        let (_, wrong_key) = cert();
        let pin = sha256(&der);
        let (port, server) = serve_once(der, wrong_key).await;
        let (_, r) = fetch(pin, get(port, Some("ead1_test"))).await;
        let (message, unsent) = r.unwrap_err();
        assert!(unsent);
        assert_eq!(message, "the hub on the home network did not show its own certificate");
        assert_eq!(server.await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_probe_says_yes_only_for_the_pinned_hub() {
        let (der, key) = cert();
        let pin = sha256(&der);
        let (port, server) = serve_once(der.clone(), key.clone()).await;
        let base = home_url(&format!("https://127.0.0.1:{port}")).unwrap();
        assert!(probe(&pinned_client(pin).unwrap(), base, Duration::from_millis(1500)).await);
        let seen = server.await.unwrap().unwrap();
        assert!(seen.starts_with("GET /health HTTP/1.1\r\n"), "{seen}");
        assert!(!seen.to_ascii_lowercase().contains("authorization"), "a probe carries no key");

        let (port, _server) = serve_once(der, key).await;
        let base = home_url(&format!("https://127.0.0.1:{port}")).unwrap();
        assert!(!probe(&pinned_client([1u8; 32]).unwrap(), base, Duration::from_millis(1500)).await);
        // Nothing listening: no, within the time asked for.
        let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let base = home_url(&format!("https://127.0.0.1:{free}")).unwrap();
        let started = Instant::now();
        assert!(!probe(&pinned_client(pin).unwrap(), base, Duration::from_millis(1500)).await);
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
