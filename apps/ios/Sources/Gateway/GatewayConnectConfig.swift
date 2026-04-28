import Foundation
import OpenClawKit

/// Single source of truth for "how we connect" to the current gateway.
///
/// The iOS app maintains two WebSocket sessions to the same gateway:
/// - a `role=node` session for device capabilities (`node.invoke.*`)
/// - a `role=operator` session for chat/talk/config (`chat.*`, `talk.*`, etc.)
///
/// Both sessions should derive all connection inputs from this config so we
/// don't accidentally persist gateway-scoped state under different keys.
struct GatewayConnectConfig {
    let url: URL
    let stableID: String
    let tls: GatewayTLSParams?
    let token: String?
    let bootstrapToken: String?
    let password: String?
    let nodeOptions: GatewayConnectOptions

    /// Stable, non-empty identifier used for gateway-scoped persistence keys.
    /// If the caller doesn't provide a stableID, fall back to URL identity.
    var effectiveStableID: String {
        let trimmed = self.stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return self.url.absoluteString }
        return trimmed
    }
}
