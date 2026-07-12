import Foundation
import Network
import Observation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

typealias GatewayTCPReachabilityProbe = @Sendable (String, Int, Double, String) async -> Bool
typealias GatewayServiceEndpointResolver = @Sendable (NWEndpoint) async -> (host: String, port: Int)?
typealias GatewayForceReconnectReset = @MainActor (NodeAppModel) async -> Void
typealias GatewayTLSFingerprintPersist = @Sendable (_ fingerprint: String, _ stableID: String) -> Bool

private enum GatewaySetupRouteProbeBudget {
    static let tcpConnectTimeoutSeconds = 2.0
}

private func defaultGatewayTCPReachabilityProbe(
    host: String,
    port: Int,
    timeoutSeconds: Double,
    queueLabel: String) async -> Bool
{
    await TCPProbe.probe(host: host, port: port, timeoutSeconds: timeoutSeconds, queueLabel: queueLabel)
}

@MainActor
@Observable
final class GatewayConnectionController {
    enum DiscoveredGatewayConnectionAvailability: Equatable {
        case available
        case secureTransportRequired

        var canConnect: Bool {
            self == .available
        }

        var actionTitle: String {
            switch self {
            case .available:
                String(localized: "Connect")
            case .secureTransportRequired:
                String(localized: "TLS required")
            }
        }

        var guidanceText: String? {
            switch self {
            case .available:
                nil
            case .secureTransportRequired:
                String(localized: """
                Enable Gateway TLS, or enter your Tailscale Serve HTTPS host in Manual Setup. \
                Use Unencrypted only with a trusted private-LAN address.
                """)
            }
        }
    }

    static func resolvedManualPort(host: String, port: Int) -> Int? {
        if port > 0 {
            return port <= 65535 ? port : nil
        }
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmedHost.isEmpty else { return nil }
        if trimmedHost.hasSuffix(".ts.net") || trimmedHost.hasSuffix(".ts.net.") {
            return 443
        }
        return 18789
    }

    struct TrustPrompt: Identifiable, Equatable {
        let stableID: String
        let gatewayName: String
        let host: String
        let port: Int
        let fingerprintSha256: String
        let isManual: Bool

        var id: String {
            self.stableID
        }
    }

    struct AutoConnectSuppressionLease {
        fileprivate let generation: UInt64
        fileprivate let previousAutoReconnectEnabled: Bool
        fileprivate let restoresAutoReconnect: Bool
        fileprivate let suspendedConfig: GatewayConnectConfig?
    }

    private(set) var gateways: [GatewayDiscoveryModel.DiscoveredGateway] = []
    private(set) var discoveryStatusText: String = "Idle"
    private(set) var discoveryDebugLog: [GatewayDiscoveryModel.DebugLogEntry] = []
    private(set) var pendingTrustPrompt: TrustPrompt?

    private let discovery = GatewayDiscoveryModel()
    private let discoveryEnabled: Bool
    private weak var appModel: NodeAppModel?
    private var localNetworkAccessRequested: Bool
    private var currentScenePhase: ScenePhase = .inactive
    private var didAutoConnect = false
    private var pendingServiceResolvers: [String: GatewayServiceResolver] = [:]
    private var pendingTrustConnect: GatewayPendingTrustConnect?
    private var trustProbeGeneration: UInt64 = 0
    private var connectAttemptGeneration: UInt64 = 0
    private var autoConnectSuppressionGeneration: UInt64?
    private var autoConnectSuppressionBaseline: (
        autoReconnectEnabled: Bool,
        restoresAutoReconnect: Bool,
        suspendedConfig: GatewayConnectConfig?)?
    @ObservationIgnored private var pendingAutoConnectTask: Task<Void, Never>?
    @ObservationIgnored private var pendingAutoConnectGeneration: UInt64?
    @ObservationIgnored private var pendingAutoConnectSuppressionGeneration: UInt64?
    @ObservationIgnored private var pendingForgetCleanups: [
        GatewayStableIdentifier.Key: (id: UUID, task: Task<Void, Never>)
    ] = [:]
    private var pendingConnectionStableID: String?
    private let tcpReachabilityProbe: GatewayTCPReachabilityProbe
    private let tlsFingerprintProbe: GatewayTLSFingerprintProbeFunction
    private let serviceEndpointResolver: GatewayServiceEndpointResolver?
    private let forceReconnectReset: GatewayForceReconnectReset
    private let persistTLSFingerprint: GatewayTLSFingerprintPersist

    init(
        appModel: NodeAppModel,
        startDiscovery: Bool = true,
        deferDiscoveryUntilLocalNetworkRequest: Bool = false,
        tcpReachabilityProbe: @escaping GatewayTCPReachabilityProbe = defaultGatewayTCPReachabilityProbe,
        tlsFingerprintProbe: @escaping GatewayTLSFingerprintProbeFunction = defaultGatewayTLSFingerprintProbe,
        serviceEndpointResolver: GatewayServiceEndpointResolver? = nil,
        forceReconnectReset: @escaping GatewayForceReconnectReset = { appModel in
            await appModel.resetGatewaySessionsForForcedReconnect()
        },
        persistTLSFingerprint: @escaping GatewayTLSFingerprintPersist = { fingerprint, stableID in
            GatewayTLSStore.replaceFingerprint(fingerprint, stableID: stableID)
        })
    {
        self.discoveryEnabled = startDiscovery
        self.appModel = appModel
        self.localNetworkAccessRequested = !deferDiscoveryUntilLocalNetworkRequest
        self.tcpReachabilityProbe = tcpReachabilityProbe
        self.tlsFingerprintProbe = tlsFingerprintProbe
        self.serviceEndpointResolver = serviceEndpointResolver
        self.forceReconnectReset = forceReconnectReset
        self.persistTLSFingerprint = persistTLSFingerprint

        GatewaySettingsStore.bootstrapPersistence()
        Self.migrateLegacyDeviceAuth()
        let defaults = UserDefaults.standard
        self.discovery.setDebugLoggingEnabled(defaults.bool(forKey: "gateway.discovery.debugLogs"))

        self.updateFromDiscovery()
        self.observeDiscovery()

        if self.discoveryEnabled, self.localNetworkAccessRequested {
            self.discovery.start()
        }
    }

    func setDiscoveryDebugLoggingEnabled(_ enabled: Bool) {
        self.discovery.setDebugLoggingEnabled(enabled)
    }

    func selectReachableSetupLink(_ link: GatewayConnectDeepLink) async -> GatewayConnectDeepLink {
        let endpoints = link.connectionEndpoints
        guard endpoints.count > 1 else { return link }
        // Probe before persisting: a setup code may carry LAN and Tailnet routes,
        // but only the route reachable from the phone should become its saved endpoint.
        self.requestLocalNetworkAccess(reason: "setup_route_probe")
        for (index, endpoint) in endpoints.enumerated() {
            let reachable = await self.tcpReachabilityProbe(
                endpoint.host,
                endpoint.port,
                GatewaySetupRouteProbeBudget.tcpConnectTimeoutSeconds,
                "ai.openclaw.gateway.setup-route-\(index)")
            if reachable {
                return link.selectingEndpoint(endpoint)
            }
        }
        return link
    }

    func requestLocalNetworkAccess(reason: String, allowAutoReconnect: Bool = true) {
        guard self.discoveryEnabled else {
            self.discovery.stop()
            self.updateFromDiscovery(allowAutoConnect: allowAutoReconnect)
            return
        }

        self.localNetworkAccessRequested = true
        GatewayDiagnostics.log("local network access requested reason=\(reason)")

        guard self.currentScenePhase != .background else { return }
        self.discovery.start()
        self.updateFromDiscovery(allowAutoConnect: allowAutoReconnect)
        guard allowAutoReconnect else { return }
        self.attemptAutoReconnectIfNeeded()
    }

    func setScenePhase(_ phase: ScenePhase) {
        self.currentScenePhase = phase
        guard self.discoveryEnabled else {
            self.discovery.stop()
            return
        }
        guard self.localNetworkAccessRequested else { return }

        switch phase {
        case .background:
            self.discovery.stop()
        case .active, .inactive:
            self.discovery.start()
            self.attemptAutoReconnectIfNeeded()
        @unknown default:
            self.discovery.start()
            self.attemptAutoReconnectIfNeeded()
        }
    }

    func restartDiscovery() {
        guard self.discoveryEnabled else {
            self.discovery.stop()
            self.updateFromDiscovery()
            return
        }
        guard self.localNetworkAccessRequested else {
            self.requestLocalNetworkAccess(reason: "restart_discovery")
            return
        }

        self.discovery.stop()
        self.didAutoConnect = false
        self.discovery.start()
        self.updateFromDiscovery()
    }

    /// Returns `nil` when a connect attempt was started, otherwise returns a user-facing error.
    func connectWithDiagnostics(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async -> String? {
        await self.connectDiscoveredGateway(gateway)
    }

    func discoveredGatewayConnectionAvailability(
        _ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> DiscoveredGatewayConnectionAvailability
    {
        if gateway.tlsEnabled || GatewayTLSStore.loadFingerprint(stableID: gateway.stableID) != nil {
            return .available
        }
        return .secureTransportRequired
    }

    func preferredDiscoveredGateway() -> GatewayDiscoveryModel.DiscoveredGateway? {
        self.gateways.first(where: {
            self.discoveredGatewayConnectionAvailability($0).canConnect
        }) ?? self.gateways.first
    }

    private func connectDiscoveredGateway(
        _ gateway: GatewayDiscoveryModel.DiscoveredGateway,
        forceReconnect: Bool = false) async -> String?
    {
        let availability = self.discoveredGatewayConnectionAvailability(gateway)
        guard availability.canConnect else { return availability.guidanceText }

        let connectAttempt = self.beginConnectAttempt()
        self.pendingConnectionStableID = gateway.stableID
        defer { self.finishConnectAttempt(connectAttempt.suppressionLease) }
        await self.waitForPendingForgetCleanup(stableID: gateway.stableID)
        guard self.connectAttemptGeneration == connectAttempt.suppressionLease.generation else { return nil }
        self.requestLocalNetworkAccess(reason: "connect_discovered_gateway", allowAutoReconnect: false)
        let instanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if instanceId.isEmpty {
            return "Missing instanceId (node.instanceId). Try restarting the app."
        }
        // Resolve the service endpoint (SRV/A/AAAA). TXT is unauthenticated; do not route via TXT.
        let target = if let serviceEndpointResolver {
            await serviceEndpointResolver(gateway.endpoint)
        } else {
            await self.resolveServiceEndpoint(gateway.endpoint)
        }
        guard self.connectAttemptGeneration == connectAttempt.suppressionLease.generation else { return nil }
        guard let target else {
            return "Failed to resolve the discovered gateway endpoint."
        }

        let stableID = gateway.stableID
        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceId,
            gatewayStableID: stableID)
        // Discovery is a LAN operation; refuse unauthenticated plaintext connects.
        let tlsRequired = true
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)

        if tlsRequired, stored == nil {
            guard let url = self.buildGatewayURL(host: target.host, port: target.port, useTLS: true)
            else { return "Failed to build TLS URL for trust verification." }
            self.appModel?.beginGatewayPreconnectVerification(statusText: "Verifying gateway TLS fingerprint…")
            guard let probeResult = await self.probeTLSFingerprint(
                host: target.host,
                port: target.port,
                url: url,
                queueLabel: "gateway.tls.discovered")
            else { return nil }
            guard self.connectAttemptGeneration == connectAttempt.suppressionLease.generation else { return nil }
            switch probeResult {
            case let .fingerprint(fp):
                self.pendingTrustConnect = GatewayPendingTrustConnect(
                    url: url,
                    stableID: stableID,
                    isManual: false,
                    authOverride: nil,
                    allowStoredDeviceAuth: true,
                    suppressionLease: connectAttempt.suppressionLease,
                    gatewayGeneration: connectAttempt.gatewayGeneration)
                self.pendingTrustPrompt = TrustPrompt(
                    stableID: stableID,
                    gatewayName: gateway.name,
                    host: target.host,
                    port: target.port,
                    fingerprintSha256: fp,
                    isManual: false)
                self.appModel?.gatewayStatusText = "Verify gateway TLS fingerprint"
                return nil
            case let .failure(failure):
                let message = self.tlsProbeFailureMessage(
                    failure,
                    host: target.host,
                    port: target.port)
                self.appModel?.gatewayStatusText = message
                return message
            }
        }

        let tlsParams = stored.map { fp in
            GatewayTLSParams(required: true, expectedFingerprint: fp, allowTOFU: false, storeKey: stableID)
        }

        guard let url = self.buildGatewayURL(
            host: target.host,
            port: target.port,
            useTLS: tlsParams?.required == true)
        else { return "Failed to build discovered gateway URL." }
        let registryEntry = GatewaySettingsStore.GatewayRegistryEntry(
            stableID: stableID,
            kind: .discovered,
            name: gateway.name,
            host: nil,
            port: nil,
            useTLS: true,
            lastConnectedAtMs: nil)
        guard self.persistActiveGateway(registryEntry) else {
            return "Could not save the paired gateway."
        }
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: credentials.token,
            bootstrapToken: credentials.bootstrapToken,
            password: credentials.password,
            allowStoredDeviceAuth: !credentials.suppressStoredDeviceAuth,
            forceReconnect: forceReconnect,
            suppressionGeneration: connectAttempt.suppressionLease.generation,
            expectedGeneration: connectAttempt.gatewayGeneration)
        return nil
    }

    func connect(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        _ = await self.connectWithDiagnostics(gateway)
    }

    func connectManual(
        host: String,
        port: Int,
        useTLS: Bool,
        authOverride: ManualAuthOverride? = nil,
        forceReconnect: Bool = false) async
    {
        let connectAttempt = self.beginConnectAttempt()
        defer { self.finishConnectAttempt(connectAttempt.suppressionLease) }
        self.requestLocalNetworkAccess(reason: "connect_manual", allowAutoReconnect: false)
        let resolvedUseTLS = self.resolveManualUseTLS(host: host, useTLS: useTLS)
        guard let resolvedPort = Self.resolvedManualPort(host: host, port: port)
        else { return }
        let stableID = self.manualStableID(host: host, port: resolvedPort)
        self.pendingConnectionStableID = stableID
        await self.waitForPendingForgetCleanup(stableID: stableID)
        guard self.connectAttemptGeneration == connectAttempt.suppressionLease.generation else { return }
        let instanceId = GatewaySettingsStore.currentInstanceID()
        let storedCredentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceId,
            gatewayStableID: stableID)
        let token = authOverride.map(\.token) ?? storedCredentials.token
        let bootstrapToken = authOverride.map(\.bootstrapToken) ?? storedCredentials.bootstrapToken
        let password = authOverride.map(\.password) ?? storedCredentials.password
        let suppressStoredDeviceAuth =
            authOverride?.suppressStoredDeviceAuth ?? storedCredentials.suppressStoredDeviceAuth
        let pendingAuthOverride = authOverride ?? (storedCredentials.hasCredentials
            ? ManualAuthOverride.explicit(
                token: token,
                bootstrapToken: bootstrapToken,
                password: password,
                targetStableID: stableID,
                suppressStoredDeviceAuth: suppressStoredDeviceAuth)
            : nil)
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        if resolvedUseTLS, stored == nil {
            guard let url = self.buildGatewayURL(host: host, port: resolvedPort, useTLS: true) else { return }
            self.appModel?.beginGatewayPreconnectVerification(statusText: "Verifying gateway TLS fingerprint…")
            guard let probeResult = await self.probeTLSFingerprint(
                host: host,
                port: resolvedPort,
                url: url,
                queueLabel: "gateway.tls.manual")
            else { return }
            guard self.connectAttemptGeneration == connectAttempt.suppressionLease.generation else { return }
            switch probeResult {
            case let .fingerprint(fp):
                self.pendingTrustConnect = GatewayPendingTrustConnect(
                    url: url,
                    stableID: stableID,
                    isManual: true,
                    authOverride: pendingAuthOverride,
                    allowStoredDeviceAuth: !suppressStoredDeviceAuth,
                    suppressionLease: connectAttempt.suppressionLease,
                    gatewayGeneration: connectAttempt.gatewayGeneration)
                self.pendingTrustPrompt = TrustPrompt(
                    stableID: stableID,
                    gatewayName: "\(host):\(resolvedPort)",
                    host: host,
                    port: resolvedPort,
                    fingerprintSha256: fp,
                    isManual: true)
                self.appModel?.gatewayStatusText = "Verify gateway TLS fingerprint"
                return
            case let .failure(failure):
                self.appModel?.gatewayStatusText = self.tlsProbeFailureMessage(
                    failure,
                    host: host,
                    port: resolvedPort)
                return
            }
        }

        let tlsParams = stored.map { fp in
            GatewayTLSParams(required: true, expectedFingerprint: fp, allowTOFU: false, storeKey: stableID)
        }
        guard let url = self.buildGatewayURL(
            host: host,
            port: resolvedPort,
            useTLS: tlsParams?.required == true)
        else { return }
        let registryEntry = GatewaySettingsStore.GatewayRegistryEntry(
            stableID: stableID,
            kind: .manual,
            name: "\(host):\(resolvedPort)",
            host: host,
            port: resolvedPort,
            useTLS: resolvedUseTLS && tlsParams != nil,
            lastConnectedAtMs: nil)
        guard self.persistActiveGateway(registryEntry) else { return }
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            allowStoredDeviceAuth: !suppressStoredDeviceAuth,
            forceReconnect: forceReconnect,
            suppressionGeneration: connectAttempt.suppressionLease.generation,
            expectedGeneration: connectAttempt.gatewayGeneration)
    }

    func connectActiveGateway() async {
        self.requestLocalNetworkAccess(reason: "connect_active_gateway", allowAutoReconnect: false)
        guard let active = GatewaySettingsStore.activeGatewayEntry() else { return }
        switch active.kind {
        case .manual:
            guard let host = active.host, let port = active.port else { return }
            await self.connectManual(host: host, port: port, useTLS: active.useTLS, forceReconnect: true)
        case .discovered:
            if let gateway = self.gateways.first(where: {
                GatewayStableIdentifier.matches($0.stableID, active.stableID)
            }) {
                _ = await self.connectDiscoveredGateway(gateway, forceReconnect: true)
                return
            }
            guard let fallback = self.mostRecentlyConnectedManualGateway() else { return }
            guard let host = fallback.host, let port = fallback.port else { return }
            await self.connectManual(host: host, port: port, useTLS: fallback.useTLS, forceReconnect: true)
        }
    }

    /// Returns `nil` after initiating a switch, or a user-facing discovery failure.
    func switchToGateway(stableID: String) async -> String? {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else {
            return "This paired gateway is no longer available."
        }
        guard let entry = GatewaySettingsStore.loadGatewayRegistry().entries.first(where: {
            GatewayStableIdentifier.matches($0.stableID, stableID)
        }) else {
            return "This paired gateway is no longer available."
        }
        switch entry.kind {
        case .manual:
            guard let host = entry.host, let port = entry.port else {
                return "This paired gateway has an invalid saved endpoint."
            }
            // Switching intentionally persists the user's selection at initiation, matching connect flows.
            guard GatewaySettingsStore.setActiveGateway(stableID: stableID) else {
                return "Could not save the active gateway selection."
            }
            await self.connectManual(
                host: host,
                port: port,
                useTLS: entry.useTLS,
                forceReconnect: true)
            return nil
        case .discovered:
            guard let gateway = self.gateways.first(where: {
                GatewayStableIdentifier.matches($0.stableID, stableID)
            }) else {
                return "\(entry.name) is not currently discoverable on this network."
            }
            guard GatewaySettingsStore.setActiveGateway(stableID: stableID) else {
                return "Could not save the active gateway selection."
            }
            return await self.connectDiscoveredGateway(gateway, forceReconnect: true)
        }
    }

    @discardableResult
    func forgetGateway(stableID: String) -> Bool {
        guard let stableID = GatewayStableIdentifier.exact(stableID),
              let stableIDKey = GatewayStableIdentifier.key(stableID)
        else { return false }
        if self.pendingForgetCleanups[stableIDKey] != nil {
            return true
        }
        guard GatewaySettingsStore.removeGatewayRegistryEntry(stableID: stableID) else {
            return false
        }
        if GatewayStableIdentifier.matches(self.pendingConnectionStableID, stableID) {
            let cancellationLease = self.cancelPendingConnectionAttempts()
            self.releaseAutoConnectSuppression(after: cancellationLease)
        }
        let wasConnected = GatewayStableIdentifier.matches(
            self.appModel?.activeGatewayConnectConfig?.effectiveStableID,
            stableID) || GatewayStableIdentifier.matches(self.appModel?.connectedGatewayID, stableID)
        let shouldDisconnect = wasConnected
        if shouldDisconnect {
            let hasDifferentPendingTarget = self.pendingConnectionStableID.map {
                !GatewayStableIdentifier.matches($0, stableID)
            } ?? false
            self.appModel?.disconnectForgottenGateway(
                preservingPendingConnectAttempt: hasDifferentPendingTarget)
        }
        let instanceID = GatewaySettingsStore.currentInstanceID()
        self.clearLegacyManualGatewayDefaults(matching: stableID)
        GatewaySettingsStore.clearLegacyGatewaySelectors(stableID: stableID)
        GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID, stableID: stableID)
        _ = GatewaySettingsStore.clearGatewayCustomHeaders(gatewayStableID: stableID)
        _ = GatewayTLSStore.clearFingerprint(stableID: stableID)
        GatewaySettingsStore.saveGatewayClientIdOverride(stableID: stableID, clientId: nil)
        GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: stableID, agentId: nil)
        let shareRelayGatewayID = ShareGatewayRelaySettings.loadConfig()?.gatewayStableID
        if GatewayStableIdentifier.matches(shareRelayGatewayID, stableID) {
            ShareGatewayRelaySettings.clearConfig()
        }

        Self.clearDeviceAuthTokens(gatewayID: stableID)
        let cleanupID = UUID()
        let cleanupTask = Task { @MainActor [weak appModel] in
            if let appModel {
                if shouldDisconnect {
                    await appModel.waitForGatewaySessionResetIfNeeded()
                    // A handshake racing teardown can persist a token after the first cleanup.
                    Self.clearDeviceAuthTokens(gatewayID: stableID)
                }
                await appModel.purgeChatTranscriptCache(gatewayID: stableID)
            } else if let databaseURL = NodeAppModel.chatTranscriptCacheDatabaseURL(gatewayID: stableID) {
                OpenClawChatSQLiteTranscriptCache.removeDatabaseFiles(at: databaseURL)
            }
        }
        self.pendingForgetCleanups[stableIDKey] = (cleanupID, cleanupTask)
        Task { @MainActor [weak self] in
            await cleanupTask.value
            guard self?.pendingForgetCleanups[stableIDKey]?.id == cleanupID else { return }
            self?.pendingForgetCleanups[stableIDKey] = nil
        }
        return true
    }

    private func waitForPendingForgetCleanup(stableID: String) async {
        guard let stableIDKey = GatewayStableIdentifier.key(stableID),
              let pending = self.pendingForgetCleanups[stableIDKey]
        else { return }
        await pending.task.value
        if self.pendingForgetCleanups[stableIDKey]?.id == pending.id {
            self.pendingForgetCleanups[stableIDKey] = nil
        }
    }

    private func persistActiveGateway(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> Bool {
        guard GatewaySettingsStore.upsertGatewayRegistryEntry(entry, activate: true) else {
            self.appModel?.gatewayStatusText = "Could not save paired gateway"
            return false
        }
        return true
    }

    private static func clearDeviceAuthTokens(gatewayID: String) {
        let primaryIdentity = DeviceIdentityStore.loadOrCreate()
        DeviceAuthStore.clearToken(deviceId: primaryIdentity.deviceId, role: "node", gatewayID: gatewayID)
        DeviceAuthStore.clearToken(deviceId: primaryIdentity.deviceId, role: "operator", gatewayID: gatewayID)
        let shareIdentity = DeviceIdentityStore.loadOrCreate(profile: .shareExtension)
        DeviceAuthStore.clearToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            gatewayID: gatewayID,
            profile: .shareExtension)
        DeviceAuthStore.clearToken(
            deviceId: shareIdentity.deviceId,
            role: "operator",
            gatewayID: gatewayID,
            profile: .shareExtension)
    }

    private func clearLegacyManualGatewayDefaults(matching stableID: String) {
        let defaults = UserDefaults.standard
        let host = defaults.string(forKey: "gateway.manual.host")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let port = Self.resolvedManualPort(
            host: host,
            port: defaults.integer(forKey: "gateway.manual.port"))
        guard !host.isEmpty,
              let port,
              GatewayStableIdentifier.matches(self.manualStableID(host: host, port: port), stableID)
        else { return }
        defaults.set(false, forKey: "gateway.manual.enabled")
        defaults.removeObject(forKey: "gateway.manual.host")
        defaults.removeObject(forKey: "gateway.manual.port")
        defaults.removeObject(forKey: "gateway.manual.tls")
    }

    /// Rebuild connect options from current local settings (caps/commands/permissions)
    /// and re-apply the active gateway config so capability changes take effect immediately.
    func refreshActiveGatewayRegistrationFromSettings() {
        Task { [weak self] in
            await self?.refreshActiveGatewayRegistrationFromSettingsAsync()
        }
    }

    private func refreshActiveGatewayRegistrationFromSettingsAsync() async {
        guard let appModel else { return }
        guard let cfg = appModel.activeGatewayConnectConfig else { return }
        guard appModel.gatewayAutoReconnectEnabled else { return }
        let generation = appModel.gatewayConnectGeneration

        let nodeOptions = await self.makeConnectOptions(
            stableID: cfg.stableID,
            deviceAuthGatewayID: cfg.nodeOptions.deviceAuthGatewayID,
            allowStoredDeviceAuth: cfg.nodeOptions.allowStoredDeviceAuth)
        let refreshedConfig = GatewayConnectConfig(
            url: cfg.url,
            stableID: cfg.stableID,
            tls: cfg.tls,
            token: cfg.token,
            bootstrapToken: cfg.bootstrapToken,
            password: cfg.password,
            nodeOptions: nodeOptions)
        appModel.applyGatewayConnectConfig(refreshedConfig, expectedGeneration: generation)
    }

    func clearPendingTrustPrompt() {
        // Invalidate an in-flight probe so its late result cannot restore a stale prompt.
        self.trustProbeGeneration &+= 1
        self.pendingTrustPrompt = nil
        self.pendingTrustConnect = nil
        self.pendingConnectionStableID = nil
    }

    @discardableResult
    func cancelPendingConnectionAttempts(
        suspendCurrentGateway: Bool = false) -> AutoConnectSuppressionLease
    {
        let lease = self.beginAutoConnectSuppression(restoresAutoReconnect: suspendCurrentGateway)
        _ = self.reserveGatewayConnectAttempt()
        if suspendCurrentGateway {
            self.appModel?.suspendGatewayForTargetReview()
        }
        return lease
    }

    private func beginAutoConnectSuppression(restoresAutoReconnect: Bool) -> AutoConnectSuppressionLease {
        let baseline = if self.autoConnectSuppressionGeneration != nil,
                          let baseline = self.autoConnectSuppressionBaseline
        {
            (
                autoReconnectEnabled: baseline.autoReconnectEnabled,
                restoresAutoReconnect: baseline.restoresAutoReconnect || restoresAutoReconnect,
                suspendedConfig: baseline.suspendedConfig ??
                    (restoresAutoReconnect ? self.appModel?.activeGatewayConnectConfig : nil))
        } else {
            (
                autoReconnectEnabled: self.appModel?.gatewayAutoReconnectEnabled ?? false,
                restoresAutoReconnect: restoresAutoReconnect,
                suspendedConfig: restoresAutoReconnect ? self.appModel?.activeGatewayConnectConfig : nil)
        }
        self.connectAttemptGeneration &+= 1
        self.autoConnectSuppressionGeneration = self.connectAttemptGeneration
        self.autoConnectSuppressionBaseline = baseline
        self.clearPendingTrustPrompt()
        return AutoConnectSuppressionLease(
            generation: self.connectAttemptGeneration,
            previousAutoReconnectEnabled: baseline.autoReconnectEnabled,
            restoresAutoReconnect: baseline.restoresAutoReconnect,
            suspendedConfig: baseline.suspendedConfig)
    }

    func resumeAutoConnect(after lease: AutoConnectSuppressionLease) {
        // A dismissed older target must not release suppression owned by its replacement.
        guard self.autoConnectSuppressionGeneration == lease.generation else { return }
        self.clearAutoConnectSuppression(generation: lease.generation)
        if lease.restoresAutoReconnect {
            let currentPreference = UserDefaults.standard.bool(forKey: "gateway.autoconnect")
            if lease.previousAutoReconnectEnabled,
               currentPreference,
               let suspendedConfig = lease.suspendedConfig
            {
                self.appModel?.resumeGatewayAfterTargetReview(suspendedConfig)
                return
            }
            self.appModel?.gatewayAutoReconnectEnabled = lease.previousAutoReconnectEnabled && currentPreference
        }
        self.attemptAutoReconnectIfNeeded()
    }

    func releaseAutoConnectSuppression(after lease: AutoConnectSuppressionLease) {
        self.clearAutoConnectSuppression(generation: lease.generation)
    }

    private func clearAutoConnectSuppression(generation: UInt64) {
        guard self.autoConnectSuppressionGeneration == generation else { return }
        self.autoConnectSuppressionGeneration = nil
        self.autoConnectSuppressionBaseline = nil
    }

    func acceptPendingTrustPrompt() async {
        guard let pending = self.pendingTrustConnect,
              let prompt = self.pendingTrustPrompt,
              GatewayStableIdentifier.matches(pending.stableID, prompt.stableID)
        else { return }

        guard self.persistTLSFingerprint(prompt.fingerprintSha256, pending.stableID) else {
            self.appModel?.gatewayStatusText = "Could not save gateway certificate"
            return
        }

        let instanceId = GatewaySettingsStore.currentInstanceID()
        let registryEntry = GatewaySettingsStore.GatewayRegistryEntry(
            stableID: pending.stableID,
            kind: pending.isManual ? .manual : .discovered,
            name: prompt.gatewayName,
            host: pending.isManual ? prompt.host : nil,
            port: pending.isManual ? prompt.port : nil,
            useTLS: true,
            lastConnectedAtMs: nil)
        guard self.persistActiveGateway(registryEntry) else {
            _ = GatewayTLSStore.clearFingerprint(stableID: pending.stableID)
            return
        }
        self.clearPendingTrustPrompt()
        let storedCredentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceId,
            gatewayStableID: pending.stableID)
        let token = pending.authOverride.map(\.token) ?? storedCredentials.token
        let bootstrapToken = pending.authOverride.map(\.bootstrapToken) ?? storedCredentials.bootstrapToken
        let password = pending.authOverride.map(\.password) ?? storedCredentials.password
        let suppressStoredDeviceAuth =
            pending.authOverride?.suppressStoredDeviceAuth ?? storedCredentials.suppressStoredDeviceAuth
        let tlsParams = GatewayTLSParams(
            required: true,
            expectedFingerprint: prompt.fingerprintSha256,
            allowTOFU: false,
            storeKey: pending.stableID)

        self.didAutoConnect = true
        let didStart = self.startAutoConnect(
            url: pending.url,
            gatewayStableID: pending.stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            allowStoredDeviceAuth: pending.allowStoredDeviceAuth && !suppressStoredDeviceAuth,
            suppressionGeneration: pending.suppressionLease.generation,
            expectedGeneration: pending.gatewayGeneration)
        if !didStart {
            self.clearAutoConnectSuppression(generation: pending.suppressionLease.generation)
        }
    }

    func declinePendingTrustPrompt() {
        let lease = self.pendingTrustConnect?.suppressionLease
        self.clearPendingTrustPrompt()
        self.appModel?.gatewayStatusText = "Offline"
        if let lease {
            self.resumeAutoConnect(after: lease)
        }
    }

    @discardableResult
    func trustRotatedGatewayCertificate(from problem: GatewayConnectionProblem) async -> Bool {
        guard problem.canTrustRotatedCertificate,
              let stableID = problem.tlsStoreKey,
              let fingerprint = problem.tlsObservedFingerprint
        else {
            self.appModel?.gatewayStatusText = "Certificate review required"
            return false
        }

        guard self.persistTLSFingerprint(fingerprint, stableID) else {
            self.appModel?.gatewayStatusText = "Could not update gateway certificate"
            return false
        }

        GatewayDiagnostics.log(
            "gateway tls pin replaced stableID=\(stableID) "
                + "old=\(problem.tlsExpectedFingerprint ?? "unknown") new=\(fingerprint)")
        self.appModel?.gatewayStatusText = "Gateway certificate updated. Reconnecting…"
        if let appModel = self.appModel, let cfg = appModel.activeGatewayConnectConfig {
            let currentTLS = cfg.tls
            let refreshedTLS = GatewayTLSParams(
                required: currentTLS?.required ?? true,
                expectedFingerprint: fingerprint,
                allowTOFU: currentTLS?.allowTOFU ?? false,
                storeKey: currentTLS?.storeKey ?? stableID)
            let refreshedConfig = GatewayConnectConfig(
                url: cfg.url,
                stableID: cfg.stableID,
                tls: refreshedTLS,
                token: cfg.token,
                bootstrapToken: cfg.bootstrapToken,
                password: cfg.password,
                nodeOptions: cfg.nodeOptions)
            appModel.applyGatewayConnectConfig(refreshedConfig)
        } else {
            await self.connectActiveGateway()
        }
        return true
    }
}

extension GatewayConnectionController {
    private func updateFromDiscovery(allowAutoConnect: Bool = true) {
        let newGateways = self.discovery.gateways
        self.gateways = newGateways
        self.discoveryStatusText = self.discovery.statusText
        self.discoveryDebugLog = self.discovery.debugLog
        self.updateLastDiscoveredGateway(from: newGateways)
        if allowAutoConnect {
            self.maybeAutoConnect()
        }
    }

    private func observeDiscovery() {
        withObservationTracking {
            _ = self.discovery.gateways
            _ = self.discovery.statusText
            _ = self.discovery.debugLog
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.updateFromDiscovery()
                self.observeDiscovery()
            }
        }
    }

    private func maybeAutoConnect() {
        guard self.autoConnectSuppressionGeneration == nil else { return }
        guard !self.didAutoConnect else { return }
        guard let appModel = self.appModel else { return }
        guard appModel.gatewayServerName == nil else { return }

        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: "gateway.autoconnect") else { return }

        let instanceId = defaults.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !instanceId.isEmpty else { return }

        if let active = GatewaySettingsStore.activeGatewayEntry() {
            if self.startActiveGatewayAutoConnect(active, instanceId: instanceId) {
                return
            }
            if active.kind == .discovered,
               let target = self.gateways.first(where: {
                   GatewayStableIdentifier.matches($0.stableID, active.stableID)
               }),
               GatewayTLSStore.loadFingerprint(stableID: target.stableID) != nil
            {
                self.didAutoConnect = true
                Task { [weak self] in
                    guard let self else { return }
                    _ = await self.connectDiscoveredGateway(target)
                }
                return
            }
            if active.kind == .discovered,
               let fallback = self.mostRecentlyConnectedManualGateway(),
               self.startActiveGatewayAutoConnect(fallback, instanceId: instanceId)
            {
                _ = GatewaySettingsStore.setActiveGateway(stableID: fallback.stableID)
                return
            }
            return
        }

        if defaults.bool(forKey: "gateway.manual.enabled") {
            self.startConfiguredManualAutoConnect(defaults: defaults, instanceId: instanceId)
            return
        }

        let preferredStableID = GatewayStableIdentifier.exact(
            defaults.string(forKey: "gateway.preferredStableID"))
        let lastDiscoveredStableID = GatewayStableIdentifier.exact(
            defaults.string(forKey: "gateway.lastDiscoveredStableID"))

        let candidates = [preferredStableID, lastDiscoveredStableID].compactMap(\.self)
        if let targetStableID = candidates.first(where: { id in
            self.gateways.contains(where: { GatewayStableIdentifier.matches($0.stableID, id) })
        }) {
            guard let target = self.gateways.first(where: {
                GatewayStableIdentifier.matches($0.stableID, targetStableID)
            }) else { return }
            // Security: autoconnect only to previously trusted gateways (stored TLS pin).
            guard GatewayTLSStore.loadFingerprint(stableID: target.stableID) != nil else { return }

            self.didAutoConnect = true
            Task { [weak self] in
                guard let self else { return }
                _ = await self.connectDiscoveredGateway(target)
            }
            return
        }

        if self.gateways.count == 1, let gateway = self.gateways.first {
            // Security: autoconnect only to previously trusted gateways (stored TLS pin).
            guard GatewayTLSStore.loadFingerprint(stableID: gateway.stableID) != nil else { return }

            self.didAutoConnect = true
            Task { [weak self] in
                guard let self else { return }
                _ = await self.connectDiscoveredGateway(gateway)
            }
            return
        }
    }

    private func startConfiguredManualAutoConnect(defaults: UserDefaults, instanceId: String) {
        let host = defaults.string(forKey: "gateway.manual.host")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !host.isEmpty else { return }

        let configuredPort = defaults.integer(forKey: "gateway.manual.port")
        let configuredTLS = defaults.bool(forKey: "gateway.manual.tls")
        let useTLS = self.resolveManualUseTLS(host: host, useTLS: configuredTLS)
        guard let port = Self.resolvedManualPort(host: host, port: configuredPort) else { return }

        let stableID = self.manualStableID(host: host, port: port)
        let tlsParams = self.resolveManualTLSParams(stableID: stableID, tlsEnabled: useTLS)
        // Manual TLS auto-connect cannot present first-use trust UI, so it requires an existing pin.
        guard !useTLS || tlsParams?.expectedFingerprint != nil else { return }
        guard let url = self.buildGatewayURL(host: host, port: port, useTLS: tlsParams?.required == true)
        else { return }

        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceId,
            gatewayStableID: stableID)
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: credentials.token,
            bootstrapToken: credentials.bootstrapToken,
            password: credentials.password,
            allowStoredDeviceAuth: !credentials.suppressStoredDeviceAuth)
    }

    private func startActiveGatewayAutoConnect(
        _ active: GatewaySettingsStore.GatewayRegistryEntry,
        instanceId: String) -> Bool
    {
        switch active.kind {
        case .manual:
            guard let host = active.host, let port = active.port else { return false }
            let stableID = active.stableID
            let useTLS = active.useTLS
            let resolvedUseTLS = self.resolveManualUseTLS(host: host, useTLS: useTLS)
            let tlsParams = self.resolveManualTLSParams(stableID: stableID, tlsEnabled: resolvedUseTLS)
            guard !resolvedUseTLS || tlsParams?.expectedFingerprint != nil else { return false }
            guard let url = self.buildGatewayURL(
                host: host,
                port: port,
                useTLS: tlsParams?.required == true)
            else { return false }

            let credentials = GatewaySettingsStore.loadGatewayCredentials(
                instanceId: instanceId,
                gatewayStableID: stableID)
            self.didAutoConnect = true
            self.startAutoConnect(
                url: url,
                gatewayStableID: stableID,
                tls: tlsParams,
                token: credentials.token,
                bootstrapToken: credentials.bootstrapToken,
                password: credentials.password,
                allowStoredDeviceAuth: !credentials.suppressStoredDeviceAuth)
            return true
        case .discovered:
            return false
        }
    }

    private func attemptAutoReconnectIfNeeded() {
        guard let appModel = self.appModel else { return }
        guard appModel.gatewayAutoReconnectEnabled else { return }
        guard self.autoConnectSuppressionGeneration == nil else { return }
        // Avoid starting duplicate connect loops while a prior config is active.
        guard appModel.activeGatewayConnectConfig == nil else { return }
        guard UserDefaults.standard.bool(forKey: "gateway.autoconnect") else { return }
        self.didAutoConnect = false
        self.maybeAutoConnect()
    }

    private func mostRecentlyConnectedManualGateway() -> GatewaySettingsStore.GatewayRegistryEntry? {
        GatewaySettingsStore.loadGatewayRegistry().entries
            .filter { $0.kind == .manual }
            .max { lhs, rhs in
                let lhsConnected = lhs.lastConnectedAtMs ?? Int.min
                let rhsConnected = rhs.lastConnectedAtMs ?? Int.min
                if lhsConnected != rhsConnected { return lhsConnected < rhsConnected }
                return GatewayStableIdentifier.sortsBefore(rhs.stableID, lhs.stableID)
            }
    }

    private func updateLastDiscoveredGateway(from gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        let defaults = UserDefaults.standard
        let preferred = GatewayStableIdentifier.exact(
            defaults.string(forKey: "gateway.preferredStableID"))
        let existingLast = GatewayStableIdentifier.exact(
            defaults.string(forKey: "gateway.lastDiscoveredStableID"))

        // Avoid overriding user intent (preferred/lastDiscovered are also set on manual Connect).
        guard preferred == nil, existingLast == nil else { return }
        guard let first = gateways.first else { return }

        defaults.set(first.stableID, forKey: "gateway.lastDiscoveredStableID")
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(first.stableID)
    }

    @discardableResult
    private func startAutoConnect(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        bootstrapToken: String?,
        password: String?,
        allowStoredDeviceAuth: Bool = true,
        forceReconnect: Bool = false,
        suppressionGeneration: UInt64? = nil,
        expectedGeneration: UInt64? = nil) -> Bool
    {
        guard let appModel,
              let gatewayStableID = GatewayStableIdentifier.exact(gatewayStableID)
        else { return false }
        if let expectedGeneration {
            guard expectedGeneration == appModel.gatewayConnectGeneration else { return false }
        }
        let previousTask = self.pendingAutoConnectTask
        previousTask?.cancel()
        // Advancing again at handoff rejects work that captured the reservation generation while
        // endpoint resolution or trust verification was suspended.
        let generation = appModel.beginGatewayConnectAttempt()
        self.pendingAutoConnectGeneration = generation
        self.pendingConnectionStableID = gatewayStableID
        // An explicit target owns suppression until its queued handoff exits. Otherwise a
        // foreground reconnect can replace it while reset or permission work is suspended.
        self.pendingAutoConnectSuppressionGeneration = suppressionGeneration
        appModel.gatewayStatusText = "Connecting…"
        let task = Task { [weak self, weak appModel] in
            guard let self, let appModel else { return }
            defer {
                if self.pendingAutoConnectGeneration == generation {
                    self.pendingAutoConnectTask = nil
                    self.pendingAutoConnectGeneration = nil
                    self.pendingAutoConnectSuppressionGeneration = nil
                    if GatewayStableIdentifier.matches(self.pendingConnectionStableID, gatewayStableID) {
                        self.pendingConnectionStableID = nil
                    }
                }
                if let suppressionGeneration,
                   self.autoConnectSuppressionGeneration == suppressionGeneration
                {
                    self.clearAutoConnectSuppression(generation: suppressionGeneration)
                }
            }
            await previousTask?.value
            await appModel.waitForGatewaySessionResetIfNeeded()
            guard !Task.isCancelled, generation == appModel.gatewayConnectGeneration else { return }
            if forceReconnect {
                await self.forceReconnectReset(appModel)
                guard !Task.isCancelled, generation == appModel.gatewayConnectGeneration else { return }
            }
            let nodeOptions = await self.makeConnectOptions(
                stableID: gatewayStableID,
                deviceAuthGatewayID: GatewaySettingsStore.authenticationOwnerID(routeStableID: gatewayStableID),
                allowStoredDeviceAuth: allowStoredDeviceAuth)
            // Permission reads above can suspend long enough for a model-owned reconnect reset
            // to start, so close the reset barrier again immediately before the synchronous apply.
            await appModel.waitForGatewaySessionResetIfNeeded()
            guard !Task.isCancelled, generation == appModel.gatewayConnectGeneration else { return }
            let cfg = GatewayConnectConfig(
                url: url,
                stableID: gatewayStableID,
                tls: tls,
                token: token,
                bootstrapToken: bootstrapToken,
                password: password,
                nodeOptions: nodeOptions)
            appModel.applyGatewayConnectConfig(
                cfg,
                forceReconnect: forceReconnect,
                expectedGeneration: generation)
        }
        self.pendingAutoConnectTask = task
        return true
    }

    private func resolveDiscoveredTLSParams(
        gateway: GatewayDiscoveryModel.DiscoveredGateway) -> GatewayTLSParams?
    {
        let stableID = gateway.stableID
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)

        // Never let unauthenticated discovery (TXT) override a stored pin.
        if let stored {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: stored,
                allowTOFU: false,
                storeKey: stableID)
        }

        if gateway.tlsEnabled || gateway.tlsFingerprintSha256 != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: nil,
                allowTOFU: false,
                storeKey: stableID)
        }

        return nil
    }

    private func resolveManualTLSParams(
        stableID: String,
        tlsEnabled: Bool) -> GatewayTLSParams?
    {
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        if tlsEnabled || stored != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: stored,
                allowTOFU: false,
                storeKey: stableID)
        }

        return nil
    }

    private func probeTLSFingerprint(
        host: String,
        port: Int,
        url: URL,
        queueLabel: String) async -> GatewayTLSFingerprintProbeResult?
    {
        self.trustProbeGeneration &+= 1
        let generation = self.trustProbeGeneration
        self.pendingTrustConnect = nil
        self.pendingTrustPrompt = nil
        let reachable = await self.tcpReachabilityProbe(
            host,
            port,
            GatewayTLSFingerprintProbeBudget.tcpConnectTimeoutSeconds,
            queueLabel)
        guard self.trustProbeGeneration == generation else { return nil }
        guard reachable else {
            return .failure(.endpointUnreachable)
        }
        let result = await self.tlsFingerprintProbe(url)
        guard self.trustProbeGeneration == generation else { return nil }
        return result
    }

    private func beginConnectAttempt()
        -> (suppressionLease: AutoConnectSuppressionLease, gatewayGeneration: UInt64?)
    {
        let suppressionLease = self.beginAutoConnectSuppression(restoresAutoReconnect: false)
        // Allocate both tokens before any resolution or trust work. A new explicit target must
        // invalidate queued config construction from the previous target immediately.
        let gatewayGeneration = self.reserveGatewayConnectAttempt()
        return (suppressionLease, gatewayGeneration)
    }

    private func reserveGatewayConnectAttempt() -> UInt64? {
        let previousTask = self.pendingAutoConnectTask
        previousTask?.cancel()
        self.pendingConnectionStableID = nil
        guard let appModel else { return nil }
        let generation = appModel.beginGatewayConnectAttempt()
        let activeConfig = appModel.activeGatewayConnectConfig
        let shouldRestoreActiveConfig = appModel.gatewayAutoReconnectEnabled &&
            !appModel.gatewayPairingPaused &&
            appModel.lastGatewayProblem?.pauseReconnect != true &&
            (previousTask != nil || appModel.hasGatewaySessionResetInFlight)
        self.pendingAutoConnectSuppressionGeneration = nil
        self.pendingAutoConnectGeneration = generation
        // The barrier owns any superseded teardown until it finishes. If the replacement never
        // reaches handoff, restore the still-current route after that teardown completes.
        let barrier = Task { [weak self, weak appModel] in
            guard let self, let appModel else { return }
            defer {
                if self.pendingAutoConnectGeneration == generation {
                    self.pendingAutoConnectTask = nil
                    self.pendingAutoConnectGeneration = nil
                }
            }
            await previousTask?.value
            await appModel.waitForGatewaySessionResetIfNeeded()
            guard !Task.isCancelled,
                  generation == appModel.gatewayConnectGeneration,
                  shouldRestoreActiveConfig,
                  let activeConfig,
                  appModel.gatewayAutoReconnectEnabled,
                  !appModel.gatewayPairingPaused,
                  appModel.lastGatewayProblem?.pauseReconnect != true,
                  appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: activeConfig) == true
            else { return }
            appModel.applyGatewayConnectConfig(activeConfig, expectedGeneration: generation)
        }
        self.pendingAutoConnectTask = barrier
        return generation
    }

    private func finishConnectAttempt(_ lease: AutoConnectSuppressionLease) {
        guard self.connectAttemptGeneration == lease.generation else { return }
        guard self.pendingTrustPrompt == nil else { return }
        guard self.pendingAutoConnectSuppressionGeneration != lease.generation else { return }
        self.pendingConnectionStableID = nil
        if lease.restoresAutoReconnect {
            self.resumeAutoConnect(after: lease)
        } else {
            self.releaseAutoConnectSuppression(after: lease)
        }
    }

    private func tlsProbeFailureMessage(
        _ failure: GatewayTLSFingerprintProbeFailure,
        host: String,
        port: Int) -> String
    {
        switch failure {
        case .endpointUnreachable:
            if host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")).hasSuffix(".ts.net") {
                String(localized: """
                Can't reach gateway at \(host):\(port). \
                Verify Tailscale Serve is enabled and publishes this Gateway.
                """)
            } else {
                String(localized: "Can't reach gateway at \(host):\(port). Check Tailscale or LAN.")
            }
        case .tlsHandshakeTimeout:
            "TLS fingerprint verification timed out for \(host):\(port). "
                + "Secure endpoint was reached, but TLS did not finish in time."
        case .tlsUnavailable:
            "No secure gateway endpoint was detected at \(host):\(port). "
                + "Enable gateway TLS or Tailscale Serve, or use a trusted private LAN address "
                + "with Unencrypted selected."
        case .certificateUnavailable:
            "Could not read the TLS certificate from \(host):\(port)."
        }
    }

    private func resolveServiceEndpoint(_ endpoint: NWEndpoint) async -> (host: String, port: Int)? {
        guard case let .service(name, type, domain, _) = endpoint else { return nil }
        let key = "\(domain)|\(type)|\(name)"
        return await withCheckedContinuation { continuation in
            let resolver = GatewayServiceResolver(name: name, type: type, domain: domain) { [weak self] result in
                Task { @MainActor in
                    self?.pendingServiceResolvers[key] = nil
                    continuation.resume(returning: result)
                }
            }
            self.pendingServiceResolvers[key] = resolver
            resolver.start()
        }
    }
}

private struct GatewayPendingTrustConnect {
    let url: URL
    let stableID: String
    let isManual: Bool
    let authOverride: GatewayConnectionController.ManualAuthOverride?
    let allowStoredDeviceAuth: Bool
    let suppressionLease: GatewayConnectionController.AutoConnectSuppressionLease
    let gatewayGeneration: UInt64?
}

#if DEBUG
extension GatewayConnectionController {
    func _test_setGateways(_ gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        self.gateways = gateways
    }

    func _test_triggerAutoConnect() {
        self.maybeAutoConnect()
    }

    func _test_triggerAutoReconnect() {
        self.attemptAutoReconnectIfNeeded()
    }

    func _test_didAutoConnect() -> Bool {
        self.didAutoConnect
    }

    func _test_isAutoConnectSuppressed() -> Bool {
        self.autoConnectSuppressionGeneration != nil
    }

    func _test_resolveDiscoveredTLSParams(
        gateway: GatewayDiscoveryModel.DiscoveredGateway) -> GatewayTLSParams?
    {
        self.resolveDiscoveredTLSParams(gateway: gateway)
    }

    func _test_resolveManualPort(host: String, port: Int, useTLS _: Bool) -> Int? {
        Self.resolvedManualPort(host: host, port: port)
    }
}
#endif
