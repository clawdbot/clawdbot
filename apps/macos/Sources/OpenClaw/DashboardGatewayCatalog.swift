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
            profiles.first { (try? MacGatewayProfileStore.canonicalURL($0.profile.url)) == primaryURL }
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
            // A saved identity for the active route is represented by the
            // primary row so one physical Gateway never appears twice.
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

    var errorDescription: String? {
        "This Gateway cannot be set as primary."
    }
}

@MainActor
struct DashboardPrimaryGatewayAdapter {
    let state: AppState
    var endpoint: @Sendable (String) async throws -> GatewayConnection.EndpointSnapshot = { profileID in
        try await MacGatewayProfileStore.shared.endpoint(profileID: profileID)
    }

    var currentTLSFingerprint: @MainActor () -> String? = {
        GatewayRemoteConfig.resolveTLSFingerprint(root: OpenClawConfigFile.loadDict())
    }

    var persist: @MainActor (AppState, String?) -> Bool = {
        $0.syncGatewayConfigNow(remoteTLSFingerprint: $1)
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
        let previous = (
            transport: self.state.remoteTransport,
            url: self.state.remoteUrl,
            token: self.state.remoteToken,
            mode: self.state.connectionMode,
            tlsFingerprint: self.currentTLSFingerprint())
        self.state.remoteTransport = .direct
        self.state.remoteUrl = endpoint.config.url.absoluteString
        // Promotion intentionally moves the saved token into gateway.remote.token,
        // matching the existing Settings connection flow.
        self.state.remoteToken = token
        self.state.connectionMode = .remote
        guard self.persist(self.state, tlsFingerprint) else {
            self.state.remoteTransport = previous.transport
            self.state.remoteUrl = previous.url
            self.state.remoteToken = previous.token
            self.state.connectionMode = previous.mode
            _ = self.persist(self.state, previous.tlsFingerprint)
            throw DashboardPrimaryGatewayError.notPromotable
        }
    }
}
