use std::{
    fmt::{self, Write as _},
    time::SystemTime,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::DeviceProof;

const SECRET_KEY_BYTES: usize = 32;

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("operating-system randomness failed: {0}")]
    Random(String),
    #[error("system clock predates the Unix epoch")]
    Clock,
    #[error("external Ed25519 public key is invalid")]
    InvalidPublicKey,
    #[error("external Ed25519 signature does not match the canonical connect payload")]
    InvalidSignature,
}

/// Canonical `OpenClaw` v3 payload prepared for an embedding-owned Ed25519 key.
///
/// Native embedders can keep the private key in Keychain, a TPM, or another
/// platform credential store. The crate owns the exact payload construction;
/// the embedding signs [`Self::payload`] and returns the raw Ed25519 signature
/// to [`Self::finish`].
#[derive(Clone, Eq, PartialEq)]
pub struct DeviceSigningRequest {
    device_id: String,
    public_key: [u8; 32],
    signed_at: u64,
    nonce: String,
    payload: String,
}

impl fmt::Debug for DeviceSigningRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceSigningRequest")
            .field("device_id", &self.device_id)
            .field("signed_at", &self.signed_at)
            .field("payload", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl DeviceSigningRequest {
    pub(crate) fn new(
        public_key: [u8; 32],
        nonce: &str,
        platform: &str,
        device_family: Option<&str>,
        signature_token: Option<&str>,
    ) -> Result<Self, IdentityError> {
        let signed_at = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|_| IdentityError::Clock)?
            .as_millis()
            .try_into()
            .map_err(|_| IdentityError::Clock)?;
        Self::new_at(
            public_key,
            nonce,
            platform,
            device_family,
            signature_token,
            signed_at,
        )
    }

    fn new_at(
        public_key: [u8; 32],
        nonce: &str,
        platform: &str,
        device_family: Option<&str>,
        signature_token: Option<&str>,
        signed_at: u64,
    ) -> Result<Self, IdentityError> {
        VerifyingKey::from_bytes(&public_key).map_err(|_| IdentityError::InvalidPublicKey)?;
        let device_id = device_id_from_public_key(&public_key);
        let signed_at_text = signed_at.to_string();
        let platform = normalize_metadata(platform);
        let device_family = normalize_metadata(device_family.unwrap_or_default());
        let payload = [
            "v3",
            &device_id,
            "node-host",
            "node",
            "node",
            "",
            &signed_at_text,
            signature_token.unwrap_or_default(),
            nonce,
            &platform,
            &device_family,
        ]
        .join("|");
        Ok(Self {
            device_id,
            public_key,
            signed_at,
            nonce: nonce.to_owned(),
            payload,
        })
    }

    #[must_use]
    pub fn payload(&self) -> &str {
        &self.payload
    }

    #[must_use]
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    #[must_use]
    pub fn signed_at(&self) -> u64 {
        self.signed_at
    }

    /// Complete the device proof with a raw Ed25519 signature of
    /// [`Self::payload`].
    /// # Errors
    ///
    /// Returns an error when the signature does not verify against the supplied
    /// public key and exact canonical payload.
    pub fn finish(self, signature: [u8; 64]) -> Result<DeviceProof, IdentityError> {
        let verifying_key = VerifyingKey::from_bytes(&self.public_key)
            .map_err(|_| IdentityError::InvalidPublicKey)?;
        verifying_key
            .verify(self.payload.as_bytes(), &Signature::from_bytes(&signature))
            .map_err(|_| IdentityError::InvalidSignature)?;
        Ok(DeviceProof::new(
            self.device_id,
            URL_SAFE_NO_PAD.encode(self.public_key),
            URL_SAFE_NO_PAD.encode(signature),
            self.signed_at,
            self.nonce,
        ))
    }
}

/// A stable Ed25519 identity used to sign `OpenClaw` Gateway challenges.
///
/// The library deliberately does not choose a persistence mechanism. Callers
/// can store the 32 secret bytes in their platform credential store and restore
/// them with [`Self::from_secret_bytes`].
#[derive(Clone)]
pub struct NodeIdentity {
    signing_key: SigningKey,
}

impl NodeIdentity {
    /// Generate a new identity from operating-system randomness.
    /// # Errors
    ///
    /// Returns an error if the operating system cannot provide randomness.
    pub fn generate() -> Result<Self, IdentityError> {
        let mut secret = [0_u8; SECRET_KEY_BYTES];
        getrandom::fill(&mut secret).map_err(|error| IdentityError::Random(error.to_string()))?;
        Ok(Self::from_secret_bytes(secret))
    }

    #[must_use]
    pub fn from_secret_bytes(secret: [u8; SECRET_KEY_BYTES]) -> Self {
        Self {
            signing_key: SigningKey::from_bytes(&secret),
        }
    }

    /// Return the secret bytes for application-owned secure persistence.
    #[must_use]
    pub fn secret_bytes(&self) -> [u8; SECRET_KEY_BYTES] {
        self.signing_key.to_bytes()
    }

    #[must_use]
    pub fn public_key_base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.signing_key.verifying_key().to_bytes())
    }

    #[must_use]
    pub fn device_id(&self) -> String {
        device_id_from_public_key(&self.signing_key.verifying_key().to_bytes())
    }

    pub(crate) fn sign_connect(
        &self,
        nonce: &str,
        platform: &str,
        device_family: Option<&str>,
        signature_token: Option<&str>,
    ) -> Result<DeviceProof, IdentityError> {
        let request = DeviceSigningRequest::new(
            self.signing_key.verifying_key().to_bytes(),
            nonce,
            platform,
            device_family,
            signature_token,
        )?;
        let signature = self.signing_key.sign(request.payload().as_bytes());
        request.finish(signature.to_bytes())
    }
}

fn device_id_from_public_key(public_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(public_key);
    let mut id = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(id, "{byte:02x}").expect("writing to a String cannot fail");
    }
    id
}

fn normalize_metadata(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::{Signature, Verifier};

    use super::*;

    #[test]
    fn identity_round_trips_and_signs_the_gateway_v3_payload() {
        let identity = NodeIdentity::from_secret_bytes([7; 32]);
        let restored = NodeIdentity::from_secret_bytes(identity.secret_bytes());
        assert_eq!(restored.device_id(), identity.device_id());
        assert_eq!(
            restored.public_key_base64url(),
            identity.public_key_base64url()
        );

        let request = DeviceSigningRequest::new_at(
            identity.signing_key.verifying_key().to_bytes(),
            "nonce-1",
            "Windows",
            Some("Desktop"),
            Some("test-token"),
            1_700_000_000_000,
        )
        .unwrap();
        let payload = format!(
            "v3|{}|node-host|node|node||1700000000000|test-token|nonce-1|windows|desktop",
            identity.device_id()
        );
        assert_eq!(request.device_id(), identity.device_id());
        assert_eq!(request.payload(), payload);
        let signature = identity.signing_key.sign(request.payload().as_bytes());
        let proof = request.finish(signature.to_bytes()).unwrap();
        let encoded = serde_json::to_value(proof).unwrap();
        let signature = Signature::from_slice(
            &URL_SAFE_NO_PAD
                .decode(encoded["signature"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        identity
            .signing_key
            .verifying_key()
            .verify(payload.as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn external_signing_request_rejects_a_signature_for_other_bytes() {
        let identity = NodeIdentity::from_secret_bytes([7; 32]);
        let request = DeviceSigningRequest::new_at(
            identity.signing_key.verifying_key().to_bytes(),
            "nonce-1",
            "linux",
            Some("desktop"),
            Some("test-token"),
            1_700_000_000_000,
        )
        .unwrap();
        let wrong = identity.signing_key.sign(b"different payload").to_bytes();
        assert!(matches!(
            request.finish(wrong),
            Err(IdentityError::InvalidSignature)
        ));
    }

    #[test]
    fn signing_request_debug_redacts_the_canonical_payload() {
        let identity = NodeIdentity::from_secret_bytes([7; 32]);
        let request = DeviceSigningRequest::new_at(
            identity.signing_key.verifying_key().to_bytes(),
            "sentinel-nonce",
            "windows",
            Some("desktop"),
            Some("sentinel-bearer-token"),
            1_700_000_000_000,
        )
        .unwrap();

        let debug = format!("{request:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("sentinel-bearer-token"));
        assert!(!debug.contains("sentinel-nonce"));
    }
}
