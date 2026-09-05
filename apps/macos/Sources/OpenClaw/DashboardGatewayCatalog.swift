import Foundation
import OpenClawKit

enum DashboardGatewayTarget: Equatable, Hashable, Sendable {
    case primary
    case profile(String)

    init?(bridgeID: String) {
        if bridgeID == "primary" {
            self = .primary
            return
        }
        guard bridgeID.hasPrefix("profile:"), bridgeID.count > "profile:".count else { return nil }
        self = .profile(String(bridgeID.dropFirst("profile:".count)))
    }

    var bridgeID: String {
        switch self {
        case .primary:
            "primary"
        case let .profile(profileID):
            "profile:\(profileID)"
        }
    }
}

enum DashboardGatewayHealth: String, Codable, Equatable, Sendable {
    case ok
    case error
    case unknown
}

struct DashboardGatewayEntry: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let kind: String
    let isPrimary: Bool
    let canPromote: Bool
    let health: DashboardGatewayHealth
}

struct DashboardGatewaySnapshot: Codable, Equatable, Sendable {
    let gateways: [DashboardGatewayEntry]
    let currentId: String
}

struct MacGatewayCatalogProfile: Equatable, Sendable {
    let profile: MacGatewayProfile
    let canPromote: Bool
    var usesBrowserIdentity = false
}

enum DashboardGatewayCatalog {
    static func entries(
        mode: AppState.ConnectionMode,
        primaryRemoteURL: URL?,
        resolvedRemoteURL: URL?,
        resolvedRemoteHostLabel: String?,
        profiles: [MacGatewayCatalogProfile],
        primaryHealth: DashboardGatewayHealth) -> [DashboardGatewayEntry]
    {
        let canonicalPrimaryURL = mode == .remote
            ? (resolvedRemoteURL ?? primaryRemoteURL).flatMap {
                try? MacGatewayProfileStore.canonicalURL($0)
            }
            : nil
        let duplicate = canonicalPrimaryURL.flatMap { primaryURL in
            profiles.first {
                !$0.usesBrowserIdentity && (try? MacGatewayProfileStore.canonicalURL($0.profile.url)) == primaryURL
            }
        }
        let primaryName: String = if mode == .local {
            "Local Gateway"
        } else if let duplicate {
            duplicate.profile.name
        } else {
            resolvedRemoteHostLabel?.nonEmpty ?? canonicalPrimaryURL?.host ?? "Remote Gateway"
        }
        let primary = DashboardGatewayEntry(
            id: DashboardGatewayTarget.primary.bridgeID,
            name: primaryName,
            kind: mode == .local ? "local" : "remote",
            isPrimary: true,
            canPromote: false,
            health: primaryHealth)
        let saved = profiles.compactMap { item -> DashboardGatewayEntry? in
            // A browser sign-in is a separate human authority even when its
            // address matches the primary machine connection.
            if item.profile.id == duplicate?.profile.id { return nil }
            return DashboardGatewayEntry(
                id: DashboardGatewayTarget.profile(item.profile.id).bridgeID,
                name: item.profile.name,
                kind: "remote",
                isPrimary: false,
                canPromote: item.canPromote,
                health: .unknown)
        }
        return [primary] + saved
    }

    @MainActor
    static func primaryHealth(for state: ControlChannel.ConnectionState) -> DashboardGatewayHealth {
        switch state {
        case .connected: .ok
        case .degraded: .error
        case .connecting, .disconnected: .unknown
        }
    }

    @MainActor
    static func loadEntries() async throws -> [DashboardGatewayEntry] {
        let state = AppStateStore.shared
        let root = OpenClawConfigFile.loadDict()
        let profiles = try await MacGatewayProfileStore.shared.catalogProfiles()
        let connectivity = GatewayConnectivityCoordinator.shared
        let resolvedRemoteURL: URL? = if case let .ready(mode, url, _, _, _) = connectivity.endpointState,
                                         mode == .remote
        {
            url
        } else {
            nil
        }
        return self.entries(
            mode: state.connectionMode,
            primaryRemoteURL: GatewayRemoteConfig.resolveGatewayUrl(root: root),
            resolvedRemoteURL: resolvedRemoteURL,
            resolvedRemoteHostLabel: connectivity.resolvedHostLabel,
            profiles: profiles,
            primaryHealth: self.primaryHealth(for: ControlChannel.shared.state))
    }
}

enum DashboardPrimaryGatewayError: LocalizedError, Equatable {
    case notPromotable
    case passwordUnsupported

    var errorDescription: String? {
        switch self {
        case .notPromotable:
            "This Gateway cannot be set as primary."
        case .passwordUnsupported:
            "Password authentication is not supported by the Mac app's primary Gateway connection. Use a token instead."
        }
    }
}

@MainActor
struct DashboardPrimaryGatewayAdapter {
    let state: AppState
    var endpoint: @Sendable (String) async throws -> GatewayConnection.EndpointSnapshot = { profileID in
        try await MacGatewayProfileStore.shared.endpoint(profileID: profileID)
    }

    var persist: @MainActor (AppState, AppState.PrimaryGatewayConfiguration) -> Bool = {
        $0.replacePrimaryGateway($1)
    }

    func apply(profileID: String) async throws {
        let endpoint = try await self.endpoint(profileID)
        guard let token = endpoint.config.token?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        else {
            throw DashboardPrimaryGatewayError.notPromotable
        }
        let tlsFingerprint = endpoint.tls.flatMap { route in
            route.params.expectedFingerprint ?? route.params.storeKey.flatMap {
                GatewayTLSStore.loadFingerprint(stableID: $0)
            }
        }
        try self.apply(url: endpoint.config.url, token: token, tlsFingerprint: tlsFingerprint)
    }

    func apply(link: GatewayConnectDeepLink) throws {
        if link.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty != nil {
            throw DashboardPrimaryGatewayError.passwordUnsupported
        }
        guard let url = link.websocketURL else {
            throw DashboardPrimaryGatewayError.notPromotable
        }
        try self.apply(
            url: url,
            token: link.token?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
            tlsFingerprint: nil)
    }

    private func apply(url: URL, token: String?, tlsFingerprint: String?) throws {
        let configuration = AppState.PrimaryGatewayConfiguration(url: url, token: token, tlsFingerprint: tlsFingerprint)
        guard self.persist(self.state, configuration) else {
            throw DashboardPrimaryGatewayError.notPromotable
        }
    }
}

@MainActor
struct DashboardGatewaySetupCoordinator {
    let adapter: DashboardPrimaryGatewayAdapter
    let confirm: (_ title: String, _ message: String) -> Bool
    let presentError: (_ title: String, _ message: String) -> Void
    let openConnectionSettings: () -> Void

    func handle(_ link: GatewayConnectDeepLink) {
        if link.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty != nil {
            self.presentError(
                "Gateway Setup Not Supported",
                DashboardPrimaryGatewayError.passwordUnsupported.localizedDescription)
            return
        }
        let endpoint = "\(link.host):\(link.port)"
        let transport = link.tls ? "TLS" : "an unencrypted private-network connection"
        guard self.confirm(
            "Change the primary Gateway?",
            "Connect the Mac app directly to \(endpoint) using \(transport)?")
        else { return }
        do {
            try self.adapter.apply(link: link)
            self.openConnectionSettings()
        } catch {
            self.presentError("Could Not Change Primary Gateway", error.localizedDescription)
        }
    }
}
