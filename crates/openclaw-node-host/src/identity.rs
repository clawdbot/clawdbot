use std::{fmt::Write as _, time::SystemTime};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
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
        let digest = Sha256::digest(self.signing_key.verifying_key().to_bytes());
        let mut id = String::with_capacity(digest.len() * 2);
        for byte in digest {
            write!(id, "{byte:02x}").expect("writing to a String cannot fail");
        }
        id
    }

    pub(crate) fn sign_connect(
        &self,
        nonce: &str,
        platform: &str,
        device_family: Option<&str>,
        signature_token: Option<&str>,
    ) -> Result<DeviceProof, IdentityError> {
        let signed_at = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|_| IdentityError::Clock)?
            .as_millis()
            .try_into()
            .map_err(|_| IdentityError::Clock)?;
        Ok(self.sign_connect_at(nonce, platform, device_family, signature_token, signed_at))
    }

    fn sign_connect_at(
        &self,
        nonce: &str,
        platform: &str,
        device_family: Option<&str>,
        signature_token: Option<&str>,
        signed_at: u64,
    ) -> DeviceProof {
        let device_id = self.device_id();
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
        let signature = self.signing_key.sign(payload.as_bytes());
        DeviceProof::new(
            device_id,
            self.public_key_base64url(),
            URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            signed_at,
            nonce,
        )
    }
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

        let proof = identity.sign_connect_at(
            "nonce-1",
            "Windows",
            Some("Desktop"),
            Some("test-token"),
            1_700_000_000_000,
        );
        let encoded = serde_json::to_value(proof).unwrap();
        let signature = Signature::from_slice(
            &URL_SAFE_NO_PAD
                .decode(encoded["signature"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let payload = format!(
            "v3|{}|node-host|node|node||1700000000000|test-token|nonce-1|windows|desktop",
            identity.device_id()
        );
        identity
            .signing_key
            .verifying_key()
            .verify(payload.as_bytes(), &signature)
            .unwrap();
    }
}
