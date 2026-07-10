import Foundation
import OpenClawKit

/// Single source of truth for "how we connect" to the current gateway.
///
/// The iOS app maintains two WebSocket sessions to the same gateway:
/// - a `role=node` session for device capabilities (`node.invoke.*`)
/// - a `role=operator` session for chat/talk/config (`chat.*`, `talk.*`, etc.)
///
/// Both sessions derive routing and authentication ownership from the route's
/// `stableID`. TLS certificate pins prove transport trust but are not gateway identity.
struct GatewayConnectConfig {
    let url: URL
    let stableID: String
    let tls: GatewayTLSParams?
    let token: String?
    let bootstrapToken: String?
    let password: String?
    let nodeOptions: GatewayConnectOptions

    /// Stable, non-empty route identifier used for UI/event ownership.
    /// If the caller doesn't provide a stableID, fall back to URL identity.
    var effectiveStableID: String {
        let trimmed = self.stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return self.url.absoluteString }
        return trimmed
    }

    func hasSameConnectionInputs(as other: GatewayConnectConfig) -> Bool {
        self.url == other.url &&
            self.stableID == other.stableID &&
            Self.sameTLS(self.tls, other.tls) &&
            self.token == other.token &&
            self.bootstrapToken == other.bootstrapToken &&
            self.password == other.password &&
            Self.sameOptions(self.nodeOptions, other.nodeOptions)
    }

    private static func sameTLS(_ lhs: GatewayTLSParams?, _ rhs: GatewayTLSParams?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil):
            true
        case let (lhs?, rhs?):
            lhs.required == rhs.required &&
                lhs.expectedFingerprint == rhs.expectedFingerprint &&
                lhs.allowTOFU == rhs.allowTOFU &&
                lhs.storeKey == rhs.storeKey
        default:
            false
        }
    }

    private static func sameOptions(_ lhs: GatewayConnectOptions, _ rhs: GatewayConnectOptions) -> Bool {
        let lhsScopes = Self.normalizedValues(lhs.scopes)
        let rhsScopes = Self.normalizedValues(rhs.scopes)
        let lhsCaps = Self.normalizedValues(lhs.caps)
        let rhsCaps = Self.normalizedValues(rhs.caps)
        let lhsCommands = Self.normalizedValues(lhs.commands)
        let rhsCommands = Self.normalizedValues(rhs.commands)
        return lhs.role == rhs.role &&
            lhs.scopesAreExplicit == rhs.scopesAreExplicit &&
            lhs.clientId == rhs.clientId &&
            lhs.clientMode == rhs.clientMode &&
            lhs.clientDisplayName == rhs.clientDisplayName &&
            lhs.deviceIdentityProfile == rhs.deviceIdentityProfile &&
            lhs.includeDeviceIdentity == rhs.includeDeviceIdentity &&
            lhs.allowStoredDeviceAuth == rhs.allowStoredDeviceAuth &&
            lhs.deviceAuthGatewayID == rhs.deviceAuthGatewayID &&
            lhsScopes == rhsScopes &&
            lhsCaps == rhsCaps &&
            lhsCommands == rhsCommands &&
            lhs.permissions == rhs.permissions
    }

    private static func normalizedValues(_ values: [String]) -> [String] {
        values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .sorted()
    }
}
