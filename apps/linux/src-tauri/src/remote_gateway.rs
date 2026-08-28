use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Url;

const DEFAULT_GATEWAY_PORT: u16 = 18789;
const TUNNEL_READY_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) struct SshTunnel {
    child: Child,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteGatewayRequest {
    pub transport: String,
    pub url: Option<String>,
    pub ssh_target: Option<String>,
    pub token: Option<String>,
    pub password: Option<String>,
    pub remote_port: Option<u16>,
    pub tls_fingerprint: Option<String>,
}

pub(crate) fn normalize_gateway_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| {
        "Enter a valid Gateway URL, such as https://gateway.example.com.".to_string()
    })?;
    match url.scheme() {
        "http" => url
            .set_scheme("ws")
            .map_err(|_| "Gateway URL could not be normalized.".to_string())?,
        "https" => url
            .set_scheme("wss")
            .map_err(|_| "Gateway URL could not be normalized.".to_string())?,
        "ws" | "wss" => {}
        _ => return Err("Gateway URL must use http://, https://, ws://, or wss://.".to_string()),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Gateway URL must include a hostname.".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Gateway URL must not include credentials, query parameters, or fragments.".to_string(),
        );
    }
    if url.scheme() == "ws" && !is_private_host(host) {
        return Err(
            "Public Gateway hosts require HTTPS or WSS. Plaintext is limited to trusted local and private networks.".to_string(),
        );
    }
    Ok(url)
}

fn is_private_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") || host.ends_with(".ts.net") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            let [first, second, _, _] = address.octets();
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || (first == 100 && (64..=127).contains(&second))
        }
        Ok(IpAddr::V6(address)) => {
            let first = address.segments()[0];
            address.is_loopback() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
        }
        Err(_) => false,
    }
}

pub(crate) fn validate_ssh_target(raw: &str) -> Result<(String, u16), String> {
    let value = raw.trim();
    let invalid = || {
        "Enter a valid SSH target such as operator@gateway.example.com or operator@host:2222."
            .to_string()
    };
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || value.starts_with('-')
        || value.matches('@').count() > 1
    {
        return Err(invalid());
    }
    let (user, host_port) = value
        .split_once('@')
        .map_or((None, value), |(user, host)| (Some(user), host));
    if user.is_some_and(|user| user.is_empty() || user.starts_with('-'))
        || host_port.is_empty()
        || host_port.starts_with('-')
    {
        return Err(invalid());
    }
    let (host, port) = if let Some((host, raw_port)) = host_port.rsplit_once(':') {
        if host.is_empty() || raw_port.is_empty() {
            return Err(invalid());
        }
        let port = raw_port.parse::<u16>().map_err(|_| invalid())?;
        if port == 0 {
            return Err(invalid());
        }
        (host, port)
    } else {
        (host_port, 22)
    };
    if host.starts_with('-') || host.starts_with(':') || host.ends_with(':') || host.contains('@') {
        return Err(invalid());
    }
    let target = user.map_or_else(|| host.to_string(), |user| format!("{user}@{host}"));
    Ok((target, port))
}

pub(crate) fn config_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("OPENCLAW_CONFIG_PATH").filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let state_dir = env::var_os("OPENCLAW_STATE_DIR")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| crate::cli::openclaw_home().map_err(|error| error.to_string()))?;
    Ok(state_dir.join("openclaw.json"))
}

fn read_config(path: &Path) -> Result<Option<Value>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not inspect OpenClaw configuration: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("OpenClaw configuration must be a regular file, not a symlink.".to_string());
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read OpenClaw configuration: {error}"))?;
    let value: Value = tauri_utils::config::parse::parse_json5_value(&raw, path).map_err(|_| {
        "OpenClaw configuration is not valid JSON5. Run `openclaw doctor --fix`, then try again."
            .to_string()
    })?;
    if !value.is_object() {
        return Err("OpenClaw configuration must contain a JSON object.".to_string());
    }
    Ok(Some(value))
}

pub(crate) fn has_configured_gateway() -> Result<bool, String> {
    let Some(root) = read_config(&config_path()?)? else {
        return Ok(false);
    };
    Ok(root
        .get("gateway")
        .and_then(Value::as_object)
        .is_some_and(|gateway| !gateway.is_empty()))
}

fn valid_secret_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    !value.is_empty()
        && value.len() <= 128
        && bytes.next().is_some_and(|byte| byte.is_ascii_uppercase())
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_secret_provider(value: &str) -> bool {
    let mut bytes = value.bytes();
    !value.is_empty()
        && value.len() <= 64
        && bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn file_secret(
    reference: &Map<String, Value>,
    provider: &Map<String, Value>,
) -> Result<String, ()> {
    let id = reference.get("id").and_then(Value::as_str).ok_or(())?;
    if id != "value"
        && (!id.starts_with('/')
            || id
                .as_bytes()
                .windows(2)
                .any(|pair| pair[0] == b'~' && pair[1] != b'0' && pair[1] != b'1')
            || id.ends_with('~'))
    {
        return Err(());
    }
    let configured_path = provider.get("path").and_then(Value::as_str).ok_or(())?;
    let path = if let Some(relative) = configured_path.strip_prefix("~/") {
        PathBuf::from(env::var_os("HOME").ok_or(())?).join(relative)
    } else {
        PathBuf::from(configured_path)
    };
    if !path.is_absolute() {
        return Err(());
    }
    let inspected = fs::symlink_metadata(&path).map_err(|_| ())?;
    if inspected.file_type().is_symlink() || !inspected.is_file() {
        return Err(());
    }
    let file = fs::File::open(&path).map_err(|_| ())?;
    let opened = file.metadata().map_err(|_| ())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if inspected.dev() != opened.dev()
            || inspected.ino() != opened.ino()
            || opened.mode() & 0o077 != 0
        {
            return Err(());
        }
        #[cfg(target_os = "linux")]
        if opened.uid() != unsafe { libc::geteuid() } {
            return Err(());
        }
    }
    let max_bytes = provider
        .get("maxBytes")
        .map(|value| {
            value
                .as_u64()
                .filter(|limit| *limit > 0 && *limit <= 20 * 1024 * 1024)
        })
        .unwrap_or(Some(1024 * 1024))
        .ok_or(())?;
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > max_bytes {
        return Err(());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| ())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    match provider
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("json")
    {
        "singleValue" if id == "value" => Ok(text
            .strip_suffix("\r\n")
            .or_else(|| text.strip_suffix('\n'))
            .unwrap_or(text)
            .to_string()),
        "json" if id.starts_with('/') => {
            let payload: Value = serde_json::from_str(text).map_err(|_| ())?;
            payload
                .as_object()
                .and_then(|_| payload.pointer(id))
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or(())
        }
        _ => Err(()),
    }
}

fn configured_secret(
    value: Option<&Value>,
    label: &str,
    root: &Value,
) -> Result<Option<String>, String> {
    let unavailable = || {
        format!(
            "Gateway {label} secret reference could not be resolved. Check its provider, permissions, and configured value."
        )
    };
    let reference;
    let value = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            let shorthand = trimmed
                .strip_prefix("${")
                .and_then(|name| name.strip_suffix('}'))
                .or_else(|| trimmed.strip_prefix('$'));
            let Some(id) = shorthand.filter(|name| valid_secret_name(name)) else {
                return Ok(normalize_optional(Some(value.clone())));
            };
            reference = json!({
                "source": "env",
                "provider": root.pointer("/secrets/defaults/env")
                    .and_then(Value::as_str)
                    .unwrap_or("default"),
                "id": id,
            });
            reference.as_object().ok_or_else(unavailable)?
        }
        Some(Value::Object(value)) => value,
        Some(_) => return Err(unavailable()),
    };
    let source = value
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(unavailable)?;
    let provider_name = value
        .get("provider")
        .and_then(Value::as_str)
        .or_else(|| {
            root.pointer(&format!("/secrets/defaults/{source}"))?
                .as_str()
        })
        .unwrap_or("default");
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(unavailable)?;
    if !valid_secret_provider(provider_name) {
        return Err(unavailable());
    }
    let configured_provider = root
        .pointer("/secrets/providers")
        .and_then(Value::as_object)
        .and_then(|providers| providers.get(provider_name))
        .and_then(Value::as_object);
    match source {
        "env" => {
            if !valid_secret_name(id) {
                return Err(unavailable());
            }
            let default_provider = root
                .pointer("/secrets/defaults/env")
                .and_then(Value::as_str)
                .unwrap_or("default");
            let provider = configured_provider.filter(|provider| {
                provider.get("source").and_then(Value::as_str) == Some("env")
            });
            if provider.is_none() && provider_name != default_provider {
                return Err(unavailable());
            }
            if let Some(allowlist) = provider.and_then(|provider| provider.get("allowlist")) {
                if !allowlist
                    .as_array()
                    .is_some_and(|values| values.iter().any(|allowed| allowed.as_str() == Some(id)))
                {
                    return Err(unavailable());
                }
            }
            env::var(id)
                .ok()
                .filter(|value| !value.is_empty())
                .map(Some)
                .ok_or_else(unavailable)
        }
        "file" => {
            let provider = configured_provider
                .filter(|provider| provider.get("source").and_then(Value::as_str) == Some("file"))
                .ok_or_else(unavailable)?;
            file_secret(value, provider)
                .ok()
                .filter(|secret| !secret.trim().is_empty())
                .map(Some)
                .ok_or_else(unavailable)
        }
        "exec" | "store" => Err(format!(
            "Gateway {label} uses a {source} secret provider that requires the Gateway secrets runtime. Configure an environment-backed or private file-backed secret for this desktop."
        )),
        _ => Err(unavailable()),
    }
}

fn configured_tls_fingerprint(remote: &Map<String, Value>) -> Result<Option<String>, String> {
    match remote.get("tlsFingerprint") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if value.trim().len() == 64
                && value.trim().bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            Ok(Some(value.trim().to_string()))
        }
        Some(_) => Err("Gateway TLS fingerprint must be 64 hexadecimal characters.".to_string()),
    }
}

pub(crate) fn resolve_remote_tls_fingerprint(
    request: &mut RemoteGatewayRequest,
    gateway_url: &Url,
) -> Result<(), String> {
    if let Some(fingerprint) = &request.tls_fingerprint {
        let value = fingerprint.trim();
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Gateway TLS fingerprint must be 64 hexadecimal characters.".to_string());
        }
        request.tls_fingerprint = Some(value.to_string());
        return Ok(());
    }
    let Some(root) = read_config(&config_path()?)? else {
        return Ok(());
    };
    let Some(remote) = root.pointer("/gateway/remote").and_then(Value::as_object) else {
        return Ok(());
    };
    let previous_url = remote
        .get("url")
        .and_then(Value::as_str)
        .map(normalize_gateway_url)
        .transpose()?;
    let same_endpoint = previous_url.as_ref() == Some(gateway_url)
        && remote
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("direct")
            == request.transport
        && (request.transport != "ssh"
            || remote.get("sshTarget").and_then(Value::as_str) == request.ssh_target.as_deref());
    if same_endpoint {
        request.tls_fingerprint = configured_tls_fingerprint(remote)?;
    }
    Ok(())
}

pub(crate) fn load_saved_remote() -> Result<Option<RemoteGatewayRequest>, String> {
    load_saved_remote_at(&config_path()?)
}

fn load_saved_remote_at(path: &Path) -> Result<Option<RemoteGatewayRequest>, String> {
    let Some(root) = read_config(path)? else {
        return Ok(None);
    };
    let Some(gateway) = root.get("gateway").and_then(Value::as_object) else {
        return Ok(None);
    };
    if gateway.get("mode").and_then(Value::as_str) != Some("remote") {
        return Ok(None);
    }
    let remote = gateway
        .get("remote")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "Remote Gateway configuration is missing its connection settings.".to_string()
        })?;
    let url = remote
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "Remote Gateway configuration is missing its URL.".to_string())?;
    let transport = remote
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("direct")
        .to_string();
    let remote_port = remote
        .get("remotePort")
        .and_then(Value::as_u64)
        .map(|port| u16::try_from(port).map_err(|_| "Remote Gateway port is invalid.".to_string()))
        .transpose()?;
    Ok(Some(RemoteGatewayRequest {
        transport,
        url: Some(url.to_string()),
        ssh_target: remote
            .get("sshTarget")
            .and_then(Value::as_str)
            .map(str::to_string),
        token: configured_secret(remote.get("token"), "token", &root)?,
        password: configured_secret(remote.get("password"), "password", &root)?,
        remote_port,
        tls_fingerprint: configured_tls_fingerprint(remote)?,
    }))
}

fn ensure_private_parent(parent: &Path) -> Result<(), String> {
    if !parent.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(parent).map_err(|error| {
            format!("Could not create OpenClaw configuration directory: {error}")
        })?;
    }
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| format!("Could not inspect OpenClaw configuration directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("OpenClaw configuration directory must not be a symlink.".to_string());
    }
    Ok(())
}

pub(crate) fn save_config_at(
    path: &Path,
    request: &RemoteGatewayRequest,
    gateway_url: &Url,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "OpenClaw configuration path has no parent directory.".to_string())?;
    ensure_private_parent(parent)?;
    let mut root = read_config(path)?.unwrap_or_else(|| json!({}));
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| "OpenClaw configuration must contain a JSON object.".to_string())?;
    let gateway = root_object
        .entry("gateway")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "OpenClaw Gateway configuration must contain a JSON object.".to_string())?;
    gateway.insert("mode".to_string(), json!("remote"));
    let old_remote = gateway
        .get("remote")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let same_endpoint = old_remote.get("url").and_then(Value::as_str) == Some(gateway_url.as_str())
        && old_remote.get("sshTarget").and_then(Value::as_str) == request.ssh_target.as_deref();
    let mut remote = if same_endpoint {
        old_remote
    } else {
        Map::new()
    };
    remote.insert("url".to_string(), json!(gateway_url.as_str()));
    remote.insert("transport".to_string(), json!(request.transport));
    if let Some(fingerprint) = &request.tls_fingerprint {
        remote.insert("tlsFingerprint".to_string(), json!(fingerprint));
    }
    if request.transport == "ssh" {
        remote.insert("sshTarget".to_string(), json!(request.ssh_target));
        remote.insert(
            "remotePort".to_string(),
            json!(request.remote_port.unwrap_or(DEFAULT_GATEWAY_PORT)),
        );
    } else {
        remote.remove("sshTarget");
        remote.remove("sshIdentity");
        remote.remove("remotePort");
        remote.remove("sshHostKeyPolicy");
    }
    if let Some(token) = normalize_optional(request.token.clone()) {
        remote.remove("password");
        remote.insert("token".to_string(), json!(token));
    } else if let Some(password) = normalize_optional(request.password.clone()) {
        remote.remove("token");
        remote.insert("password".to_string(), json!(password));
    }
    gateway.insert("remote".to_string(), Value::Object(remote));

    let temporary = parent.join(format!(
        ".openclaw-config-{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Could not prepare secure OpenClaw configuration: {error}"))?;
    let result = (|| {
        serde_json::to_writer_pretty(&mut file, &root)
            .map_err(|error| format!("Could not serialize OpenClaw configuration: {error}"))?;
        file.write_all(b"\n")
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Could not save OpenClaw configuration: {error}"))?;
        if path.exists() {
            let metadata = fs::symlink_metadata(path)
                .map_err(|error| format!("Could not verify OpenClaw configuration: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("OpenClaw configuration must remain a regular file.".to_string());
            }
        }
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not replace OpenClaw configuration: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("Could not secure OpenClaw configuration: {error}"))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn validate_request(request: &RemoteGatewayRequest) -> Result<(), String> {
    if request.transport != "direct" && request.transport != "ssh" {
        return Err("Choose a direct connection or an SSH tunnel.".to_string());
    }
    if normalize_optional(request.token.clone()).is_some()
        && normalize_optional(request.password.clone()).is_some()
    {
        return Err("Enter either a Gateway token or password, not both.".to_string());
    }
    if request.remote_port == Some(0) {
        return Err("Gateway port must be between 1 and 65535.".to_string());
    }
    Ok(())
}

fn available_port(preferred: u16, target: &str) -> Result<u16, String> {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return Ok(preferred);
    }
    let digest = Sha256::digest(target.as_bytes());
    let seed = u16::from_be_bytes([digest[0], digest[1]]);
    for offset in 0..32_u16 {
        let candidate = 49152 + (seed.wrapping_add(offset) % 16384);
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return Ok(candidate);
        }
    }
    Err("No local loopback port is available for the SSH tunnel.".to_string())
}

pub(crate) fn start_tunnel(
    request: &RemoteGatewayRequest,
    saved_url: Option<&Url>,
) -> Result<(SshTunnel, Url), String> {
    let raw_target = request
        .ssh_target
        .as_deref()
        .ok_or_else(|| "Enter the SSH host running your Gateway.".to_string())?;
    let (target, ssh_port) = validate_ssh_target(raw_target)?;
    let remote_port = request.remote_port.unwrap_or(DEFAULT_GATEWAY_PORT);
    let local_port = match saved_url.and_then(Url::port) {
        Some(port) if TcpListener::bind(("127.0.0.1", port)).is_err() => {
            return Err(format!(
                "The saved SSH Gateway port {port} is already in use. Close its other listener before reconnecting so your existing device and onboarding session remain intact."
            ));
        }
        Some(port) => port,
        None => available_port(remote_port, raw_target)?,
    };
    let executable = ["/usr/bin/ssh", "/bin/ssh"]
        .iter()
        .find(|candidate| Path::new(candidate).is_file())
        .ok_or_else(|| {
            "OpenSSH is not installed. Install your system's OpenSSH client.".to_string()
        })?;

    let mut child = Command::new(executable)
        .args([
            "-N",
            "-L",
            &format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
            "-p",
            &ssh_port.to_string(),
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ControlPersist=no",
            "-o",
            "ForkAfterAuthentication=no",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "--",
            &target,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the SSH tunnel: {error}"))?;
    let deadline = Instant::now() + TUNNEL_READY_TIMEOUT;
    loop {
        if TcpStream::connect_timeout(
            &("127.0.0.1", local_port)
                .to_socket_addrs()
                .map_err(|error| format!("Could not resolve local tunnel: {error}"))?
                .next()
                .ok_or_else(|| "Could not resolve local tunnel.".to_string())?,
            Duration::from_millis(150),
        )
        .is_ok()
        {
            let url = Url::parse(&format!("ws://127.0.0.1:{local_port}"))
                .map_err(|_| "Could not construct local SSH tunnel URL.".to_string())?;
            return Ok((SshTunnel { child }, url));
        }
        if let Some(exit) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect SSH tunnel: {error}"))?
        {
            let output = child
                .wait_with_output()
                .map_err(|error| format!("Could not inspect SSH tunnel failure: {error}"))?;
            let detail = crate::cli::output_tail(&output.stderr)
                .unwrap_or_else(|| format!("SSH exited with {exit}."));
            return Err(format!(
                "SSH connection failed: {detail}. Verify the host key and SSH key authentication."
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "SSH tunnel did not become ready. Verify the host and SSH key.".to_string(),
            );
        }
        thread::sleep(Duration::from_millis(75));
    }
}

pub(crate) fn dashboard_url(gateway_url: &Url, token: Option<&str>) -> Result<Url, String> {
    let mut url = gateway_url.clone();
    let scheme = if gateway_url.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    url.set_scheme(scheme)
        .map_err(|_| "Could not construct Gateway dashboard URL.".to_string())?;
    if let Some(token) = token.filter(|token| !token.is_empty()) {
        let mut fragment = Url::parse("http://localhost/")
            .map_err(|_| "Could not prepare Gateway authentication.".to_string())?;
        fragment.query_pairs_mut().append_pair("token", token);
        url.set_fragment(fragment.query());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn request() -> RemoteGatewayRequest {
        RemoteGatewayRequest {
            transport: "direct".to_string(),
            url: Some("http://192.168.1.25:18789/openclaw".to_string()),
            ssh_target: None,
            token: Some("test-token".to_string()),
            password: None,
            remote_port: None,
            tls_fingerprint: None,
        }
    }

    fn isolated_path() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("openclaw-remote-config-{}", uuid::Uuid::new_v4()))
            .join("openclaw.json")
    }

    #[test]
    fn normalizes_dashboard_and_websocket_urls_without_exposing_auth() {
        assert_eq!(
            normalize_gateway_url("https://gateway.example.com:443/openclaw")
                .expect("TLS URL")
                .as_str(),
            "wss://gateway.example.com/openclaw"
        );
        assert_eq!(
            normalize_gateway_url("http://192.168.1.25:18789/openclaw")
                .expect("private HTTP URL")
                .as_str(),
            "ws://192.168.1.25:18789/openclaw"
        );
        assert!(normalize_gateway_url("http://gateway.example.com:18789").is_err());
        let userinfo = ["user", "fixture"].join(":");
        assert!(normalize_gateway_url(&format!("https://{userinfo}@gateway.example.com")).is_err());
        assert!(normalize_gateway_url("https://gateway.example.com/?token=secret").is_err());
        assert!(normalize_gateway_url("https://gateway.example.com/#token=secret").is_err());
    }

    #[test]
    fn accepts_private_plaintext_hosts_and_rejects_public_hosts() {
        for host in [
            "127.0.0.1",
            "localhost",
            "10.0.0.7",
            "172.16.0.8",
            "192.168.0.9",
            "100.64.0.10",
            "studio.local",
            "studio.example.ts.net",
            "[::1]",
        ] {
            assert!(
                normalize_gateway_url(&format!("ws://{host}:18789")).is_ok(),
                "private host rejected: {host}"
            );
        }
        for host in ["1.2.3.4", "100.128.0.1", "public.example.com"] {
            assert!(
                normalize_gateway_url(&format!("ws://{host}:18789")).is_err(),
                "public plaintext host accepted: {host}"
            );
        }
    }

    #[test]
    fn ssh_target_accepts_optional_port_and_rejects_argument_injection() {
        assert_eq!(
            validate_ssh_target("operator@studio.example:2222").expect("target"),
            ("operator@studio.example".to_string(), 2222)
        );
        assert_eq!(
            validate_ssh_target("studio.local").expect("target"),
            ("studio.local".to_string(), 22)
        );
        for target in [
            "",
            "-oProxyCommand=touch",
            "operator@-unsafe",
            "operator@studio -oProxyCommand=no",
            "operator@@studio",
            "operator@studio:0",
            "operator@studio:65536",
            "operator@studio\n-oControlPath=bad",
        ] {
            assert!(
                validate_ssh_target(target).is_err(),
                "unsafe SSH target accepted: {target:?}"
            );
        }
    }

    #[test]
    fn canonical_remote_config_preserves_unrelated_state_and_replaces_old_auth() {
        let path = isolated_path();
        fs::create_dir_all(path.parent().unwrap()).expect("test directory");
        fs::write(
            &path,
            r#"{"agents":{"defaults":{"workspace":"keep"}},"gateway":{"bind":"loopback","remote":{"url":"ws://127.0.0.1:9","password":"retire"}}}"#,
        )
        .expect("existing config");
        let input = request();
        let url = normalize_gateway_url(input.url.as_deref().unwrap()).expect("gateway URL");

        save_config_at(&path, &input, &url).expect("persist config");

        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("config")).expect("JSON config");
        assert_eq!(saved["agents"]["defaults"]["workspace"], "keep");
        assert_eq!(saved["gateway"]["bind"], "loopback");
        assert_eq!(saved["gateway"]["mode"], "remote");
        assert_eq!(saved["gateway"]["remote"]["transport"], "direct");
        assert_eq!(saved["gateway"]["remote"]["url"], url.as_str());
        assert_eq!(saved["gateway"]["remote"]["token"], "test-token");
        assert!(saved["gateway"]["remote"].get("password").is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path)
                    .expect("config metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(path.parent().unwrap()).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn canonical_config_refuses_symlinks_without_touching_their_target() {
        use std::os::unix::fs::symlink;

        let path = isolated_path();
        fs::create_dir_all(path.parent().unwrap()).expect("test directory");
        let target = path.parent().unwrap().join("private.json");
        fs::write(&target, "do not modify").expect("target");
        symlink(&target, &path).expect("symlink");
        let input = request();
        let url = normalize_gateway_url(input.url.as_deref().unwrap()).expect("gateway URL");

        assert!(save_config_at(&path, &input, &url).is_err());
        assert_eq!(
            fs::read_to_string(&target).expect("target"),
            "do not modify"
        );
        fs::remove_dir_all(path.parent().unwrap()).expect("cleanup");
    }

    #[test]
    fn dashboard_auth_is_fragment_only_and_password_never_enters_url() {
        let url = normalize_gateway_url("wss://gateway.example.com/openclaw").expect("URL");
        let dashboard = dashboard_url(&url, Some("one+two/three=secret")).expect("dashboard");
        assert_eq!(dashboard.scheme(), "https");
        assert_eq!(dashboard.path(), "/openclaw");
        assert_eq!(dashboard.query(), None);
        assert_eq!(
            dashboard.fragment(),
            Some("token=one%2Btwo%2Fthree%3Dsecret")
        );
        assert_eq!(
            dashboard_url(&url, None).expect("dashboard").fragment(),
            None
        );
    }

    #[test]
    fn saved_remote_connection_reloads_without_requiring_a_local_cli() {
        let path = isolated_path();
        let input = request();
        let url = normalize_gateway_url(input.url.as_deref().unwrap()).expect("gateway URL");
        save_config_at(&path, &input, &url).expect("persist remote config");

        let restored = load_saved_remote_at(&path)
            .expect("load saved remote")
            .expect("remote mode");

        assert_eq!(restored.transport, "direct");
        assert_eq!(restored.url.as_deref(), Some(url.as_str()));
        assert_eq!(restored.token.as_deref(), Some("test-token"));
        assert!(restored.password.is_none());
        fs::remove_dir_all(path.parent().unwrap()).expect("cleanup");
    }

    #[test]
    fn saved_remote_connection_preserves_certificate_fingerprint() {
        let path = isolated_path();
        fs::create_dir_all(path.parent().unwrap()).expect("test directory");
        let fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        fs::write(
            &path,
            json!({
                "gateway": {
                    "mode": "remote",
                    "remote": {
                        "transport": "direct",
                        "url": "wss://gateway.example.com/",
                        "tlsFingerprint": fingerprint,
                    },
                },
            })
            .to_string(),
        )
        .expect("pinned configuration");

        let restored = load_saved_remote_at(&path)
            .expect("load pinned Gateway")
            .expect("remote mode");
        let serialized = serde_json::to_value(restored).expect("serialize restored request");

        assert_eq!(serialized["tlsFingerprint"], fingerprint);
        let mut input = request();
        input.url = Some("https://gateway.example.com/".to_string());
        let url = normalize_gateway_url(input.url.as_deref().unwrap()).expect("pinned URL");
        save_config_at(&path, &input, &url).expect("same-endpoint reconnect");
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["gateway"]["remote"]["tlsFingerprint"], fingerprint);
        fs::remove_dir_all(path.parent().unwrap()).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn saved_remote_file_secret_refs_follow_provider_contract() {
        use std::os::unix::fs::PermissionsExt;

        for (mode, id, payload, expected) in [
            (
                "singleValue",
                "value",
                "fixture-file-token\n",
                "fixture-file-token",
            ),
            (
                "json",
                "/gateway~1auth/token~0value",
                r#"{"gateway/auth":{"token~value":"fixture-json-token"}}"#,
                "fixture-json-token",
            ),
        ] {
            let path = isolated_path();
            fs::create_dir_all(path.parent().unwrap()).expect("test directory");
            let secret_path = path.parent().unwrap().join("gateway-secret");
            fs::write(&secret_path, payload).expect("secret fixture");
            fs::set_permissions(&secret_path, fs::Permissions::from_mode(0o600))
                .expect("private secret fixture");
            fs::write(
                &path,
                json!({
                    "secrets": {
                        "providers": {
                            "gatewayfile": {
                                "source": "file",
                                "path": secret_path,
                                "mode": mode,
                            },
                        },
                    },
                    "gateway": {
                        "mode": "remote",
                        "remote": {
                            "url": "ws://127.0.0.1:18789",
                            "token": { "source": "file", "provider": "gatewayfile", "id": id },
                        },
                    },
                })
                .to_string(),
            )
            .expect("file-backed remote config");

            let restored = load_saved_remote_at(&path)
                .expect("resolve private file reference")
                .expect("remote mode");
            assert_eq!(restored.token.as_deref(), Some(expected));

            fs::set_permissions(&secret_path, fs::Permissions::from_mode(0o644))
                .expect("insecure secret fixture");
            assert!(load_saved_remote_at(&path).is_err());
            fs::remove_dir_all(path.parent().unwrap()).expect("cleanup");
        }
    }

    #[test]
    fn saved_remote_env_secret_shorthand_and_provider_allowlists_are_enforced() {
        let path = isolated_path();
        fs::create_dir_all(path.parent().unwrap()).expect("test directory");
        fs::write(
            &path,
            json!({
                "secrets": {
                    "defaults": { "env": "gatewayenv" },
                    "providers": {
                        "gatewayenv": { "source": "env", "allowlist": ["HOME"] },
                    },
                },
                "gateway": {
                    "mode": "remote",
                    "remote": {
                        "url": "ws://127.0.0.1:18789",
                        "token": "${HOME}",
                    },
                },
            })
            .to_string(),
        )
        .expect("environment-backed remote config");

        let restored = load_saved_remote_at(&path)
            .expect("resolve environment shorthand")
            .expect("remote mode");
        assert_eq!(restored.token.as_deref(), env::var("HOME").ok().as_deref());

        let mut denied: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        denied["secrets"]["providers"]["gatewayenv"]["allowlist"] = json!(["NOT_HOME"]);
        fs::write(&path, denied.to_string()).expect("restricted environment provider");
        assert!(load_saved_remote_at(&path).is_err());
        fs::remove_dir_all(path.parent().unwrap()).expect("cleanup");
    }

    fn existing_json5_config(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).expect("test directory");
        fs::write(
            path,
            r#"{
              // Operators may annotate the canonical JSON5 configuration.
              agents: { defaults: { workspace: 'keep-this-workspace', }, },
              gateway: {
                mode: 'remote',
                remote: {
                  url: 'ws://127.0.0.1:18789',
                  token: 'existing-fixture-token', /* trailing commas are valid */
                },
              },
            }"#,
        )
        .expect("existing JSON5 configuration");
    }

    #[test]
    fn saved_remote_config_accepts_documented_json5_syntax() {
        let path = isolated_path();
        existing_json5_config(&path);

        let restored = load_saved_remote_at(&path)
            .expect("documented JSON5 should load")
            .expect("remote mode");

        assert_eq!(restored.url.as_deref(), Some("ws://127.0.0.1:18789"));
        assert_eq!(restored.token.as_deref(), Some("existing-fixture-token"));
        fs::remove_dir_all(path.parent().unwrap()).expect("cleanup");
    }

    #[test]
    fn remote_config_updates_preserve_unrelated_json5_settings() {
        let path = isolated_path();
        existing_json5_config(&path);
        let input = request();
        let url = normalize_gateway_url(input.url.as_deref().unwrap()).expect("Gateway URL");

        save_config_at(&path, &input, &url).expect("update documented JSON5 configuration");

        let saved: Value = serde_json::from_slice(&fs::read(&path).expect("config"))
            .expect("changed config is canonically rewritten as JSON");
        assert_eq!(
            saved["agents"]["defaults"]["workspace"],
            "keep-this-workspace"
        );
        assert_eq!(saved["gateway"]["remote"]["url"], url.as_str());
        assert_eq!(saved["gateway"]["remote"]["token"], "test-token");
        fs::remove_dir_all(path.parent().unwrap()).expect("cleanup");
    }

    #[test]
    fn rejects_conflicting_credentials_and_zero_gateway_ports() {
        let mut input = request();
        input.password = Some("fixture-password".to_string());
        assert!(validate_request(&input).is_err());

        input.password = None;
        input.remote_port = Some(0);
        assert!(validate_request(&input).is_err());

        input.remote_port = None;
        input.transport = "proxy".to_string();
        assert!(validate_request(&input).is_err());
    }

    #[test]
    fn ssh_config_keeps_the_exact_stable_local_endpoint_across_relaunch() {
        let path = isolated_path();
        let mut input = request();
        input.transport = "ssh".to_string();
        input.url = None;
        input.ssh_target = Some("operator@studio.example:2222".to_string());
        input.remote_port = Some(19789);
        let stable_url = Url::parse("ws://127.0.0.1:50420").expect("tunnel URL");
        save_config_at(&path, &input, &stable_url).expect("persist SSH config");

        let restored = load_saved_remote_at(&path)
            .expect("load saved remote")
            .expect("SSH mode");

        assert_eq!(restored.url.as_deref(), Some("ws://127.0.0.1:50420/"));
        assert_eq!(
            restored.ssh_target.as_deref(),
            Some("operator@studio.example:2222")
        );
        assert_eq!(restored.remote_port, Some(19789));
        fs::remove_dir_all(path.parent().unwrap()).expect("cleanup");
    }
}
