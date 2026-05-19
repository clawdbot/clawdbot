import ActivityKit
import Foundation

/// Shared schema used by iOS app + Live Activity widget extension.
struct OpenClawActivityAttributes: ActivityAttributes {
    var agentName: String
    var sessionKey: String

    struct ContentState: Codable, Hashable {
        var statusText: String
        var isIdle: Bool
        var isDisconnected: Bool
        var isConnecting: Bool
        var startedAt: Date
    }
}

#if DEBUG
extension OpenClawActivityAttributes {
    static let preview = OpenClawActivityAttributes(agentName: "main", sessionKey: "main")
}

extension OpenClawActivityAttributes.ContentState {
    static let connecting = OpenClawActivityAttributes.ContentState(
        statusText: "Connecting...",
        isIdle: false,
        isDisconnected: false,
        isConnecting: true,
        startedAt: .now)

    static let idle = OpenClawActivityAttributes.ContentState(
        statusText: "Idle",
        isIdle: true,
        isDisconnected: false,
        isConnecting: false,
        startedAt: .now)

    static let disconnected = OpenClawActivityAttributes.ContentState(
        statusText: "Disconnected",
        isIdle: false,
        isDisconnected: true,
        isConnecting: false,
        startedAt: .now)

    static let attention = OpenClawActivityAttributes.ContentState(
        statusText: "Approval needed",
        isIdle: false,
        isDisconnected: false,
        isConnecting: false,
        startedAt: .now)
}
#endif
