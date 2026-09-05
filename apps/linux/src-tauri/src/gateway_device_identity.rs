use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

pub(crate) const CLIENT_ID: &str = "openclaw-linux";
pub(crate) const CLIENT_MODE: &str = "ui";
pub(crate) const CLIENT_PLATFORM: &str = "linux";
pub(crate) const CLIENT_DEVICE_FAMILY: &str = "desktop";
pub(crate) const CLIENT_ROLE: &str = "operator";
pub(crate) const CLIENT_SCOPES: [&str; 5] = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
];

const IDENTITY_VERSION: u8 = 1;
// A valid identity is well under 1 KiB; 64 KiB leaves ample JSON headroom while
// preventing a damaged or replaced credential file from causing an unbounded read.
const MAX_IDENTITY_BYTES: u64 = 64 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredGatewayIdentity {
    version: u8,
    device_id: String,
    public_key: String,
    private_key: String,
    created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_token_gateway: Option<String>,
}

#[derive(Deserialize)]
struct StoredGatewayIdentityVersion {
    version: u8,
}

enum DecodeIdentityError {
    VersionMismatch { found: u8 },
    Malformed(String),
}

impl Drop for StoredGatewayIdentity {
    fn drop(&mut self) {
        self.private_key.zeroize();
        if let Some(device_token) = self.device_token.as_mut() {
            device_token.zeroize();
        }
    }
}

#[derive(Clone)]
pub(crate) struct GatewayDeviceIdentity {
    stored: StoredGatewayIdentity,
}

pub(crate) struct GatewayDeviceIdentityStore {
    path: PathBuf,
    identity: GatewayDeviceIdentity,
}

// This credential boundary (gateway_device_identity.rs:65-98) intentionally excludes setup-code
// and bootstrapToken redemption; those require a dedicated product UI and remain follow-up work.
#[derive(Clone, Eq, PartialEq)]
pub(crate) enum GatewayAuth {
    DeviceToken(String),
    SharedToken(String),
    SharedPassword(String),
    None,
}

impl Drop for GatewayAuth {
    fn drop(&mut self) {
        match self {
            Self::DeviceToken(token) | Self::SharedToken(token) | Self::SharedPassword(token) => {
                token.zeroize()
            }
            Self::None => {}
        }
    }
}

impl GatewayAuth {
    pub(crate) fn signature_token(&self) -> Option<&str> {
        match self {
            Self::DeviceToken(token) | Self::SharedToken(token) => Some(token),
            Self::SharedPassword(_) | Self::None => None,
        }
    }

    pub(crate) fn json(&self) -> Option<Value> {
        match self {
            Self::DeviceToken(token) => Some(json!({ "deviceToken": token })),
            Self::SharedToken(token) => Some(json!({ "token": token })),
            Self::SharedPassword(password) => Some(json!({ "password": password })),
            Self::None => None,
        }
    }

    pub(crate) fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }
}

impl GatewayDeviceIdentityStore {
    pub(crate) fn load_or_create(path: PathBuf) -> Result<Self, String> {
        let identity = match fs::symlink_metadata(&path) {
            Ok(_) => {
                let metadata = fs::metadata(&path).map_err(|error| {
                    format!("Could not inspect Gateway device identity: {error}")
                })?;
                load_existing_identity(&path, &metadata)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let identity = generate_identity()?;
                write_identity(&path, &identity.stored)?;
                identity
            }
            Err(error) => {
                return Err(format!(
                    "Could not inspect Gateway device identity: {error}"
                ));
            }
        };
        Ok(Self { path, identity })
    }

    pub(crate) fn identity(&self) -> GatewayDeviceIdentity {
        self.identity.clone()
    }

    pub(crate) fn select_auth(
        &self,
        gateway: &str,
        shared_token: Option<&str>,
        shared_password: Option<&str>,
    ) -> GatewayAuth {
        select_auth(
            self.identity.stored.device_token.as_deref(),
            self.identity.stored.device_token_gateway.as_deref(),
            gateway,
            shared_token,
            shared_password,
        )
    }

    pub(crate) fn persist_device_token(
        &mut self,
        gateway: &str,
        device_token: &str,
    ) -> Result<(), String> {
        let device_token = device_token.trim();
        if device_token.is_empty() {
            return Err("Gateway issued an empty device token.".to_string());
        }
        if self.identity.stored.device_token.as_deref() == Some(device_token)
            && self.identity.stored.device_token_gateway.as_deref() == Some(gateway)
        {
            return Ok(());
        }
        let mut updated = self.identity.stored.clone();
        updated.device_token = Some(device_token.to_string());
        updated.device_token_gateway = Some(gateway.to_string());
        write_identity(&self.path, &updated)?;
        self.identity.stored = updated;
        Ok(())
    }

    pub(crate) fn clear_device_token(&mut self, gateway: &str) -> Result<(), String> {
        if self.identity.stored.device_token_gateway.as_deref() != Some(gateway) {
            return Ok(());
        }
        let mut updated = self.identity.stored.clone();
        if let Some(mut token) = updated.device_token.take() {
            token.zeroize();
        }
        updated.device_token_gateway = None;
        write_identity(&self.path, &updated)?;
        self.identity.stored = updated;
        Ok(())
    }
}

impl GatewayDeviceIdentity {
    pub(crate) fn signed_device(
        &self,
        auth: &GatewayAuth,
        nonce: &str,
        signed_at_ms: u64,
    ) -> Result<Value, String> {
        let signing_key_bytes = Zeroizing::new(decode_key(&self.stored.private_key, "private")?);
        let signing_key = SigningKey::from_bytes(&signing_key_bytes);
        let public_key = signing_key.verifying_key().to_bytes();
        if STANDARD.encode(public_key) != self.stored.public_key {
            return Err("Gateway device identity keypair is invalid.".to_string());
        }
        let payload = build_device_auth_payload(DeviceAuthPayloadFields {
            device_id: &self.stored.device_id,
            client_id: CLIENT_ID,
            client_mode: CLIENT_MODE,
            role: CLIENT_ROLE,
            scopes: &CLIENT_SCOPES,
            signed_at_ms,
            token: auth.signature_token(),
            nonce,
            platform: CLIENT_PLATFORM,
            device_family: CLIENT_DEVICE_FAMILY,
        });
        let signature = signing_key.sign(payload.as_bytes()).to_bytes();
        Ok(json!({
            "id": self.stored.device_id,
            "publicKey": URL_SAFE_NO_PAD.encode(public_key),
            "signature": URL_SAFE_NO_PAD.encode(signature),
            "signedAt": signed_at_ms,
            "nonce": nonce,
        }))
    }
}

struct DeviceAuthPayloadFields<'a> {
    device_id: &'a str,
    client_id: &'a str,
    client_mode: &'a str,
    role: &'a str,
    scopes: &'a [&'a str],
    signed_at_ms: u64,
    token: Option<&'a str>,
    nonce: &'a str,
    platform: &'a str,
    device_family: &'a str,
}

fn build_device_auth_payload(fields: DeviceAuthPayloadFields<'_>) -> String {
    // Byte layout mirrors DeviceAuthPayload.swift and gateway-client device-auth.ts.
    [
        "v3".to_string(),
        fields.device_id.to_string(),
        fields.client_id.to_string(),
        fields.client_mode.to_string(),
        fields.role.to_string(),
        fields.scopes.join(","),
        fields.signed_at_ms.to_string(),
        fields.token.unwrap_or_default().to_string(),
        fields.nonce.to_string(),
        normalize_metadata(fields.platform),
        normalize_metadata(fields.device_family),
    ]
    .join("|")
}

fn normalize_metadata(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn non_empty_trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn select_auth(
    device_token: Option<&str>,
    device_token_gateway: Option<&str>,
    gateway: &str,
    shared_token: Option<&str>,
    shared_password: Option<&str>,
) -> GatewayAuth {
    if device_token_gateway == Some(gateway) {
        if let Some(token) = non_empty_trimmed(device_token) {
            return GatewayAuth::DeviceToken(token.to_string());
        }
    }
    if let Some(password) = non_empty_trimmed(shared_password) {
        return GatewayAuth::SharedPassword(password.to_string());
    }
    non_empty_trimmed(shared_token)
        .map(|token| GatewayAuth::SharedToken(token.to_string()))
        .unwrap_or(GatewayAuth::None)
}

fn generate_identity() -> Result<GatewayDeviceIdentity, String> {
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret)
        .map_err(|error| format!("Could not generate Gateway device identity: {error}"))?;
    let signing_key = SigningKey::from_bytes(&secret);
    secret.zeroize();
    let public_key = signing_key.verifying_key().to_bytes();
    Ok(GatewayDeviceIdentity {
        stored: StoredGatewayIdentity {
            version: IDENTITY_VERSION,
            device_id: device_id(&public_key),
            public_key: STANDARD.encode(public_key),
            private_key: STANDARD.encode(signing_key.to_bytes()),
            created_at_ms: unix_time_ms()?,
            device_token: None,
            device_token_gateway: None,
        },
    })
}

fn decode_identity(bytes: &[u8]) -> Result<GatewayDeviceIdentity, DecodeIdentityError> {
    let version = serde_json::from_slice::<StoredGatewayIdentityVersion>(bytes)
        .map_err(|error| {
            DecodeIdentityError::Malformed(format!("Gateway device identity is invalid: {error}"))
        })?
        .version;
    if version != IDENTITY_VERSION {
        return Err(DecodeIdentityError::VersionMismatch { found: version });
    }
    let stored = serde_json::from_slice::<StoredGatewayIdentity>(bytes).map_err(|error| {
        DecodeIdentityError::Malformed(format!("Gateway device identity is invalid: {error}"))
    })?;
    let signing_key_bytes = Zeroizing::new(
        decode_key(&stored.private_key, "private").map_err(DecodeIdentityError::Malformed)?,
    );
    let public_key =
        decode_key(&stored.public_key, "public").map_err(DecodeIdentityError::Malformed)?;
    let signing_key = SigningKey::from_bytes(&signing_key_bytes);
    if signing_key.verifying_key().to_bytes() != public_key {
        return Err(DecodeIdentityError::Malformed(
            "Gateway device identity keypair is invalid.".to_string(),
        ));
    }
    if stored.device_id != device_id(&public_key) {
        return Err(DecodeIdentityError::Malformed(
            "Gateway device identity fingerprint is invalid.".to_string(),
        ));
    }
    if stored.device_token.is_some() != stored.device_token_gateway.is_some() {
        return Err(DecodeIdentityError::Malformed(
            "Gateway device token binding is invalid.".to_string(),
        ));
    }
    Ok(GatewayDeviceIdentity { stored })
}

fn decode_key(encoded: &str, kind: &str) -> Result<[u8; 32], String> {
    STANDARD
        .decode(encoded)
        .map_err(|_| format!("Gateway device {kind} key is invalid."))?
        .try_into()
        .map_err(|_| format!("Gateway device {kind} key has the wrong length."))
}

fn device_id(public_key: &[u8; 32]) -> String {
    Sha256::digest(public_key)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn unix_time_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("Could not read system time: {error}"))
}

fn load_existing_identity(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<GatewayDeviceIdentity, String> {
    if !metadata.is_file() {
        return Err("Gateway device identity path is not a regular file.".to_string());
    }
    enforce_private_permissions(path)?;

    if metadata.len() > MAX_IDENTITY_BYTES {
        return quarantine_and_regenerate(path, format!("file exceeds {MAX_IDENTITY_BYTES} bytes"));
    }

    let file = File::open(path)
        .map_err(|error| format!("Could not read Gateway device identity: {error}"))?;
    let mut bytes = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
    file.take(MAX_IDENTITY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read Gateway device identity: {error}"))?;
    if bytes.len() as u64 > MAX_IDENTITY_BYTES {
        return quarantine_and_regenerate(path, format!("file exceeds {MAX_IDENTITY_BYTES} bytes"));
    }

    match decode_identity(&bytes) {
        Ok(identity) => Ok(identity),
        Err(DecodeIdentityError::VersionMismatch { found }) => Err(format!(
            "Gateway device identity was written by a different version of OpenClaw \
             (identity version {found}; this build supports {IDENTITY_VERSION}); \
             this build will not replace it."
        )),
        Err(DecodeIdentityError::Malformed(error)) => quarantine_and_regenerate(path, error),
    }
}

fn quarantine_and_regenerate(
    path: &Path,
    corruption_reason: String,
) -> Result<GatewayDeviceIdentity, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "Gateway device identity path has no file name.".to_string())?
        .to_string_lossy();
    let quarantine_path = path.with_file_name(format!(
        "{file_name}.corrupt-{}-{}",
        unix_time_ms()?,
        Uuid::new_v4()
    ));
    // GatewayClient holds its identity mutex here, and the Tauri single-instance plugin
    // runs before setup, so no supported app path can replace this file between read and rename.
    // Rename the configured path, not its resolved target: a corrupt symlink is quarantined
    // while its target credential bytes remain untouched for recovery.
    fs::rename(path, &quarantine_path).map_err(|error| {
        format!("Could not quarantine corrupt Gateway device identity: {error}")
    })?;
    eprintln!(
        "Gateway device identity was corrupt ({corruption_reason}); quarantined at {}",
        quarantine_path.display()
    );

    let identity = generate_identity()?;
    write_identity(path, &identity.stored)?;
    Ok(identity)
}

fn write_identity(path: &Path, identity: &StoredGatewayIdentity) -> Result<(), String> {
    let bytes = Zeroizing::new(
        serde_json::to_vec(identity)
            .map_err(|error| format!("Could not encode Gateway device identity: {error}"))?,
    );
    let parent = path
        .parent()
        .ok_or_else(|| "Gateway device identity path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Gateway device identity directory: {error}"))?;

    let temp_path = parent.join(format!(".gateway-device-{}.tmp", Uuid::new_v4()));
    let write_result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp_path, path)?;
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "Could not persist Gateway device identity: {error}"
        ));
    }

    Ok(())
}

fn enforce_private_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not secure Gateway device identity: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, MetadataExt};

    fn quarantined_identity_paths(directory: &Path) -> Vec<PathBuf> {
        fs::read_dir(directory)
            .expect("read identity fixture directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|entry| {
                entry.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with("quickchat-gateway-device.json.corrupt-")
                })
            })
            .collect()
    }

    fn assert_corrupt_identity_recovers(original_bytes: &[u8]) {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-linux-corrupt-gateway-identity-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("create identity fixture directory");
        let path = directory.join("quickchat-gateway-device.json");
        fs::write(&path, original_bytes).expect("write corrupt identity fixture");

        let recovered = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .expect("recover corrupt identity");
        let reloaded = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .expect("reload recovered identity");

        assert_eq!(
            recovered.identity.stored.device_id,
            reloaded.identity.stored.device_id
        );
        assert_eq!(
            recovered.identity.stored.private_key,
            reloaded.identity.stored.private_key
        );
        let quarantined = quarantined_identity_paths(&directory);
        assert_eq!(quarantined.len(), 1);
        assert_eq!(
            fs::read(&quarantined[0]).expect("read quarantined identity"),
            original_bytes
        );

        fs::remove_dir_all(directory).expect("remove identity fixture");
    }

    fn assert_version_mismatch_is_preserved(version: u8) {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-linux-version-mismatch-identity-test-{}",
            Uuid::new_v4()
        ));
        let path = directory.join("quickchat-gateway-device.json");
        let mut stored = generate_identity().expect("generate identity").stored;
        stored.version = version;
        write_identity(&path, &stored).expect("write version-mismatched identity");
        let original_bytes = fs::read(&path).expect("read version-mismatched identity");
        #[cfg(unix)]
        let original_inode = fs::metadata(&path)
            .expect("version-mismatched identity metadata")
            .ino();

        let error = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .err()
            .expect("version mismatch should fail");

        assert!(error.contains("written by a different version of OpenClaw"));
        assert!(error.contains("this build will not replace it"));
        assert_eq!(
            fs::read(&path).expect("reread version-mismatched identity"),
            original_bytes
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path)
                .expect("version-mismatched identity metadata")
                .ino(),
            original_inode
        );
        assert!(quarantined_identity_paths(&directory).is_empty());
        assert_eq!(
            fs::read_dir(&directory)
                .expect("read identity fixture directory")
                .count(),
            1
        );
        fs::remove_dir_all(directory).expect("remove identity fixture");
    }

    #[test]
    fn v3_signature_payload_matches_gateway_fixture_bytes() {
        let payload = build_device_auth_payload(DeviceAuthPayloadFields {
            device_id: "dev-1",
            client_id: CLIENT_ID,
            client_mode: CLIENT_MODE,
            role: CLIENT_ROLE,
            scopes: &["operator.admin", "operator.read"],
            signed_at_ms: 1_800_000_000_000,
            token: Some("test-token"),
            nonce: "nonce-abc",
            platform: " LiNuX ",
            device_family: "DESKTOP",
        });

        assert_eq!(
            payload.as_bytes(),
            b"v3|dev-1|openclaw-linux|ui|operator|operator.admin,operator.read|1800000000000|test-token|nonce-abc|linux|desktop"
        );
    }

    #[test]
    fn identity_persistence_round_trip_keeps_keypair_token_and_private_mode() {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-linux-gateway-identity-test-{}",
            Uuid::new_v4()
        ));
        let path = directory.join("quickchat-gateway-device.json");
        let mut original = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .expect("create device identity");
        original
            .persist_device_token("ws://127.0.0.1:18789", "test-token-fresh")
            .expect("persist device token");
        let reloaded = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .expect("reload device identity");

        assert_eq!(
            original.identity.stored.device_id,
            reloaded.identity.stored.device_id
        );
        assert_eq!(
            original.identity.stored.private_key,
            reloaded.identity.stored.private_key
        );
        assert_eq!(
            reloaded.identity.stored.device_token.as_deref(),
            Some("test-token-fresh")
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path)
                .expect("identity metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        fs::remove_dir_all(directory).expect("remove identity fixture");
    }

    #[test]
    fn empty_identity_file_is_quarantined_and_recovered() {
        assert_corrupt_identity_recovers(b"");
    }

    #[test]
    fn truncated_identity_json_is_quarantined_and_recovered() {
        assert_corrupt_identity_recovers(br#"{"version":1"#);
    }

    #[test]
    fn wrong_shape_identity_json_is_quarantined_and_recovered() {
        assert_corrupt_identity_recovers(br#"["not", "an", "identity"]"#);
    }

    #[test]
    fn oversized_identity_file_is_quarantined_and_recovered() {
        let original_bytes = vec![b'x'; MAX_IDENTITY_BYTES as usize + 1];
        assert_corrupt_identity_recovers(&original_bytes);
    }

    #[test]
    fn newer_identity_version_is_rejected_without_replacement() {
        assert_version_mismatch_is_preserved(
            IDENTITY_VERSION
                .checked_add(1)
                .expect("newer identity version"),
        );
    }

    #[test]
    fn older_identity_version_is_rejected_without_replacement() {
        assert_version_mismatch_is_preserved(
            IDENTITY_VERSION
                .checked_sub(1)
                .expect("older identity version"),
        );
    }

    #[test]
    fn identity_directory_is_a_hard_error_without_quarantine() {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-linux-gateway-identity-directory-test-{}",
            Uuid::new_v4()
        ));
        let path = directory.join("quickchat-gateway-device.json");
        fs::create_dir_all(&path).expect("create identity path as directory");

        let error = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .err()
            .expect("directory identity path should fail");

        assert!(error.contains("not a regular file"));
        assert!(path.is_dir());
        assert!(fs::read_dir(&directory)
            .expect("read identity fixture directory")
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains(".corrupt-")));
        fs::remove_dir_all(directory).expect("remove identity fixture");
    }

    #[cfg(unix)]
    #[test]
    fn valid_symlinked_identity_loads_without_quarantine() {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-linux-valid-symlink-identity-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("create identity fixture directory");
        let target = directory.join("identity-target.json");
        let path = directory.join("quickchat-gateway-device.json");
        let original = GatewayDeviceIdentityStore::load_or_create(target.clone())
            .expect("create target identity");
        symlink(&target, &path).expect("create identity symlink");

        let loaded = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .expect("load symlinked identity");

        assert_eq!(
            loaded.identity.stored.device_id,
            original.identity.stored.device_id
        );
        assert!(fs::symlink_metadata(&path)
            .expect("identity symlink metadata")
            .file_type()
            .is_symlink());
        assert!(quarantined_identity_paths(&directory).is_empty());
        fs::remove_dir_all(directory).expect("remove identity fixture");
    }

    #[cfg(unix)]
    #[test]
    fn corrupt_symlinked_identity_quarantines_link_and_recovers() {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-linux-corrupt-symlink-identity-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("create identity fixture directory");
        let target = directory.join("identity-target.json");
        let path = directory.join("quickchat-gateway-device.json");
        let original_bytes = br#"{"version":1"#;
        fs::write(&target, original_bytes).expect("write corrupt target identity");
        symlink(&target, &path).expect("create identity symlink");

        let recovered = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .expect("recover symlinked identity");
        let reloaded = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .expect("reload recovered identity");

        assert_eq!(
            recovered.identity.stored.device_id,
            reloaded.identity.stored.device_id
        );
        assert!(fs::symlink_metadata(&path)
            .expect("recovered identity metadata")
            .is_file());
        assert_eq!(
            fs::read(&target).expect("read target identity"),
            original_bytes
        );
        let quarantined = quarantined_identity_paths(&directory);
        assert_eq!(quarantined.len(), 1);
        assert!(fs::symlink_metadata(&quarantined[0])
            .expect("quarantined symlink metadata")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_link(&quarantined[0]).expect("read quarantined link"),
            target
        );
        assert_eq!(
            fs::metadata(&path)
                .expect("recovered identity metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(directory).expect("remove identity fixture");
    }

    #[cfg(unix)]
    #[test]
    fn dangling_identity_symlink_is_a_hard_error_without_quarantine() {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-linux-dangling-symlink-identity-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("create identity fixture directory");
        let target = directory.join("missing-identity-target.json");
        let path = directory.join("quickchat-gateway-device.json");
        symlink(&target, &path).expect("create dangling identity symlink");

        let error = GatewayDeviceIdentityStore::load_or_create(path.clone())
            .err()
            .expect("dangling identity symlink should fail");

        assert!(error.contains("Could not inspect Gateway device identity"));
        assert!(fs::symlink_metadata(&path)
            .expect("dangling identity symlink metadata")
            .file_type()
            .is_symlink());
        assert!(!target.exists());
        assert!(quarantined_identity_paths(&directory).is_empty());
        fs::remove_dir_all(directory).expect("remove identity fixture");
    }

    #[test]
    fn auth_selection_prefers_bound_device_token_then_shared_bootstrap_token() {
        assert!(matches!(
            &select_auth(
                Some("device-token"),
                Some("wss://gateway.example"),
                "wss://gateway.example",
                Some("shared-token"),
                None
            ),
            GatewayAuth::DeviceToken(token) if token == "device-token"
        ));
        assert!(matches!(
            &select_auth(
                Some("device-token"),
                Some("wss://other.example"),
                "wss://gateway.example",
                Some("shared-token"),
                None
            ),
            GatewayAuth::SharedToken(token) if token == "shared-token"
        ));
        assert!(matches!(
            &select_auth(None, None, "wss://gateway.example", None, None),
            GatewayAuth::None
        ));
    }

    #[test]
    fn device_token_auth_uses_one_value_for_frame_and_signature() {
        let auth = GatewayAuth::DeviceToken("test-device-token".to_string());

        assert_eq!(auth.signature_token(), Some("test-device-token"));
        assert_eq!(
            auth.json(),
            Some(json!({ "deviceToken": "test-device-token" }))
        );
    }

    #[test]
    fn password_auth_uses_the_password_field_and_null_signature_token() {
        let auth = GatewayAuth::SharedPassword("test-password".to_string());

        assert_eq!(auth.signature_token(), None);
        assert_eq!(auth.json(), Some(json!({ "password": "test-password" })));
    }

    #[test]
    fn stale_device_token_can_be_cleared_without_rotating_the_identity() {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-linux-gateway-stale-token-test-{}",
            Uuid::new_v4()
        ));
        let path = directory.join("quickchat-gateway-device.json");
        let mut store =
            GatewayDeviceIdentityStore::load_or_create(path.clone()).expect("create identity");
        let device_id = store.identity.stored.device_id.clone();
        store
            .persist_device_token("wss://gateway.example", "test-token-stale")
            .expect("persist token");
        store
            .clear_device_token("wss://gateway.example")
            .expect("clear token");

        let reloaded = GatewayDeviceIdentityStore::load_or_create(path).expect("reload identity");
        assert_eq!(reloaded.identity.stored.device_id, device_id);
        assert!(matches!(
            reloaded.select_auth("wss://gateway.example", Some("shared-token"), None),
            GatewayAuth::SharedToken(ref token) if token == "shared-token"
        ));
        fs::remove_dir_all(directory).expect("remove identity fixture");
    }
}
