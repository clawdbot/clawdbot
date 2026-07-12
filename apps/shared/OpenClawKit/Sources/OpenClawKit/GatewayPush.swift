import OpenClawProtocol

public enum GatewayServerCapability: String, CaseIterable, Sendable {
    case chatSendRoutingContract = "chat-send-routing-contract"
    case crestodianSetupModelRef = "crestodian-setup-model-ref"
}

extension HelloOk {
    func advertisedServerMethods() -> Set<String> {
        let values = features["methods"]?.value as? [AnyCodable] ?? []
        return Set(values.compactMap { $0.value as? String })
    }

    public func supportsServerCapability(_ capability: GatewayServerCapability) -> Bool {
        let values = features["capabilities"]?.value as? [AnyCodable] ?? []
        return values.contains { ($0.value as? String) == capability.rawValue }
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
