import MoltbotProtocol

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
