import Foundation

enum GatewayDiscoveryPreferences {
    private static let preferredStableIDKey = "gateway.preferredStableID"
    private static let legacyPreferredStableIDKey = "bridge.preferredStableID"
    private static let preferredRouteBindingKey = "gateway.preferredStableIDRouteBinding.v1"
    private static let authenticatedTLSFingerprintKey = "gateway.preferredTLSFingerprint.v1"

    static func preferredStableID() -> String? {
        let defaults = AppDefaults.standard
        let raw = defaults.string(forKey: self.preferredStableIDKey)
            ?? defaults.string(forKey: self.legacyPreferredStableIDKey)
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    static func setPreferredStableID(_ stableID: String?) {
        // A caller without an endpoint binding cannot prove that a prior binding
        // belongs to this id. The bound overload installs a fresh one below.
        AppDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
        AppDefaults.standard.removeObject(forKey: self.authenticatedTLSFingerprintKey)
        let trimmed = stableID?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            AppDefaults.standard.set(trimmed, forKey: self.preferredStableIDKey)
            AppDefaults.standard.removeObject(forKey: self.legacyPreferredStableIDKey)
        } else {
            AppDefaults.standard.removeObject(forKey: self.preferredStableIDKey)
            AppDefaults.standard.removeObject(forKey: self.legacyPreferredStableIDKey)
        }
    }

    static func preferredRouteBinding() -> String? {
        let raw = AppDefaults.standard.string(forKey: self.preferredRouteBindingKey)
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    static func setPreferredStableID(_ stableID: String?, routeBinding: String?) {
        self.setPreferredStableID(stableID)
        guard self.preferredStableID() != nil,
              let routeBinding = self.normalized(routeBinding)
        else {
            AppDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
            return
        }
        AppDefaults.standard.set(routeBinding, forKey: self.preferredRouteBindingKey)
    }

    static func setAuthenticatedPreferredGateway(
        stableID: String,
        tlsFingerprint: String)
    {
        guard let fingerprint = self.normalizedFingerprint(tlsFingerprint) else { return }
        self.setPreferredStableID(stableID)
        AppDefaults.standard.set(fingerprint, forKey: self.authenticatedTLSFingerprintKey)
    }

    static func authenticatedTLSFingerprint() -> String? {
        guard self.preferredStableID() != nil else { return nil }
        return self.normalizedFingerprint(
            AppDefaults.standard.string(forKey: self.authenticatedTLSFingerprintKey))
    }

    static func hasAuthenticatedTLSIdentity(configuredFingerprint: String?) -> Bool
    {
        guard let authenticated = self.authenticatedTLSFingerprint(),
              let configured = self.normalizedFingerprint(configuredFingerprint)
        else { return false }
        return authenticated == configured
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
        remoteTarget: String,
        tlsFingerprint: String? = nil) -> String?
    {
        let routeBinding: String?
        if connectionMode == .remote {
            routeBinding = self.routeBinding(
                connectionMode: connectionMode,
                remoteTransport: remoteTransport,
                remoteURL: remoteURL,
                remoteTarget: remoteTarget)
        } else {
            routeBinding = OnboardingSystemAgentResumeStore.routeIdentity(
                connectionMode: connectionMode,
                preferredGatewayID: nil,
                remoteTransport: remoteTransport,
                remoteURL: remoteURL,
                remoteTarget: remoteTarget)
        }
        if self.hasAuthenticatedTLSIdentity(configuredFingerprint: tlsFingerprint),
           let fingerprint = self.authenticatedTLSFingerprint()
        {
            return self.tlsDeviceAuthGatewayID(fingerprint)
        }
        return routeBinding
    }

    static func tlsDeviceAuthGatewayID(_ fingerprint: String) -> String? {
        self.normalizedFingerprint(fingerprint).map { "tls-sha256:\($0)" }
    }

    @discardableResult
    static func clearPreferredStableIDIfRouteBindingMismatch(_ currentRouteBinding: String?) -> Bool {
        guard self.preferredStableID() != nil else {
            AppDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
            return false
        }
        // Authenticated discovery is bound to the pinned certificate instead of
        // an address, so the same Gateway can move without another bootstrap.
        if self.authenticatedTLSFingerprint() != nil {
            AppDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
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

    private static func normalizedFingerprint(_ value: String?) -> String? {
        var fingerprint = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if fingerprint?.hasPrefix("sha256:") == true {
            fingerprint?.removeFirst("sha256:".count)
        }
        fingerprint = fingerprint?.replacingOccurrences(of: ":", with: "")
        guard let fingerprint,
              fingerprint.count == 64,
              fingerprint.allSatisfy({ $0.isHexDigit })
        else { return nil }
        return fingerprint
    }
}
