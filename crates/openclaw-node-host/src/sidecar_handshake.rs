//! Authenticated offer/accept state machine for the node sidecar protocol.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    negotiate_sidecar_protocol, AuthenticatedSidecarChannel, NegotiatedSidecarProtocol,
    SidecarFrameError, SidecarLimits, SidecarPeerRole, SidecarProtocolError, SidecarProtocolOffer,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SidecarHandshakeState {
    Starting,
    AwaitingAcceptance,
    Authenticated,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarProtocolSelection {
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub feature_bits: u64,
    pub limits: SidecarLimits,
}

impl From<&NegotiatedSidecarProtocol> for SidecarProtocolSelection {
    fn from(negotiated: &NegotiatedSidecarProtocol) -> Self {
        Self {
            protocol_major: negotiated.protocol_major,
            protocol_minor: negotiated.protocol_minor,
            feature_bits: negotiated.feature_bits,
            limits: negotiated.limits,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SidecarHandshakeMessage {
    Offer {
        offer: SidecarProtocolOffer,
    },
    Accept {
        offer: SidecarProtocolOffer,
        selection: SidecarProtocolSelection,
    },
}

/// Drives the two-frame authenticated protocol handshake for one peer.
pub struct SidecarHandshake {
    local_offer: SidecarProtocolOffer,
    state: SidecarHandshakeState,
    negotiated: Option<NegotiatedSidecarProtocol>,
}

impl SidecarHandshake {
    /// Create a handshake for a supervisor or runtime offer.
    ///
    /// # Errors
    ///
    /// Returns an error when the local offer is invalid or uses an unsupported
    /// protocol version.
    pub fn new(local_offer: SidecarProtocolOffer) -> Result<Self, SidecarHandshakeError> {
        validate_local_offer(&local_offer)?;
        Ok(Self {
            local_offer,
            state: SidecarHandshakeState::Starting,
            negotiated: None,
        })
    }

    #[must_use]
    pub const fn state(&self) -> SidecarHandshakeState {
        self.state
    }

    #[must_use]
    pub const fn negotiated(&self) -> Option<&NegotiatedSidecarProtocol> {
        self.negotiated.as_ref()
    }

    /// Encode the supervisor's initial authenticated offer.
    ///
    /// # Errors
    ///
    /// Returns an error when called by a runtime, called out of order, or when
    /// the offer cannot be encoded within the bootstrap frame ceiling.
    pub fn start(
        &mut self,
        channel: &mut AuthenticatedSidecarChannel,
    ) -> Result<Vec<u8>, SidecarHandshakeError> {
        if channel.role() != self.local_offer.peer.role {
            return self.fail(channel, SidecarHandshakeError::ChannelRoleMismatch);
        }
        if self.local_offer.peer.role != SidecarPeerRole::Supervisor {
            return self.fail(channel, SidecarHandshakeError::SupervisorMustInitiate);
        }
        if self.state != SidecarHandshakeState::Starting {
            return self.fail(channel, SidecarHandshakeError::UnexpectedMessage);
        }

        let frame = match channel.seal(&SidecarHandshakeMessage::Offer {
            offer: self.local_offer.clone(),
        }) {
            Ok(frame) => frame,
            Err(error) => return self.fail(channel, SidecarHandshakeError::Frame(error)),
        };
        self.state = SidecarHandshakeState::AwaitingAcceptance;
        Ok(frame)
    }

    /// Consume one authenticated handshake frame and optionally return the
    /// runtime's authenticated acceptance frame.
    ///
    /// # Errors
    ///
    /// Returns an error for framing/authentication failure, incompatible or
    /// forged negotiation, wrong peer roles, or invalid message ordering. Any
    /// error permanently retires the channel and handshake.
    pub fn receive(
        &mut self,
        channel: &mut AuthenticatedSidecarChannel,
        frame: &[u8],
    ) -> Result<Option<Vec<u8>>, SidecarHandshakeError> {
        if channel.role() != self.local_offer.peer.role {
            return self.fail(channel, SidecarHandshakeError::ChannelRoleMismatch);
        }
        let result = self.receive_active(channel, frame);
        if result.is_err() {
            channel.retire();
            self.state = SidecarHandshakeState::Failed;
            self.negotiated = None;
        }
        result
    }

    fn receive_active(
        &mut self,
        channel: &mut AuthenticatedSidecarChannel,
        frame: &[u8],
    ) -> Result<Option<Vec<u8>>, SidecarHandshakeError> {
        let message = channel
            .open::<SidecarHandshakeMessage>(frame)
            .map_err(SidecarHandshakeError::Frame)?;
        match (self.local_offer.peer.role, self.state, message) {
            (
                SidecarPeerRole::Runtime,
                SidecarHandshakeState::Starting,
                SidecarHandshakeMessage::Offer { offer },
            ) => self.accept_supervisor(channel, &offer).map(Some),
            (
                SidecarPeerRole::Supervisor,
                SidecarHandshakeState::AwaitingAcceptance,
                SidecarHandshakeMessage::Accept { offer, selection },
            ) => {
                self.confirm_runtime(channel, &offer, selection)?;
                Ok(None)
            }
            _ => Err(SidecarHandshakeError::UnexpectedMessage),
        }
    }

    fn accept_supervisor(
        &mut self,
        channel: &mut AuthenticatedSidecarChannel,
        supervisor_offer: &SidecarProtocolOffer,
    ) -> Result<Vec<u8>, SidecarHandshakeError> {
        if supervisor_offer.peer.role != SidecarPeerRole::Supervisor {
            return Err(SidecarHandshakeError::WrongPeerRole);
        }
        validate_peer_identity(supervisor_offer)?;
        let negotiated = negotiate_sidecar_protocol(&self.local_offer, supervisor_offer)
            .map_err(SidecarHandshakeError::Negotiation)?;
        let selection = SidecarProtocolSelection::from(&negotiated);

        // The acceptance is the last bootstrap-ceiling frame. Lowering before
        // sealing it could make a valid negotiation impossible to acknowledge.
        let acceptance = channel
            .seal(&SidecarHandshakeMessage::Accept {
                offer: self.local_offer.clone(),
                selection,
            })
            .map_err(SidecarHandshakeError::Frame)?;
        channel
            .apply_negotiated_protocol(&negotiated)
            .map_err(SidecarHandshakeError::Negotiation)?;
        self.negotiated = Some(negotiated);
        self.state = SidecarHandshakeState::Authenticated;
        Ok(acceptance)
    }

    fn confirm_runtime(
        &mut self,
        channel: &mut AuthenticatedSidecarChannel,
        runtime_offer: &SidecarProtocolOffer,
        claimed: SidecarProtocolSelection,
    ) -> Result<(), SidecarHandshakeError> {
        if runtime_offer.peer.role != SidecarPeerRole::Runtime {
            return Err(SidecarHandshakeError::WrongPeerRole);
        }
        validate_peer_identity(runtime_offer)?;
        let negotiated = negotiate_sidecar_protocol(&self.local_offer, runtime_offer)
            .map_err(SidecarHandshakeError::Negotiation)?;
        if claimed != SidecarProtocolSelection::from(&negotiated) {
            return Err(SidecarHandshakeError::SelectionMismatch);
        }
        channel
            .apply_negotiated_protocol(&negotiated)
            .map_err(SidecarHandshakeError::Negotiation)?;
        self.negotiated = Some(negotiated);
        self.state = SidecarHandshakeState::Authenticated;
        Ok(())
    }

    fn fail<T>(
        &mut self,
        channel: &mut AuthenticatedSidecarChannel,
        error: SidecarHandshakeError,
    ) -> Result<T, SidecarHandshakeError> {
        channel.retire();
        self.state = SidecarHandshakeState::Failed;
        self.negotiated = None;
        Err(error)
    }
}

fn validate_local_offer(offer: &SidecarProtocolOffer) -> Result<(), SidecarHandshakeError> {
    validate_peer_identity(offer)?;
    let counterpart = SidecarProtocolOffer {
        protocol_major: offer.protocol_major,
        protocol_minor: offer.protocol_minor,
        peer: crate::SidecarPeerIdentity {
            role: match offer.peer.role {
                SidecarPeerRole::Supervisor => SidecarPeerRole::Runtime,
                SidecarPeerRole::Runtime => SidecarPeerRole::Supervisor,
            },
            name: "validation-peer".into(),
            version: "0".into(),
            artifact_identity: "validation-only".into(),
        },
        feature_bits: offer.feature_bits,
        limits: offer.limits,
    };
    negotiate_sidecar_protocol(offer, &counterpart)
        .map(|_| ())
        .map_err(SidecarHandshakeError::Negotiation)
}

fn validate_peer_identity(offer: &SidecarProtocolOffer) -> Result<(), SidecarHandshakeError> {
    if offer.peer.name.trim().is_empty()
        || offer.peer.version.trim().is_empty()
        || offer.peer.artifact_identity.trim().is_empty()
    {
        return Err(SidecarHandshakeError::InvalidPeerIdentity);
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum SidecarHandshakeError {
    #[error("sidecar handshake frame failed")]
    Frame(#[source] SidecarFrameError),
    #[error("sidecar protocol negotiation failed")]
    Negotiation(#[source] SidecarProtocolError),
    #[error("runtime cannot initiate the sidecar handshake")]
    SupervisorMustInitiate,
    #[error("sidecar acceptance does not match the independently negotiated selection")]
    SelectionMismatch,
    #[error("unexpected sidecar handshake message")]
    UnexpectedMessage,
    #[error("sidecar peer identity fields must be nonempty")]
    InvalidPeerIdentity,
    #[error("sidecar handshake message came from the wrong peer role")]
    WrongPeerRole,
    #[error("sidecar handshake role does not match the authenticated channel role")]
    ChannelRoleMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SidecarPeerIdentity, SidecarSessionKey};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    const KEY: [u8; 32] = [0x3c; 32];

    fn offer(
        role: SidecarPeerRole,
        max_frame_bytes: u32,
        feature_bits: u64,
    ) -> SidecarProtocolOffer {
        SidecarProtocolOffer {
            protocol_major: crate::SIDECAR_PROTOCOL_MAJOR,
            protocol_minor: crate::SIDECAR_PROTOCOL_MINOR,
            peer: SidecarPeerIdentity {
                role,
                name: match role {
                    SidecarPeerRole::Supervisor => "test-product",
                    SidecarPeerRole::Runtime => "openclaw-node",
                }
                .into(),
                version: "1.0.0".into(),
                artifact_identity: "sha256:test-only".into(),
            },
            feature_bits,
            limits: SidecarLimits {
                max_frame_bytes,
                max_in_flight: 8,
                bootstrap_timeout_ms: 1_000,
            },
        }
    }

    fn channel(role: SidecarPeerRole, max_frame_bytes: u32) -> AuthenticatedSidecarChannel {
        AuthenticatedSidecarChannel::new(
            role,
            "handshake-session".into(),
            9,
            SidecarSessionKey::from_bytes(KEY),
            max_frame_bytes,
        )
        .unwrap()
    }

    #[test]
    fn supervisor_and_runtime_authenticate_the_same_selection() {
        let mut supervisor =
            SidecarHandshake::new(offer(SidecarPeerRole::Supervisor, 4096, 0b0111)).unwrap();
        let mut runtime =
            SidecarHandshake::new(offer(SidecarPeerRole::Runtime, 2048, 0b1011)).unwrap();
        let mut supervisor_channel = channel(SidecarPeerRole::Supervisor, 4096);
        let mut runtime_channel = channel(SidecarPeerRole::Runtime, 4096);

        let offer_frame = supervisor.start(&mut supervisor_channel).unwrap();
        let acceptance = runtime
            .receive(&mut runtime_channel, &offer_frame)
            .unwrap()
            .unwrap();
        assert_eq!(runtime_channel.max_frame_bytes(), 2048);
        assert_eq!(runtime.state(), SidecarHandshakeState::Authenticated);

        assert!(supervisor
            .receive(&mut supervisor_channel, &acceptance)
            .unwrap()
            .is_none());
        assert_eq!(supervisor_channel.max_frame_bytes(), 2048);
        assert_eq!(supervisor.state(), SidecarHandshakeState::Authenticated);
        assert_eq!(
            SidecarProtocolSelection::from(supervisor.negotiated().unwrap()),
            SidecarProtocolSelection::from(runtime.negotiated().unwrap())
        );
        assert_eq!(supervisor.negotiated().unwrap().feature_bits, 0b0011);

        let active = supervisor_channel.seal(&"active").unwrap();
        assert_eq!(
            u16::from_be_bytes(active[6..8].try_into().unwrap()),
            supervisor.negotiated().unwrap().protocol_minor
        );
        assert_eq!(u64::from_be_bytes(active[17..25].try_into().unwrap()), 2);
        assert_eq!(runtime_channel.open::<String>(&active).unwrap(), "active");
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HandshakeFixture {
        schema_version: u8,
        session: FixtureSession,
        supervisor_offer: SidecarProtocolOffer,
        runtime_offer: SidecarProtocolOffer,
        selection: SidecarProtocolSelection,
        offer_frame_base64: String,
        accept_frame_base64: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureSession {
        id: String,
        generation: u64,
        key_base64: String,
    }

    #[test]
    fn cross_language_handshake_vector_is_exact() {
        let fixture: HandshakeFixture = serde_json::from_str(include_str!(
            "../../../test/fixtures/node-sidecar-handshake-v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.schema_version, 1);
        let key: [u8; 32] = BASE64
            .decode(&fixture.session.key_base64)
            .unwrap()
            .try_into()
            .unwrap();
        let bootstrap_frame_bytes = fixture.supervisor_offer.limits.max_frame_bytes;
        let new_channel = |role| {
            AuthenticatedSidecarChannel::new(
                role,
                fixture.session.id.clone(),
                fixture.session.generation,
                SidecarSessionKey::from_bytes(key),
                bootstrap_frame_bytes,
            )
            .unwrap()
        };

        let mut supervisor = SidecarHandshake::new(fixture.supervisor_offer).unwrap();
        let mut runtime = SidecarHandshake::new(fixture.runtime_offer).unwrap();
        let mut supervisor_channel = new_channel(SidecarPeerRole::Supervisor);
        let mut runtime_channel = new_channel(SidecarPeerRole::Runtime);

        let offer_frame = supervisor.start(&mut supervisor_channel).unwrap();
        assert_eq!(
            offer_frame,
            BASE64.decode(fixture.offer_frame_base64).unwrap()
        );
        let accept_frame = runtime
            .receive(&mut runtime_channel, &offer_frame)
            .unwrap()
            .unwrap();
        assert_eq!(
            accept_frame,
            BASE64.decode(fixture.accept_frame_base64).unwrap()
        );
        assert!(supervisor
            .receive(&mut supervisor_channel, &accept_frame)
            .unwrap()
            .is_none());
        assert_eq!(
            SidecarProtocolSelection::from(supervisor.negotiated().unwrap()),
            fixture.selection
        );
        assert_eq!(
            SidecarProtocolSelection::from(runtime.negotiated().unwrap()),
            fixture.selection
        );
    }

    #[test]
    fn forged_selection_fails_and_retires_supervisor() {
        let mut supervisor =
            SidecarHandshake::new(offer(SidecarPeerRole::Supervisor, 4096, 0b0011)).unwrap();
        let mut supervisor_channel = channel(SidecarPeerRole::Supervisor, 4096);
        let mut malicious_runtime_channel = channel(SidecarPeerRole::Runtime, 4096);
        let offer_frame = supervisor.start(&mut supervisor_channel).unwrap();
        let _: SidecarHandshakeMessage = malicious_runtime_channel.open(&offer_frame).unwrap();

        let runtime_offer = offer(SidecarPeerRole::Runtime, 2048, 0b0011);
        let forged = malicious_runtime_channel
            .seal(&SidecarHandshakeMessage::Accept {
                offer: runtime_offer,
                selection: SidecarProtocolSelection {
                    protocol_major: crate::SIDECAR_PROTOCOL_MAJOR,
                    protocol_minor: crate::SIDECAR_PROTOCOL_MINOR,
                    feature_bits: u64::MAX,
                    limits: SidecarLimits {
                        max_frame_bytes: 4096,
                        max_in_flight: u16::MAX,
                        bootstrap_timeout_ms: u32::MAX,
                    },
                },
            })
            .unwrap();

        assert!(matches!(
            supervisor.receive(&mut supervisor_channel, &forged),
            Err(SidecarHandshakeError::SelectionMismatch)
        ));
        assert_eq!(supervisor.state(), SidecarHandshakeState::Failed);
        assert!(supervisor_channel.is_retired());
    }

    #[test]
    fn incompatible_offer_fails_and_retires_runtime() {
        let mut supervisor_offer = offer(SidecarPeerRole::Supervisor, 4096, 0);
        supervisor_offer.protocol_major += 1;
        let mut supervisor_channel = channel(SidecarPeerRole::Supervisor, 4096);
        let incompatible = supervisor_channel
            .seal(&SidecarHandshakeMessage::Offer {
                offer: supervisor_offer,
            })
            .unwrap();
        let mut runtime = SidecarHandshake::new(offer(SidecarPeerRole::Runtime, 4096, 0)).unwrap();
        let mut runtime_channel = channel(SidecarPeerRole::Runtime, 4096);

        assert!(matches!(
            runtime.receive(&mut runtime_channel, &incompatible),
            Err(SidecarHandshakeError::Negotiation(
                SidecarProtocolError::UnsupportedMajor { .. }
            ))
        ));
        assert_eq!(runtime.state(), SidecarHandshakeState::Failed);
        assert!(runtime_channel.is_retired());
    }

    #[test]
    fn wrong_order_is_terminal() {
        let mut runtime = SidecarHandshake::new(offer(SidecarPeerRole::Runtime, 4096, 0)).unwrap();
        let mut runtime_channel = channel(SidecarPeerRole::Runtime, 4096);
        assert!(matches!(
            runtime.start(&mut runtime_channel),
            Err(SidecarHandshakeError::SupervisorMustInitiate)
        ));
        assert_eq!(runtime.state(), SidecarHandshakeState::Failed);
        assert!(runtime_channel.is_retired());
    }

    #[test]
    fn swapped_channel_roles_are_terminal_before_frame_processing() {
        let mut supervisor =
            SidecarHandshake::new(offer(SidecarPeerRole::Supervisor, 4096, 0)).unwrap();
        let mut runtime_channel = channel(SidecarPeerRole::Runtime, 4096);
        assert!(matches!(
            supervisor.start(&mut runtime_channel),
            Err(SidecarHandshakeError::ChannelRoleMismatch)
        ));
        assert_eq!(supervisor.state(), SidecarHandshakeState::Failed);
        assert!(runtime_channel.is_retired());

        let mut runtime = SidecarHandshake::new(offer(SidecarPeerRole::Runtime, 4096, 0)).unwrap();
        let mut supervisor_channel = channel(SidecarPeerRole::Supervisor, 4096);
        assert!(matches!(
            runtime.receive(&mut supervisor_channel, b"ignored"),
            Err(SidecarHandshakeError::ChannelRoleMismatch)
        ));
        assert_eq!(runtime.state(), SidecarHandshakeState::Failed);
        assert!(supervisor_channel.is_retired());
    }

    #[test]
    fn malformed_frame_retires_handshake_and_channel() {
        let mut runtime = SidecarHandshake::new(offer(SidecarPeerRole::Runtime, 4096, 0)).unwrap();
        let mut runtime_channel = channel(SidecarPeerRole::Runtime, 4096);
        assert!(matches!(
            runtime.receive(&mut runtime_channel, b"not-authenticated"),
            Err(SidecarHandshakeError::Frame(_))
        ));
        assert_eq!(runtime.state(), SidecarHandshakeState::Failed);
        assert!(runtime_channel.is_retired());
    }

    #[test]
    fn invalid_local_identity_is_rejected_before_channel_use() {
        let mut invalid = offer(SidecarPeerRole::Runtime, 4096, 0);
        invalid.peer.artifact_identity.clear();
        assert!(matches!(
            SidecarHandshake::new(invalid),
            Err(SidecarHandshakeError::InvalidPeerIdentity)
        ));
    }

    #[test]
    fn invalid_supervisor_identity_is_terminal_for_runtime() {
        let mut supervisor_channel = channel(SidecarPeerRole::Supervisor, 4096);
        let mut invalid = offer(SidecarPeerRole::Supervisor, 4096, 0);
        invalid.peer.name = "  ".into();
        let frame = supervisor_channel
            .seal(&SidecarHandshakeMessage::Offer { offer: invalid })
            .unwrap();
        let mut runtime = SidecarHandshake::new(offer(SidecarPeerRole::Runtime, 4096, 0)).unwrap();
        let mut runtime_channel = channel(SidecarPeerRole::Runtime, 4096);

        assert!(matches!(
            runtime.receive(&mut runtime_channel, &frame),
            Err(SidecarHandshakeError::InvalidPeerIdentity)
        ));
        assert_eq!(runtime.state(), SidecarHandshakeState::Failed);
        assert!(runtime_channel.is_retired());
    }

    #[test]
    fn invalid_runtime_identity_is_terminal_for_supervisor() {
        let mut supervisor =
            SidecarHandshake::new(offer(SidecarPeerRole::Supervisor, 4096, 0)).unwrap();
        let mut supervisor_channel = channel(SidecarPeerRole::Supervisor, 4096);
        let offer_frame = supervisor.start(&mut supervisor_channel).unwrap();
        let mut runtime_channel = channel(SidecarPeerRole::Runtime, 4096);
        let _: SidecarHandshakeMessage = runtime_channel.open(&offer_frame).unwrap();
        let mut invalid = offer(SidecarPeerRole::Runtime, 4096, 0);
        invalid.peer.version.clear();
        let selection = SidecarProtocolSelection::from(
            &negotiate_sidecar_protocol(&supervisor.local_offer, &invalid).unwrap(),
        );
        let frame = runtime_channel
            .seal(&SidecarHandshakeMessage::Accept {
                offer: invalid,
                selection,
            })
            .unwrap();

        assert!(matches!(
            supervisor.receive(&mut supervisor_channel, &frame),
            Err(SidecarHandshakeError::InvalidPeerIdentity)
        ));
        assert_eq!(supervisor.state(), SidecarHandshakeState::Failed);
        assert!(supervisor_channel.is_retired());
    }

    #[test]
    fn unencodable_initial_offer_is_terminal() {
        let mut supervisor =
            SidecarHandshake::new(offer(SidecarPeerRole::Supervisor, 128, 0)).unwrap();
        let mut supervisor_channel = channel(SidecarPeerRole::Supervisor, 128);
        assert!(matches!(
            supervisor.start(&mut supervisor_channel),
            Err(SidecarHandshakeError::Frame(
                SidecarFrameError::FrameTooLarge { .. }
            ))
        ));
        assert_eq!(supervisor.state(), SidecarHandshakeState::Failed);
        assert!(supervisor_channel.is_retired());
    }
}
