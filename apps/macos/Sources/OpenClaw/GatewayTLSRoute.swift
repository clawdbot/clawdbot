import Foundation
import OpenClawKit

struct GatewayTLSRoute: Equatable, Sendable {
    let params: GatewayTLSParams
    let allowsTrustedPinReplacement: Bool

    static func resolve(
        url: URL,
        connectionMode: AppState.ConnectionMode,
        configuredFingerprint: String?,
        storeKey: String? = nil) -> GatewayTLSRoute?
    {
        guard url.scheme?.lowercased() == "wss" else { return nil }
        let storeKey = storeKey ?? self.storeKey(for: url)
        let stored = GatewayTLSStore.loadFingerprint(stableID: storeKey)
        return self.resolve(
            url: url,
            connectionMode: connectionMode,
            configuredFingerprint: configuredFingerprint,
            storedFingerprint: stored,
            storeKey: storeKey)
    }

    static func resolve(
        url: URL,
        connectionMode: AppState.ConnectionMode,
        configuredFingerprint: String?,
        storedFingerprint: String?,
        storeKey: String? = nil) -> GatewayTLSRoute?
    {
        guard url.scheme?.lowercased() == "wss" else { return nil }
        let storeKey = storeKey ?? self.storeKey(for: url)
        let configured = connectionMode == .remote
            ? configuredFingerprint?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            : nil
        let expected = configured ?? storedFingerprint
        return GatewayTLSRoute(
            params: GatewayTLSParams(
                required: true,
                expectedFingerprint: expected,
                allowTOFU: expected == nil,
                storeKey: storeKey),
            allowsTrustedPinReplacement: configured == nil)
    }

    static func storeKey(for url: URL) -> String {
        let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "gateway"
        return "\(host):\(url.port ?? 443)"
    }

    static func hasSameConnectionIdentity(
        _ lhs: GatewayTLSRoute?,
        _ rhs: GatewayTLSRoute?) -> Bool
    {
        switch (lhs, rhs) {
        case (nil, nil):
            true
        case let (lhs?, rhs?):
            lhs.hasSameConnectionIdentity(as: rhs)
        default:
            false
        }
    }

    func hasSameConnectionIdentity(as other: GatewayTLSRoute) -> Bool {
        if self == other {
            return true
        }
        guard self.params.required == other.params.required,
              self.params.storeKey == other.params.storeKey,
              self.allowsTrustedPinReplacement,
              other.allowsTrustedPinReplacement
        else { return false }

        let firstUseRoute: GatewayTLSRoute
        let persistedRoute: GatewayTLSRoute
        if self.params.allowTOFU, self.params.expectedFingerprint == nil {
            firstUseRoute = self
            persistedRoute = other
        } else if other.params.allowTOFU, other.params.expectedFingerprint == nil {
            firstUseRoute = other
            persistedRoute = self
        } else {
            return false
        }
        guard firstUseRoute.params.storeKey == persistedRoute.params.storeKey,
              !persistedRoute.params.allowTOFU,
              let storeKey = persistedRoute.params.storeKey,
              let expectedFingerprint = persistedRoute.params.expectedFingerprint
        else { return false }
        return GatewayTLSStore.claimedFirstUseFingerprint(stableID: storeKey) == expectedFingerprint
    }

    func permitsTrustedPinReplacement(
        url: URL,
        failure: GatewayTLSValidationFailure) -> Bool
    {
        let routeHost = url.host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().nonEmpty
        let challengedHost = failure.host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().nonEmpty
        guard self.allowsTrustedPinReplacement,
              failure.kind == .pinMismatch,
              failure.systemTrustOk,
              url.scheme?.lowercased() == "wss",
              failure.storeKey == self.params.storeKey,
              let routeHost,
              challengedHost == routeHost,
              failure.port == (url.port ?? 443)
        else { return false }

        return LoopbackHost.isLoopback(routeHost) || routeHost == "ts.net" || routeHost.hasSuffix(".ts.net")
    }
}

actor GatewayTLSRepairCoordinator {
    static let shared = GatewayTLSRepairCoordinator()

    func repair(
        route: GatewayTLSRoute?,
        url: URL,
        failure: GatewayTLSValidationFailure) -> Bool
    {
        guard let route,
              route.permitsTrustedPinReplacement(url: url, failure: failure),
              let storeKey = failure.storeKey,
              let observedFingerprint = failure.observedFingerprint
        else { return false }

        if GatewayTLSStore.loadFingerprint(stableID: storeKey) == observedFingerprint {
            return true
        }
        guard route.params.expectedFingerprint != nil,
              let failedFingerprint = failure.expectedFingerprint
        else { return false }
        return GatewayTLSStore.replaceFingerprint(
            observedFingerprint,
            ifCurrent: failedFingerprint,
            stableID: storeKey)
    }
}
