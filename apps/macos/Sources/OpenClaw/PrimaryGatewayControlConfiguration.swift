import Foundation

enum PrimaryGatewayControlError: LocalizedError {
    case invalidURL
    case invalidSSHTarget
    case invalidPort
    case unavailable
    case conflictingEdits
    case persistenceFailed

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            "Use a Gateway WebSocket URL without embedded credentials, query, or fragment; public hosts require wss://."
        case .invalidSSHTarget:
            "Use a valid SSH target in the form user@host[:port]."
        case .invalidPort:
            "Gateway ports must be between 1 and 65535."
        case .unavailable:
            "The app is not ready to change its primary Gateway."
        case .conflictingEdits:
            "Resolve the connection settings conflict in the app before changing the primary Gateway."
        case .persistenceFailed:
            "The app could not save the primary Gateway configuration."
        }
    }
}

/// Complete primary selections use the AppState persistence owner, including its conflict and publication fence.
enum PrimaryGatewayControlConfiguration: Sendable {
    case local
    case clear
    case direct(url: URL, token: String?, password: String?, tlsFingerprint: String?)
    case ssh(
        target: String,
        remotePort: Int?,
        localPort: Int?,
        identity: String?,
        hostKeyPolicy: CommandResolver.SSHHostKeyPolicy?,
        token: String?,
        password: String?)

    struct Replacement {
        let root: [String: Any]
        let clearsTargetDefaults: Bool
        let removesGatewayMode: Bool
    }

    var requestedLocalPort: Int? {
        switch self {
        case let .ssh(_, _, localPort, _, _, _, _): localPort
        case .local, .clear, .direct: nil
        }
    }

    func replacingRoot(_ current: [String: Any], effectiveLocalPort: Int) throws -> Replacement {
        var root = current
        var gateway = root["gateway"] as? [String: Any] ?? [:]
        let previousRemote = gateway["remote"] as? [String: Any] ?? [:]
        let clearsTargetDefaults: Bool
        var removesGatewayMode = false
        switch self {
        case .clear:
            removesGatewayMode = gateway.removeValue(forKey: "mode") != nil
            gateway.removeValue(forKey: "remote")
            clearsTargetDefaults = true
        case .local:
            gateway["mode"] = "local"
            clearsTargetDefaults = false
        case let .direct(url, token, password, fingerprint):
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  components.user == nil, components.password == nil,
                  components.query == nil, components.fragment == nil,
                  let normalized = GatewayRemoteConfig.normalizeGatewayUrl(url.absoluteString)
            else { throw PrimaryGatewayControlError.invalidURL }
            clearsTargetDefaults = GatewayRemoteConfig.resolveTransport(root: current) != .direct ||
                GatewayRemoteConfig.resolveGatewayUrl(root: current) != normalized
            gateway["mode"] = "remote"
            var remote = Self.replacingRemoteRoute(previousRemote)
            remote["transport"] = "direct"
            remote["url"] = normalized.absoluteString
            remote["token"] = Self.nonempty(token)
            remote["password"] = Self.nonempty(password)
            remote["tlsFingerprint"] = Self.nonempty(fingerprint)
            gateway["remote"] = remote
        case let .ssh(target, remotePort, localPort, identity, hostKeyPolicy, token, password):
            let target = target.trimmingCharacters(in: .whitespacesAndNewlines)
            guard CommandResolver.sshTargetValidationMessage(target) == nil,
                  let parsedTarget = CommandResolver.parseSSHTarget(target)
            else { throw PrimaryGatewayControlError.invalidSSHTarget }
            for port in [remotePort, localPort].compactMap(\.self) {
                guard (1...65535).contains(port) else { throw PrimaryGatewayControlError.invalidPort }
            }
            clearsTargetDefaults = GatewayRemoteConfig.resolveTransport(root: current) != .ssh ||
                (previousRemote["sshTarget"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) != target
            var remote = Self.replacingRemoteRoute(previousRemote)
            guard (1...65535).contains(effectiveLocalPort) else { throw PrimaryGatewayControlError.invalidPort }
            let previousRemotePort = clearsTargetDefaults ? nil : RemotePortTunnel.resolveRemotePortOverride(
                defaultRemotePort: effectiveLocalPort,
                for: parsedTarget.host,
                root: current) ?? effectiveLocalPort
            let resolvedRemotePort = remotePort ?? previousRemotePort ?? 18789
            let previousPolicy = (previousRemote["sshHostKeyPolicy"] as? String)
                .flatMap(CommandResolver.SSHHostKeyPolicy.init(rawValue:))
            remote["transport"] = "ssh"
            remote["url"] = "ws://127.0.0.1:\(effectiveLocalPort)"
            remote["remotePort"] = resolvedRemotePort
            remote["sshTarget"] = target
            remote["sshIdentity"] = identity.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ??
                (clearsTargetDefaults ? nil : previousRemote["sshIdentity"] as? String)
            remote["sshHostKeyPolicy"] = (hostKeyPolicy ??
                (clearsTargetDefaults ? nil : previousPolicy) ?? .strict).rawValue
            remote["token"] = Self.nonempty(token)
            remote["password"] = Self.nonempty(password)
            gateway["mode"] = "remote"
            if let localPort { gateway["port"] = localPort }
            gateway["remote"] = remote
        }
        if gateway.isEmpty {
            root.removeValue(forKey: "gateway")
        } else {
            root["gateway"] = gateway
        }
        return Replacement(
            root: root,
            clearsTargetDefaults: clearsTargetDefaults,
            removesGatewayMode: removesGatewayMode)
    }

    private static func replacingRemoteRoute(_ previous: [String: Any]) -> [String: Any] {
        var remote = previous
        for key in [
            "transport", "url", "token", "password", "tlsFingerprint", "sshTarget", "sshIdentity",
            "sshHostKeyPolicy", "remotePort",
        ] {
            remote.removeValue(forKey: key)
        }
        return remote
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
