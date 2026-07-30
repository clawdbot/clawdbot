//! Reusable transport, security, and connection policy for Rust OpenClaw Gateway clients.

mod session;

pub use session::{
    ClientError, Event, EventSubscription, GatewayClient, GatewayClientConfig, GatewaySession,
};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use subtle::ConstantTimeEq;

/// Gateway error detail code indicating that a stored issued-device token is no longer valid.
pub const AUTH_DEVICE_TOKEN_MISMATCH_DETAIL_CODE: &str = "AUTH_DEVICE_TOKEN_MISMATCH";
/// Stable rustls error text used to classify a configured certificate-pin mismatch.
pub const TLS_PIN_MISMATCH_ERROR: &str = "Gateway TLS certificate fingerprint mismatch";

/// Bounded, normalized recovery metadata from a failed Gateway connect response.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConnectErrorDetails {
    code: Option<String>,
    device_id: Option<String>,
    remediation_hint: Option<String>,
    retryable: Option<bool>,
    pause_reconnect: Option<bool>,
}

impl ConnectErrorDetails {
    /// Parse the public recovery fields from a Gateway error `details` object.
    #[must_use]
    pub fn from_value(value: Option<&Value>) -> Self {
        let Some(value) = value else {
            return Self::default();
        };
        Self {
            code: connect_detail_text(value.get("code"), 80),
            device_id: connect_detail_text(value.get("deviceId"), 128),
            remediation_hint: connect_detail_text(value.get("remediationHint"), 240),
            retryable: value.get("retryable").and_then(Value::as_bool),
            pause_reconnect: value.get("pauseReconnect").and_then(Value::as_bool),
        }
    }

    /// Whether the Gateway explicitly requires automatic reconnect to pause.
    #[must_use]
    pub fn should_pause_reconnect(&self) -> bool {
        self.pause_reconnect == Some(true) || self.retryable == Some(false)
    }

    /// Gateway error code, when one was supplied.
    #[must_use]
    pub fn code(&self) -> Option<&str> {
        self.code.as_deref()
    }

    /// Device identifier associated with the recovery action, when supplied.
    #[must_use]
    pub fn device_id(&self) -> Option<&str> {
        self.device_id.as_deref()
    }

    /// Bounded plain-text recovery guidance supplied by the Gateway.
    #[must_use]
    pub fn remediation_hint(&self) -> Option<&str> {
        self.remediation_hint.as_deref()
    }

    /// Whether the failure invalidates the issued-device token used for this attempt.
    #[must_use]
    pub fn invalidates_device_token(&self) -> bool {
        self.code.as_deref() == Some(AUTH_DEVICE_TOKEN_MISMATCH_DETAIL_CODE)
    }
}

fn connect_detail_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let normalized = value
        .and_then(Value::as_str)?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(max_chars).collect())
}

/// Return exponential reconnect delay capped by the caller's policy maximum.
#[must_use]
pub fn reconnect_backoff(attempt: u32, maximum: Duration) -> Duration {
    let shift = attempt.saturating_sub(1);
    let seconds = 1_u64.checked_shl(shift).unwrap_or(u64::MAX);
    Duration::from_secs(seconds.min(maximum.as_secs()))
}

/// TLS trust policy selected from optional Gateway discovery metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TlsTrust {
    SystemRoots,
    Pinned([u8; 32]),
}

/// Parse a SHA-256 leaf-certificate fingerprint, or select platform system roots when absent.
pub fn tls_trust(fingerprint: Option<&str>) -> Result<TlsTrust, String> {
    fingerprint
        .map(parse_tls_fingerprint)
        .transpose()
        .map(|fingerprint| fingerprint.map_or(TlsTrust::SystemRoots, TlsTrust::Pinned))
}

fn parse_tls_fingerprint(raw: &str) -> Result<[u8; 32], String> {
    let value = raw.trim();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Gateway TLS fingerprint must be 64 hexadecimal characters.".to_string());
    }
    let mut fingerprint = [0_u8; 32];
    for (index, byte) in fingerprint.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Gateway TLS fingerprint is invalid.".to_string())?;
    }
    Ok(fingerprint)
}

fn pinned_fingerprint_matches(expected: &[u8; 32], certificate_der: &[u8]) -> bool {
    let observed: [u8; 32] = Sha256::digest(certificate_der).into();
    bool::from(expected.as_slice().ct_eq(observed.as_slice()))
}

struct GatewayTlsPinVerifier {
    expected: [u8; 32],
    supported_algorithms: WebPkiSupportedAlgorithms,
}

impl fmt::Debug for GatewayTlsPinVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayTlsPinVerifier")
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for GatewayTlsPinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        // A configured pin replaces CA/hostname trust, matching OpenClawKit. Signature checks
        // below still prove the peer owns the certificate's private key.
        if pinned_fingerprint_matches(&self.expected, end_entity.as_ref()) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(RustlsError::General(TLS_PIN_MISMATCH_ERROR.to_string()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(message, cert, signature, &self.supported_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, signature, &self.supported_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported_algorithms.supported_schemes()
    }
}

/// Build a rustls client configuration that trusts exactly one leaf-certificate fingerprint.
pub fn pinned_tls_config(expected: [u8; 32]) -> Result<ClientConfig, String> {
    let provider = rustls::crypto::ring::default_provider();
    let verifier = GatewayTlsPinVerifier {
        expected,
        supported_algorithms: provider.signature_verification_algorithms,
    };
    ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("Could not configure Gateway TLS: {error}"))
        .map(|builder| {
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tls_trust_uses_system_roots_or_an_exact_pin() {
        assert_eq!(
            tls_trust(None).expect("system trust"),
            TlsTrust::SystemRoots
        );
        assert_eq!(
            tls_trust(Some(&"ab".repeat(32))).expect("pinned trust"),
            TlsTrust::Pinned([0xab; 32])
        );
        assert!(tls_trust(Some("sha256:abc")).is_err());

        let certificate = b"fixture gateway leaf certificate";
        let expected: [u8; 32] = Sha256::digest(certificate).into();
        assert!(pinned_fingerprint_matches(&expected, certificate));
        assert!(!pinned_fingerprint_matches(
            &expected,
            b"different gateway leaf certificate"
        ));
        assert!(pinned_tls_config(expected).is_ok());
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_capped() {
        let maximum = Duration::from_secs(30);
        assert_eq!(reconnect_backoff(1, maximum), Duration::from_secs(1));
        assert_eq!(reconnect_backoff(2, maximum), Duration::from_secs(2));
        assert_eq!(reconnect_backoff(5, maximum), Duration::from_secs(16));
        assert_eq!(reconnect_backoff(6, maximum), maximum);
        assert_eq!(reconnect_backoff(100, maximum), maximum);
    }

    #[test]
    fn connect_policy_uses_bounded_server_details() {
        let details = ConnectErrorDetails::from_value(Some(&json!({
            "code": AUTH_DEVICE_TOKEN_MISMATCH_DETAIL_CODE,
            "deviceId": " device   one ",
            "remediationHint": " approve   it ",
            "retryable": false,
            "pauseReconnect": false
        })));
        assert_eq!(details.device_id(), Some("device one"));
        assert_eq!(details.remediation_hint(), Some("approve it"));
        assert!(details.should_pause_reconnect());
        assert!(details.invalidates_device_token());

        let retry = ConnectErrorDetails::from_value(Some(&json!({
            "retryable": true,
            "pauseReconnect": false
        })));
        assert!(!retry.should_pause_reconnect());
        assert!(!retry.invalidates_device_token());
    }
}
