import CryptoKit
import Foundation
import OSLog

enum GatewayDiscoveryPreferences {
    struct StartupConfig {
        let root: [String: Any]
        let migrationChanged: Bool
        let migrationPersisted: Bool
    }

    enum RouteBindingVerification: Equatable {
        case noPreference
        case match
        case mismatch
        case unverifiable
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway-discovery-preferences")
    private static let preferredStableIDKey = "gateway.preferredStableID"
    private static let legacyPreferredStableIDKey = "bridge.preferredStableID"
    private static let preferredRouteBindingKey = "gateway.preferredStableIDRouteBinding.v1"
    private static let routeBindingVerifierPrefix = "hmac-sha256:gateway-discovery-route-binding:v1:"
    private static let routeBindingVerifierDomain = "openclaw.gateway-discovery.route-binding:v1"
    private static let routeBindingKey: SymmetricKey? = {
        guard AppLaunchRuntimePlan.current.allowsGatewayUIKeychainAccess else { return nil }
        return GatewayActivationBindingKeyStore.loadOrCreate()
    }()

    static func preferredGatewayOwnsRoute(_ routeBinding: String?) -> Bool {
        switch self.preferredRouteBindingVerification(routeBinding) {
        case .match, .unverifiable:
            // An unresolved discovery receipt must continue fencing ambient
            // credentials until a verified mismatch or explicit manual edit.
            true
        case .noPreference, .mismatch:
            false
        }
    }

    static func preferredGatewayVerifiedForRoute(_ routeBinding: String?) -> Bool {
        self.preferredRouteBindingVerification(routeBinding) == .match
    }

    static func preferredGatewayVerifiedForRoute(
        _ routeBinding: String?,
        key: SymmetricKey?) -> Bool
    {
        self.preferredRouteBindingVerification(routeBinding, key: key) == .match
    }

    static func defaultRouteBindingKey() -> SymmetricKey? {
        self.routeBindingKey
    }

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
        let trimmed = stableID?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            AppDefaults.standard.set(trimmed, forKey: self.preferredStableIDKey)
            AppDefaults.standard.removeObject(forKey: self.legacyPreferredStableIDKey)
        } else {
            AppDefaults.standard.removeObject(forKey: self.preferredStableIDKey)
            AppDefaults.standard.removeObject(forKey: self.legacyPreferredStableIDKey)
        }
    }

    static func preferredRouteBindingVerifier() -> String? {
        let raw = AppDefaults.standard.string(forKey: self.preferredRouteBindingKey)
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    static func setPreferredStableID(_ stableID: String?, routeBinding: String?) {
        self.setPreferredStableID(stableID, routeBinding: routeBinding, key: self.routeBindingKey)
    }

    static func setPreferredStableID(
        _ stableID: String?,
        routeBinding: String?,
        key: SymmetricKey?)
    {
        self.setPreferredStableID(stableID)
        guard self.preferredStableID() != nil,
              let verifier = self.routeBindingVerifier(routeBinding, key: key)
        else {
            AppDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
            return
        }
        AppDefaults.standard.set(verifier, forKey: self.preferredRouteBindingKey)
    }

    static func preferredRouteBindingVerification(_ routeBinding: String?) -> RouteBindingVerification {
        self.preferredRouteBindingVerification(routeBinding, key: self.routeBindingKey)
    }

    static func preferredRouteBindingVerification(
        _ routeBinding: String?,
        key: SymmetricKey?) -> RouteBindingVerification
    {
        guard self.preferredStableID() != nil else { return .noPreference }
        guard let storedVerifier = self.preferredRouteBindingVerifier(),
              let routeBinding = self.normalized(routeBinding),
              let key,
              let authenticationCode = self.authenticationCode(from: storedVerifier)
        else { return .unverifiable }

        let payload = self.routeBindingVerifierPayload(routeBinding)
        return HMAC<SHA256>.isValidAuthenticationCode(
            authenticationCode,
            authenticating: payload,
            using: key) ? .match : .mismatch
    }

    static func routeBindingVerifier(_ routeBinding: String?, key: SymmetricKey?) -> String? {
        guard let routeBinding = self.normalized(routeBinding), let key else { return nil }
        let tag = HMAC<SHA256>.authenticationCode(
            for: self.routeBindingVerifierPayload(routeBinding),
            using: key)
        let encoded = tag.map { String(format: "%02x", $0) }.joined()
        return self.routeBindingVerifierPrefix + encoded
    }

    @MainActor
    static func prepareStartupConfig(
        isPreview: Bool,
        saver: ([String: Any]) -> Bool) -> StartupConfig
    {
        self.prepareStartupConfig(isPreview: isPreview, saver: saver, key: self.routeBindingKey)
    }

    @MainActor
    static func prepareStartupConfig(
        isPreview: Bool,
        saver: ([String: Any]) -> Bool,
        key: SymmetricKey?) -> StartupConfig
    {
        let loadedRoot = OpenClawConfigFile.loadDict()
        guard !isPreview else {
            return StartupConfig(
                root: loadedRoot,
                migrationChanged: false,
                migrationPersisted: true)
        }

        let migration = self.migrateUnverifiableDiscoveryRoute(loadedRoot, key: key)
        let persisted = !migration.changed || saver(migration.root)
        guard persisted else {
            self.logger.error("unsafe discovery route migration could not be persisted")
            return StartupConfig(
                root: migration.root,
                migrationChanged: migration.changed,
                migrationPersisted: false)
        }

        if migration.shouldBindCurrentRoute, let stableID = self.preferredStableID() {
            self.setPreferredStableID(
                stableID,
                routeBinding: self.routeBinding(root: migration.root),
                key: key)
        }
        return StartupConfig(
            root: migration.root,
            migrationChanged: migration.changed,
            migrationPersisted: true)
    }

    @MainActor
    static func migrateUnverifiableDiscoveryRoute(
        _ currentRoot: [String: Any],
        key: SymmetricKey?)
        -> (root: [String: Any], changed: Bool, shouldBindCurrentRoute: Bool)
    {
        let currentBinding = self.routeBinding(root: currentRoot)
        switch self.preferredRouteBindingVerification(currentBinding, key: key) {
        case .noPreference:
            return (currentRoot, false, false)
        case .match:
            return (currentRoot, false, false)
        case .mismatch:
            self.setPreferredStableID(nil)
            return (currentRoot, false, false)
        case .unverifiable:
            break
        }

        var root = currentRoot
        var gateway = root["gateway"] as? [String: Any] ?? [:]
        var remote = gateway["remote"] as? [String: Any] ?? [:]
        var changed = false

        if remote.removeValue(forKey: "token") != nil { changed = true }
        if remote.removeValue(forKey: "password") != nil { changed = true }

        if GatewayRemoteConfig.resolveTransport(root: currentRoot) == .direct,
           !self.isVerifiedTailscaleServeRoute(stableID: self.preferredStableID(), root: currentRoot)
        {
            remote["transport"] = AppState.RemoteTransport.ssh.rawValue
            remote["url"] = GatewayDiscoverySelectionSupport.sshTunnelGatewayUrl(
                current: GatewayRemoteConfig.resolveUrlString(root: currentRoot) ?? "")
            changed = true
        }

        gateway["remote"] = remote
        root["gateway"] = gateway
        return (root, changed, true)
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
        switch self.preferredRouteBindingVerification(currentRouteBinding) {
        case .noPreference:
            AppDefaults.standard.removeObject(forKey: self.preferredRouteBindingKey)
            return false
        case .match, .unverifiable:
            return false
        case .mismatch:
            self.setPreferredStableID(nil, routeBinding: nil)
            return true
        }
    }

    private static func routeBinding(root: [String: Any]) -> String? {
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        let remote = (root["gateway"] as? [String: Any])?["remote"] as? [String: Any]
        let remoteTarget = (remote?["sshTarget"] as? String) ?? ""
        return self.routeBinding(
            connectionMode: ConnectionModeResolver.resolve(root: root).mode,
            remoteTransport: resolution.transport,
            remoteURL: resolution.directURL?.absoluteString ??
                GatewayRemoteConfig.resolveUrlString(root: root) ?? "",
            remoteTarget: remoteTarget)
    }

    private static func isVerifiedTailscaleServeRoute(
        stableID: String?,
        root: [String: Any]) -> Bool
    {
        guard let stableID = self.normalized(stableID)?.lowercased(),
              let url = GatewayRemoteConfig.resolveGatewayUrl(root: root),
              url.scheme?.lowercased() == "wss",
              let host = url.host?.lowercased(),
              url.port == nil || url.port == 443
        else { return false }
        return stableID == "tailscale-serve|\(host)"
    }

    private static func routeBindingVerifierPayload(_ routeBinding: String) -> Data {
        let domain = self.routeBindingVerifierDomain
        let framed = "\(domain.utf8.count):\(domain)\0\(routeBinding.utf8.count):\(routeBinding)"
        return Data(framed.utf8)
    }

    private static func authenticationCode(from verifier: String) -> Data? {
        guard verifier.hasPrefix(self.routeBindingVerifierPrefix) else { return nil }
        let encoded = verifier.dropFirst(self.routeBindingVerifierPrefix.count)
        guard encoded.count == SHA256.byteCount * 2 else { return nil }

        var result = Data()
        result.reserveCapacity(SHA256.byteCount)
        var index = encoded.startIndex
        while index < encoded.endIndex {
            let next = encoded.index(index, offsetBy: 2)
            guard let byte = UInt8(encoded[index..<next], radix: 16) else { return nil }
            result.append(byte)
            index = next
        }
        return result
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}
