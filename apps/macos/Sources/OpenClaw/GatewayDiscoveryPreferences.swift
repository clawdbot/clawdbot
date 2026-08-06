import Foundation
import OSLog

enum GatewayDiscoveryPreferences {
    struct StartupConfig {
        let root: [String: Any]
        let migrationChanged: Bool
        let migrationPersisted: Bool
        let remoteToken: GatewayRemoteConfig.TokenValue
        let remoteTransport: AppState.RemoteTransport
        let remoteURL: String?
        let connectionMode: AppState.ConnectionMode
        let remoteIdentityConfigured: Bool
        let remoteIdentity: String
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway-discovery-preferences")
    private static let preferredStableIDKey = "gateway.preferredStableID"
    private static let legacyPreferredStableIDKey = "bridge.preferredStableID"
    private static let preferredRouteBindingKey = "gateway.preferredStableIDRouteBinding.v1"

    static func preferredStableID() -> String? {
        let defaults = UserDefaults.standard
        let raw = defaults.string(forKey: self.preferredStableIDKey)
            ?? defaults.string(forKey: self.legacyPreferredStableIDKey)
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    static func setPreferredStableID(_ stableID: String?) {
        // A caller without an endpoint binding cannot prove that a prior binding
        // belongs to this id. The bound overload installs a fresh one below.
        UserDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
        let trimmed = stableID?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            UserDefaults.standard.set(trimmed, forKey: self.preferredStableIDKey)
            UserDefaults.standard.removeObject(forKey: self.legacyPreferredStableIDKey)
        } else {
            UserDefaults.standard.removeObject(forKey: self.preferredStableIDKey)
            UserDefaults.standard.removeObject(forKey: self.legacyPreferredStableIDKey)
        }
    }

    static func preferredRouteBinding() -> String? {
        let raw = UserDefaults.standard.string(forKey: self.preferredRouteBindingKey)
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    @MainActor
    static func prepareStartupConfig(
        isPreview: Bool,
        saver: ([String: Any]) -> Bool) -> StartupConfig
    {
        let loadedRoot = OpenClawConfigFile.loadDict()
        let migration = isPreview
            ? (root: loadedRoot, changed: false)
            : self.migrateUnsafeDiscoveryRoute(loadedRoot)
        let persisted = !migration.changed || saver(migration.root)
        if !persisted {
            self.logger.error("legacy discovery route migration could not be persisted")
        }
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: migration.root)
        let remote = (migration.root["gateway"] as? [String: Any])?["remote"] as? [String: Any]
        let remoteIdentity = (remote?["sshIdentity"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return StartupConfig(
            root: migration.root,
            migrationChanged: migration.changed,
            migrationPersisted: persisted,
            remoteToken: GatewayRemoteConfig.resolveTokenValue(root: migration.root),
            remoteTransport: resolution.transport,
            remoteURL: resolution.directURL?.absoluteString ??
                GatewayRemoteConfig.resolveUrlString(root: migration.root),
            connectionMode: ConnectionModeResolver.resolve(root: migration.root).mode,
            remoteIdentityConfigured: remote?.keys.contains("sshIdentity") == true,
            remoteIdentity: remoteIdentity)
    }

    @MainActor
    static func migrateUnsafeDiscoveryRoute(_ currentRoot: [String: Any])
        -> (root: [String: Any], changed: Bool)
    {
        let connectionMode = ConnectionModeResolver.resolve(root: currentRoot).mode
        guard GatewayRemoteConfig.resolveTransport(root: currentRoot) == .direct
        else {
            return (currentRoot, false)
        }
        if connectionMode == .remote {
            guard let preferredStableID = self.preferredStableID() else {
                // Active Direct without a discovery receipt is operator-owned.
                return (currentRoot, false)
            }
            if self.isVerifiedTailscaleServeRoute(
                stableID: preferredStableID,
                root: currentRoot)
            {
                return (currentRoot, false)
            }
            if let storedBinding = self.preferredRouteBinding() {
                let currentBinding = self.routeBinding(
                    connectionMode: .remote,
                    remoteTransport: .direct,
                    remoteURL: GatewayRemoteConfig.resolveUrlString(root: currentRoot) ?? "",
                    remoteTarget: "")
                // A mismatched binding proves the route was edited after discovery selected it.
                guard storedBinding == currentBinding else { return (currentRoot, false) }
            }
        }

        // Shipped mode-exit flows cleared the discovery receipt, so an inactive Direct route has
        // no reliable ownership provenance. Keeping it would let a mode-only return to Remote
        // reactivate an attacker-selected endpoint without another trusted Direct decision.

        var root = currentRoot
        var gateway = root["gateway"] as? [String: Any] ?? [:]
        var remote = gateway["remote"] as? [String: Any] ?? [:]
        remote["transport"] = AppState.RemoteTransport.ssh.rawValue
        remote["url"] = GatewayDiscoverySelectionSupport.sshTunnelGatewayUrl(
            current: GatewayRemoteConfig.resolveUrlString(root: currentRoot) ?? "")
        gateway["remote"] = remote
        root["gateway"] = gateway
        return (root, true)
    }

    private static func isVerifiedTailscaleServeRoute(
        stableID: String,
        root: [String: Any]) -> Bool
    {
        guard let url = GatewayRemoteConfig.resolveGatewayUrl(root: root),
              url.scheme?.lowercased() == "wss",
              let host = url.host?.lowercased(),
              url.port == nil || url.port == 443
        else {
            return false
        }
        return stableID.lowercased() == "tailscale-serve|\(host)"
    }

    @MainActor
    static func currentRouteIsDiscoveryOwned(state: AppState) -> Bool {
        guard self.preferredStableID() != nil,
              let storedBinding = self.preferredRouteBinding()
        else {
            return false
        }
        // Match the bound route itself, not only the persisted discovery id. A manual route edit
        // transfers authority immediately, before asynchronous preference cleanup catches up.
        return storedBinding == self.routeBinding(
            connectionMode: state.connectionMode,
            remoteTransport: state.remoteTransport,
            remoteURL: state.remoteUrl,
            remoteTarget: state.remoteTarget)
    }

    @MainActor
    static func retirePreferredRouteBeforeLeavingRemote(state: AppState) {
        // Clear automatic Direct authority while its route binding is still observable.
        // Clearing the receipt first would make a later discovery choice look manual.
        if self.currentRouteIsDiscoveryOwned(state: state),
           state.remoteTransport == .direct
        {
            state.remoteTransport = .ssh
            state.remoteUrl = GatewayDiscoverySelectionSupport.sshTunnelGatewayUrl(
                current: state.remoteUrl)
        }
        self.setPreferredStableID(nil)
    }

    static func setPreferredStableID(_ stableID: String?, routeBinding: String?) {
        self.setPreferredStableID(stableID)
        guard self.preferredStableID() != nil,
              let routeBinding = self.normalized(routeBinding)
        else {
            UserDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
            return
        }
        UserDefaults.standard.set(routeBinding, forKey: self.preferredRouteBindingKey)
    }

    /// Discovery ids name one concrete Gateway. Persist the non-secret fallback
    /// route beside the id so an app-off config edit cannot reuse its receipts.
    static func routeBinding(
        connectionMode: AppState.ConnectionMode,
        remoteTransport: AppState.RemoteTransport,
        remoteURL: String,
        remoteTarget: String) -> String?
    {
        guard connectionMode == .remote else { return nil }
        let defaultRemotePort = GatewayEnvironment.gatewayPort()
        let sshRemotePort: Int = if remoteTransport == .ssh {
            RemotePortTunnel.resolveRemotePortOverride(
                defaultRemotePort: defaultRemotePort,
                for: CommandResolver.parseSSHTarget(remoteTarget)?.host ?? "") ?? defaultRemotePort
        } else {
            defaultRemotePort
        }
        return OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: remoteTransport,
            remoteURL: remoteURL,
            remoteTarget: remoteTarget,
            sshRemotePort: sshRemotePort)
    }

    /// Stable, non-secret owner for credentials issued by one selected route.
    /// This intentionally ignores discovery ids: manual direct/SSH selections
    /// must still isolate device tokens before discovery has identified them.
    static func deviceAuthGatewayID(
        connectionMode: AppState.ConnectionMode,
        remoteTransport: AppState.RemoteTransport,
        remoteURL: String,
        remoteTarget: String) -> String?
    {
        if connectionMode == .remote {
            return self.routeBinding(
                connectionMode: connectionMode,
                remoteTransport: remoteTransport,
                remoteURL: remoteURL,
                remoteTarget: remoteTarget)
        }
        return OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: connectionMode,
            preferredGatewayID: nil,
            remoteTransport: remoteTransport,
            remoteURL: remoteURL,
            remoteTarget: remoteTarget)
    }

    @discardableResult
    static func clearPreferredStableIDIfRouteBindingMismatch(_ currentRouteBinding: String?) -> Bool {
        guard let preferredStableID = self.preferredStableID() else {
            UserDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
            return false
        }
        if self.preferredRouteBinding() == nil,
           let current = self.normalized(currentRouteBinding)
        {
            // Releases predating route bindings persisted only the discovery id. Adopt the
            // current route once so its automatic transport cannot look like a manual choice.
            self.setPreferredStableID(preferredStableID, routeBinding: current)
            return false
        }
        guard let stored = self.preferredRouteBinding(),
              let current = self.normalized(currentRouteBinding),
              stored == current
        else {
            self.setPreferredStableID(nil, routeBinding: nil)
            return true
        }
        return false
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}
