use openclaw_gateway_client::{ConnectErrorDetails, TLS_PIN_MISMATCH_ERROR};
use serde_json::Value;
use std::time::Duration;

use crate::node::ClientError;

const DEFAULT_INITIAL_DELAY: Duration = Duration::from_secs(1);
const DEFAULT_MAXIMUM_DELAY: Duration = Duration::from_secs(30);
const DEVICE_TOKEN_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DevicePairingReason {
    NotPaired,
    RoleUpgrade,
    ScopeUpgrade,
    MetadataUpgrade,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryStep {
    RetryWithDeviceToken,
    UpdateAuthConfiguration,
    UpdateAuthCredentials,
    WaitThenRetry,
    ReviewAuthConfiguration,
}

/// Sanitized device-pairing diagnostics returned by the Gateway.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevicePairingRequest {
    pub reason: Option<DevicePairingReason>,
    pub request_id: Option<String>,
    pub remediation_hint: Option<String>,
    pub recommended_next_step: Option<RecoveryStep>,
    pub retryable: Option<bool>,
    pub pause_reconnect: Option<bool>,
    pub device_id: Option<String>,
    pub requested_role: Option<String>,
    pub requested_scopes: Option<Vec<String>>,
    pub approved_roles: Option<Vec<String>>,
    pub approved_scopes: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReconnectPause {
    DevicePairing(DevicePairingRequest),
    Authentication { detail_code: String },
    Protocol { detail_code: Option<String> },
    Configuration,
    LocalIdentity,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReconnectAction {
    KeepSession,
    RetryAfter(Duration),
    RetryWithStoredDeviceTokenAfter(Duration),
    Pause(ReconnectPause),
}

/// Whether an application can safely supply a stored token for one fallback.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StoredDeviceTokenRetry {
    #[default]
    Unavailable,
    AvailableForTrustedEndpoint,
}

/// Deterministic exponential reconnect policy matching `OpenClaw`'s client rules.
#[derive(Clone, Debug)]
pub struct ReconnectPolicy {
    initial_delay: Duration,
    maximum_delay: Duration,
    next_delay: Duration,
    device_token_retry_used: bool,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self::new(DEFAULT_INITIAL_DELAY, DEFAULT_MAXIMUM_DELAY)
    }
}

impl ReconnectPolicy {
    #[must_use]
    pub fn new(initial_delay: Duration, maximum_delay: Duration) -> Self {
        let maximum_delay = maximum_delay.max(initial_delay);
        Self {
            initial_delay,
            maximum_delay,
            next_delay: initial_delay,
            device_token_retry_used: false,
        }
    }

    /// Classify a failed connection without sleeping or owning application state.
    #[must_use]
    pub fn after_failure(&mut self, error: &ClientError) -> ReconnectAction {
        self.after_failure_with_device_token(error, StoredDeviceTokenRetry::Unavailable)
    }

    /// Classify a failure and allow one application-supplied stored-token retry.
    ///
    /// Callers must select `AvailableForTrustedEndpoint` only for loopback or
    /// an independently authenticated remote endpoint.
    #[must_use]
    pub fn after_failure_with_device_token(
        &mut self,
        error: &ClientError,
        stored_token: StoredDeviceTokenRetry,
    ) -> ReconnectAction {
        if is_session_request_error(error) {
            return ReconnectAction::KeepSession;
        }
        if !self.device_token_retry_used
            && stored_token == StoredDeviceTokenRetry::AvailableForTrustedEndpoint
            && gateway_requests_device_token_retry(error)
        {
            self.device_token_retry_used = true;
            return ReconnectAction::RetryWithStoredDeviceTokenAfter(DEVICE_TOKEN_RETRY_DELAY);
        }
        if let Some(pause) = classify_pause(error) {
            return ReconnectAction::Pause(pause);
        }

        if let Some(delay) = gateway_retry_after(error) {
            return ReconnectAction::RetryAfter(delay.min(self.maximum_delay));
        }

        let delay = self.next_delay;
        self.next_delay = self
            .next_delay
            .checked_mul(2)
            .unwrap_or(self.maximum_delay)
            .min(self.maximum_delay);
        ReconnectAction::RetryAfter(delay)
    }

    /// Reset exponential backoff after a successful connection.
    pub fn connected(&mut self) {
        self.next_delay = self.initial_delay;
        self.device_token_retry_used = false;
    }
}

fn classify_pause(error: &ClientError) -> Option<ReconnectPause> {
    match error {
        ClientError::InvalidUrl(_) | ClientError::InsecureRemoteGateway => {
            Some(ReconnectPause::Configuration)
        }
        ClientError::Tls(reason) if is_tls_configuration_error(reason) => {
            Some(ReconnectPause::Configuration)
        }
        ClientError::ConnectParams(_) | ClientError::Identity(_) => {
            Some(ReconnectPause::LocalIdentity)
        }
        ClientError::InvalidChallenge(_) | ClientError::InvalidFrame(_) => {
            Some(ReconnectPause::Protocol { detail_code: None })
        }
        ClientError::Gateway {
            code,
            details,
            retryable,
            ..
        } => {
            let detail_code = connect_detail_code(code, details.as_ref());
            if detail_code == "PAIRING_REQUIRED" {
                let pairing = parse_pairing_request(details.as_ref());
                if pairing.pause_reconnect == Some(false)
                    || pairing.recommended_next_step == Some(RecoveryStep::WaitThenRetry)
                {
                    return None;
                }
                return Some(ReconnectPause::DevicePairing(pairing));
            }
            if matches!(detail_code, "PROTOCOL_MISMATCH" | "CLIENT_VERSION_MISMATCH") {
                return Some(ReconnectPause::Protocol {
                    detail_code: Some(detail_code.to_owned()),
                });
            }
            if *retryable == Some(false)
                || ConnectErrorDetails::from_value(details.as_ref()).should_pause_reconnect()
            {
                return Some(ReconnectPause::Authentication {
                    detail_code: detail_code.to_owned(),
                });
            }
            // Authentication rate limits outlive the short reconnect loop, so
            // they pause even when the generic recovery hint says to wait.
            if detail_code == "AUTH_RATE_LIMITED" {
                return Some(ReconnectPause::Authentication {
                    detail_code: detail_code.to_owned(),
                });
            }
            match recovery_step(details.as_ref()) {
                Some(RecoveryStep::WaitThenRetry) => return None,
                Some(
                    RecoveryStep::RetryWithDeviceToken
                    | RecoveryStep::UpdateAuthConfiguration
                    | RecoveryStep::UpdateAuthCredentials
                    | RecoveryStep::ReviewAuthConfiguration,
                ) => {
                    return Some(ReconnectPause::Authentication {
                        detail_code: detail_code.to_owned(),
                    });
                }
                None => {}
            }
            if is_auth_pause_code(detail_code) {
                return Some(ReconnectPause::Authentication {
                    detail_code: detail_code.to_owned(),
                });
            }
            None
        }
        ClientError::Transport(_)
        | ClientError::Tls(_)
        | ClientError::ConnectTimeout
        | ClientError::ChallengeTimeout
        | ClientError::RequestTimeout(_)
        | ClientError::WriteTimeout(_)
        | ClientError::Closed(_)
        | ClientError::EventLagged(_)
        | ClientError::NotActivated => None,
    }
}

pub(crate) fn is_tls_configuration_error(reason: &str) -> bool {
    reason.contains(TLS_PIN_MISMATCH_ERROR)
        || reason.contains("Gateway TLS fingerprint requires a wss:// URL")
}

fn is_auth_pause_code(code: &str) -> bool {
    matches!(
        code,
        "AUTH_TOKEN_MISSING"
            | "AUTH_TOKEN_NOT_CONFIGURED"
            | "AUTH_BOOTSTRAP_TOKEN_INVALID"
            | "AUTH_PASSWORD_MISSING"
            | "AUTH_PASSWORD_MISMATCH"
            | "AUTH_PASSWORD_NOT_CONFIGURED"
            | "AUTH_RATE_LIMITED"
            | "AUTH_DEVICE_TOKEN_MISMATCH"
            | "AUTH_SCOPE_MISMATCH"
            | "AUTH_TOKEN_MISMATCH"
            | "CONTROL_UI_DEVICE_IDENTITY_REQUIRED"
            | "DEVICE_IDENTITY_REQUIRED"
    )
}

fn connect_detail_code<'a>(gateway_code: &'a str, details: Option<&'a Value>) -> &'a str {
    let detail_code = details
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    detail_code.unwrap_or_else(|| {
        if gateway_code == "NOT_PAIRED" {
            "PAIRING_REQUIRED"
        } else {
            gateway_code
        }
    })
}

fn gateway_retry_after(error: &ClientError) -> Option<Duration> {
    let ClientError::Gateway { retry_after_ms, .. } = error else {
        return None;
    };
    retry_after_ms.map(Duration::from_millis)
}

fn gateway_requests_device_token_retry(error: &ClientError) -> bool {
    let ClientError::Gateway {
        method,
        code,
        details,
        ..
    } = error
    else {
        return false;
    };
    method == "connect"
        && (connect_detail_code(code, details.as_ref()) == "AUTH_TOKEN_MISMATCH"
            || recovery_step(details.as_ref()) == Some(RecoveryStep::RetryWithDeviceToken))
}

fn is_session_request_error(error: &ClientError) -> bool {
    match error {
        ClientError::Gateway { method, .. } | ClientError::RequestTimeout(method) => {
            method != "connect"
        }
        ClientError::EventLagged(_) | ClientError::NotActivated => true,
        _ => false,
    }
}

fn parse_pairing_request(details: Option<&Value>) -> DevicePairingRequest {
    let details = details.and_then(Value::as_object);
    DevicePairingRequest {
        reason: details
            .and_then(|value| value.get("reason"))
            .and_then(Value::as_str)
            .and_then(parse_pairing_reason),
        request_id: details
            .and_then(|value| value.get("requestId"))
            .and_then(Value::as_str)
            .and_then(normalize_request_id),
        remediation_hint: optional_string(details, "remediationHint"),
        recommended_next_step: details
            .and_then(|value| value.get("recommendedNextStep"))
            .and_then(Value::as_str)
            .and_then(parse_recovery_step),
        retryable: optional_bool(details, "retryable"),
        pause_reconnect: optional_bool(details, "pauseReconnect"),
        device_id: optional_string(details, "deviceId"),
        requested_role: optional_string(details, "requestedRole"),
        requested_scopes: string_array(details, "requestedScopes"),
        approved_roles: string_array(details, "approvedRoles"),
        approved_scopes: string_array(details, "approvedScopes"),
    }
}

fn recovery_step(details: Option<&Value>) -> Option<RecoveryStep> {
    details
        .and_then(|value| value.get("recommendedNextStep"))
        .and_then(Value::as_str)
        .and_then(parse_recovery_step)
}

fn parse_pairing_reason(value: &str) -> Option<DevicePairingReason> {
    match value.trim() {
        "not-paired" => Some(DevicePairingReason::NotPaired),
        "role-upgrade" => Some(DevicePairingReason::RoleUpgrade),
        "scope-upgrade" => Some(DevicePairingReason::ScopeUpgrade),
        "metadata-upgrade" => Some(DevicePairingReason::MetadataUpgrade),
        _ => None,
    }
}

fn parse_recovery_step(value: &str) -> Option<RecoveryStep> {
    match value.trim() {
        "retry_with_device_token" => Some(RecoveryStep::RetryWithDeviceToken),
        "update_auth_configuration" => Some(RecoveryStep::UpdateAuthConfiguration),
        "update_auth_credentials" => Some(RecoveryStep::UpdateAuthCredentials),
        "wait_then_retry" => Some(RecoveryStep::WaitThenRetry),
        "review_auth_configuration" => Some(RecoveryStep::ReviewAuthConfiguration),
        _ => None,
    }
}

fn optional_string(details: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<String> {
    details
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn optional_bool(details: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<bool> {
    details
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
}

fn string_array(
    details: Option<&serde_json::Map<String, Value>>,
    key: &str,
) -> Option<Vec<String>> {
    details
        .and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .and_then(|values| {
            let values = values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>();
            (!values.is_empty()).then_some(values)
        })
}

fn normalize_request_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    let mut chars = value.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphanumeric()
        || !chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
    {
        return None;
    }
    Some(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gateway_error(code: &str, details: Value) -> ClientError {
        ClientError::Gateway {
            method: "connect".into(),
            code: code.into(),
            message: "connect failed".into(),
            details: Some(details),
            retryable: None,
            retry_after_ms: None,
        }
    }

    #[test]
    fn pairing_pauses_with_sanitized_device_request() {
        let error = gateway_error(
            "NOT_PAIRED",
            json!({
                "code":"PAIRING_REQUIRED",
                "reason":"not-paired",
                "requestId":"pair-1",
                "requestedRole":"node",
                "requestedScopes":[]
            }),
        );
        let mut policy = ReconnectPolicy::default();
        let ReconnectAction::Pause(ReconnectPause::DevicePairing(request)) =
            policy.after_failure(&error)
        else {
            panic!("pairing should pause reconnect");
        };
        assert_eq!(request.reason, Some(DevicePairingReason::NotPaired));
        assert_eq!(request.request_id.as_deref(), Some("pair-1"));
        assert_eq!(request.requested_role.as_deref(), Some("node"));
        assert_eq!(request.requested_scopes, None);
        assert_eq!(request.approved_roles, None);
    }

    #[test]
    fn pairing_retry_hint_keeps_backoff_active() {
        let error = gateway_error(
            "NOT_PAIRED",
            json!({
                "code":"PAIRING_REQUIRED",
                "recommendedNextStep":"wait_then_retry",
                "pauseReconnect":false
            }),
        );
        let mut policy = ReconnectPolicy::default();
        assert_eq!(
            policy.after_failure(&error),
            ReconnectAction::RetryAfter(Duration::from_secs(1))
        );
    }

    #[test]
    fn explicit_terminal_gateway_metadata_pauses_unknown_errors() {
        for error in [
            ClientError::Gateway {
                method: "connect".into(),
                code: "NEW_GATEWAY_ERROR".into(),
                message: "connect failed".into(),
                details: None,
                retryable: Some(false),
                retry_after_ms: None,
            },
            gateway_error(
                "NEW_GATEWAY_ERROR",
                json!({"code":"NEW_TERMINAL_ERROR","pauseReconnect":true}),
            ),
        ] {
            let mut policy = ReconnectPolicy::default();
            assert!(matches!(
                policy.after_failure(&error),
                ReconnectAction::Pause(ReconnectPause::Authentication { .. })
            ));
        }
    }

    #[test]
    fn unsafe_pairing_request_id_is_not_exposed() {
        let error = gateway_error(
            "NOT_PAIRED",
            json!({"code":"PAIRING_REQUIRED","requestId":"pair-1;echo unsafe"}),
        );
        let mut policy = ReconnectPolicy::default();
        let ReconnectAction::Pause(ReconnectPause::DevicePairing(request)) =
            policy.after_failure(&error)
        else {
            panic!("pairing should pause reconnect");
        };
        assert_eq!(request.request_id, None);
    }

    #[test]
    fn legacy_not_paired_error_still_pauses_for_device_approval() {
        let error = gateway_error("NOT_PAIRED", json!({"requestId":"pair-legacy"}));
        let mut policy = ReconnectPolicy::default();
        let ReconnectAction::Pause(ReconnectPause::DevicePairing(request)) =
            policy.after_failure(&error)
        else {
            panic!("legacy pairing should pause reconnect");
        };
        assert_eq!(request.request_id.as_deref(), Some("pair-legacy"));
    }

    #[test]
    fn transient_backoff_is_bounded_and_resets() {
        let error = ClientError::Transport("offline".into());
        let mut policy = ReconnectPolicy::new(Duration::from_secs(1), Duration::from_secs(4));
        for expected in [1, 2, 4, 4] {
            assert_eq!(
                policy.after_failure(&error),
                ReconnectAction::RetryAfter(Duration::from_secs(expected))
            );
        }
        policy.connected();
        assert_eq!(
            policy.after_failure(&error),
            ReconnectAction::RetryAfter(Duration::from_secs(1))
        );
    }

    #[test]
    fn rejected_device_token_and_protocol_mismatch_pause() {
        let mut policy = ReconnectPolicy::default();
        let auth = gateway_error("UNAUTHORIZED", json!({"code":"AUTH_DEVICE_TOKEN_MISMATCH"}));
        assert_eq!(
            policy.after_failure(&auth),
            ReconnectAction::Pause(ReconnectPause::Authentication {
                detail_code: "AUTH_DEVICE_TOKEN_MISMATCH".into()
            })
        );
        let protocol = gateway_error("INVALID_REQUEST", json!({"code":"PROTOCOL_MISMATCH"}));
        assert_eq!(
            policy.after_failure(&protocol),
            ReconnectAction::Pause(ReconnectPause::Protocol {
                detail_code: Some("PROTOCOL_MISMATCH".into())
            })
        );
    }

    #[test]
    fn permanent_tls_configuration_failures_pause_but_transient_tls_retries() {
        let mut policy = ReconnectPolicy::default();
        assert_eq!(
            policy.after_failure(&ClientError::Tls(TLS_PIN_MISMATCH_ERROR.into())),
            ReconnectAction::Pause(ReconnectPause::Configuration)
        );
        assert_eq!(
            policy.after_failure(&ClientError::Tls("temporary handshake alert".into())),
            ReconnectAction::RetryAfter(Duration::from_secs(1))
        );
    }

    #[test]
    fn stored_device_token_fallback_is_explicit_and_bounded() {
        let error = gateway_error("UNAUTHORIZED", json!({"code":"AUTH_TOKEN_MISMATCH"}));
        let mut policy = ReconnectPolicy::default();
        assert_eq!(
            policy.after_failure_with_device_token(
                &error,
                StoredDeviceTokenRetry::AvailableForTrustedEndpoint
            ),
            ReconnectAction::RetryWithStoredDeviceTokenAfter(Duration::from_millis(250))
        );
        assert_eq!(
            policy.after_failure_with_device_token(
                &error,
                StoredDeviceTokenRetry::AvailableForTrustedEndpoint
            ),
            ReconnectAction::Pause(ReconnectPause::Authentication {
                detail_code: "AUTH_TOKEN_MISMATCH".into()
            })
        );
        policy.connected();
        assert_eq!(
            policy.after_failure_with_device_token(
                &error,
                StoredDeviceTokenRetry::AvailableForTrustedEndpoint
            ),
            ReconnectAction::RetryWithStoredDeviceTokenAfter(Duration::from_millis(250))
        );
    }

    #[test]
    fn structured_recovery_advice_controls_retry_or_pause() {
        let retry = gateway_error(
            "UNAUTHORIZED",
            json!({
                "code":"AUTH_UNAUTHORIZED",
                "recommendedNextStep":"retry_with_device_token"
            }),
        );
        let mut policy = ReconnectPolicy::default();
        assert_eq!(
            policy.after_failure_with_device_token(
                &retry,
                StoredDeviceTokenRetry::AvailableForTrustedEndpoint
            ),
            ReconnectAction::RetryWithStoredDeviceTokenAfter(Duration::from_millis(250))
        );
        assert_eq!(
            policy.after_failure_with_device_token(
                &retry,
                StoredDeviceTokenRetry::AvailableForTrustedEndpoint
            ),
            ReconnectAction::Pause(ReconnectPause::Authentication {
                detail_code: "AUTH_UNAUTHORIZED".into()
            })
        );

        let wait = gateway_error(
            "UNAVAILABLE",
            json!({"recommendedNextStep":"wait_then_retry"}),
        );
        assert_eq!(
            policy.after_failure(&wait),
            ReconnectAction::RetryAfter(Duration::from_secs(1))
        );
        let update = gateway_error(
            "UNAUTHORIZED",
            json!({"recommendedNextStep":"update_auth_configuration"}),
        );
        assert_eq!(
            policy.after_failure(&update),
            ReconnectAction::Pause(ReconnectPause::Authentication {
                detail_code: "UNAUTHORIZED".into()
            })
        );
    }

    #[test]
    fn auth_rate_limit_pauses_despite_wait_then_retry_advice() {
        let error = gateway_error(
            "UNAUTHORIZED",
            json!({
                "code":"AUTH_RATE_LIMITED",
                "recommendedNextStep":"wait_then_retry"
            }),
        );
        let mut policy = ReconnectPolicy::default();
        assert_eq!(
            policy.after_failure(&error),
            ReconnectAction::Pause(ReconnectPause::Authentication {
                detail_code: "AUTH_RATE_LIMITED".into()
            })
        );
    }

    #[test]
    fn empty_or_invalid_pairing_lists_are_omitted() {
        for details in [
            json!({"code":"PAIRING_REQUIRED"}),
            json!({"code":"PAIRING_REQUIRED","requestedScopes":[]}),
            json!({"code":"PAIRING_REQUIRED","requestedScopes":[" ", 7]}),
        ] {
            let error = gateway_error("NOT_PAIRED", details);
            let mut policy = ReconnectPolicy::default();
            let ReconnectAction::Pause(ReconnectPause::DevicePairing(request)) =
                policy.after_failure(&error)
            else {
                panic!("pairing should pause reconnect");
            };
            assert_eq!(request.requested_scopes, None);
        }
    }

    #[test]
    fn request_errors_do_not_reconnect_a_healthy_session() {
        let mut policy = ReconnectPolicy::default();
        assert_eq!(
            policy.after_failure(&ClientError::RequestTimeout("node.echo".into())),
            ReconnectAction::KeepSession
        );
        assert_eq!(
            policy.after_failure(&gateway_error(
                "INVALID_REQUEST",
                json!({"code":"AUTH_TOKEN_MISMATCH"})
            )),
            ReconnectAction::Pause(ReconnectPause::Authentication {
                detail_code: "AUTH_TOKEN_MISMATCH".into()
            })
        );
        let request_error = ClientError::Gateway {
            method: "node.echo".into(),
            code: "INVALID_REQUEST".into(),
            message: "bad input".into(),
            details: None,
            retryable: None,
            retry_after_ms: None,
        };
        assert_eq!(
            policy.after_failure(&request_error),
            ReconnectAction::KeepSession
        );
    }
}
