use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
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
        let identity = if path.exists() {
            enforce_private_permissions(&path)?;
            let bytes = Zeroizing::new(
                fs::read(&path)
                    .map_err(|error| format!("Could not read Gateway device identity: {error}"))?,
            );
            decode_identity(&bytes)?
        } else {
            let identity = generate_identity()?;
            write_identity(&path, &identity.stored)?;
            identity
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
    value
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_uppercase() {
                character.to_ascii_lowercase()
            } else {
                character
            }
        })
        .collect()
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

fn decode_identity(bytes: &[u8]) -> Result<GatewayDeviceIdentity, String> {
    let stored = serde_json::from_slice::<StoredGatewayIdentity>(bytes)
        .map_err(|error| format!("Gateway device identity is invalid: {error}"))?;
    if stored.version != IDENTITY_VERSION {
        return Err("Gateway device identity has an unsupported version.".to_string());
    }
    let signing_key_bytes = Zeroizing::new(decode_key(&stored.private_key, "private")?);
    let public_key = decode_key(&stored.public_key, "public")?;
    let signing_key = SigningKey::from_bytes(&signing_key_bytes);
    if signing_key.verifying_key().to_bytes() != public_key {
        return Err("Gateway device identity keypair is invalid.".to_string());
    }
    if stored.device_id != device_id(&public_key) {
        return Err("Gateway device identity fingerprint is invalid.".to_string());
    }
    if stored.device_token.is_some() != stored.device_token_gateway.is_some() {
        return Err("Gateway device token binding is invalid.".to_string());
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

    #[cfg(unix)]
    {
        let temp_path = parent.join(format!(".gateway-device-{}.tmp", Uuid::new_v4()));
        let write_result = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp_path)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temp_path, path)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temp_path);
            return Err(format!(
                "Could not persist Gateway device identity: {error}"
            ));
        }
    }

    #[cfg(not(unix))]
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|error| format!("Could not persist Gateway device identity: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not persist Gateway device identity: {error}"))?;
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
