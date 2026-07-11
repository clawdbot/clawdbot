import Foundation

enum GatewayDiscoveryPreferences {
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
        return OnboardingCrestodianResumeStore.routeIdentity(
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
        return OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: connectionMode,
            preferredGatewayID: nil,
            remoteTransport: remoteTransport,
            remoteURL: remoteURL,
            remoteTarget: remoteTarget)
    }

    @discardableResult
    static func clearPreferredStableIDIfRouteBindingMismatch(_ currentRouteBinding: String?) -> Bool {
        guard self.preferredStableID() != nil else {
            UserDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
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
