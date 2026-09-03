import OpenClawProtocol

public enum GatewayServerCapability: String, CaseIterable, Sendable {
    case chatSendRoutingContract = "chat-send-routing-contract"
    case sessionScopedChatMetadata = "session-scoped-chat-metadata"
    case sessionUnreadAckContract = "session-unread-ack-contract"
    case sessionSettingsContract = "session-settings-contract"
    case sessionSettingsCAS = "session-settings-cas-v1"
    case systemAgentSetupModelRef = "openclaw-setup-model-ref"
}

extension HelloOk {
    /// nil when the hello carries no method catalog: gates must treat that as
    /// unknown, not "advertises nothing", so pre-catalog gateways keep working.
    public func advertisedServerMethods() -> Set<String>? {
        guard let values = features["methods"]?.value as? [AnyCodable] else { return nil }
        return Set(values.compactMap { $0.value as? String })
    }

    public func supportsServerCapability(_ capability: GatewayServerCapability) -> Bool {
        let values = features["capabilities"]?.value as? [AnyCodable] ?? []
        return values.contains { ($0.value as? String) == capability.rawValue }
    }

    /// The hello grant is authoritative for this socket. Persisted device-token
    /// scopes may be broader after reconnect or narrower after a downgrade.
    public func advertisedOperatorScopes() -> Set<String>? {
        guard let values = auth["scopes"]?.value as? [AnyCodable] else { return nil }
        return Set(values.compactMap { $0.value as? String })
    }
}

/// Server-push messages from the gateway websocket.
///
/// This is the in-process replacement for the legacy `NotificationCenter` fan-out.
public enum GatewayPush: Sendable {
    /// A full snapshot that arrives on connect (or reconnect).
    case snapshot(HelloOk)
    /// A server push event frame.
    case event(EventFrame)
    /// A detected sequence gap (`expected...received`) for event frames.
    case seqGap(expected: Int, received: Int)
}
