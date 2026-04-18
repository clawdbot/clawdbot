import Foundation
import OpenClawIPC
import OpenClawKit

enum RemoteGatewayAuthIssue: Equatable {
    case tokenRequired
    case tokenMismatch
    case gatewayTokenNotConfigured
    case setupCodeExpired
    case passwordRequired
    case pairingRequired

    init?(error: Error) {
        guard let authError = error as? GatewayConnectAuthError else {
            return nil
        }
        switch authError.detail {
        case .authTokenMissing:
            self = .tokenRequired
        case .authTokenMismatch:
            self = .tokenMismatch
        case .authTokenNotConfigured:
            self = .gatewayTokenNotConfigured
        case .authBootstrapTokenInvalid:
            self = .setupCodeExpired
        case .authPasswordMissing, .authPasswordMismatch, .authPasswordNotConfigured:
            self = .passwordRequired
        case .pairingRequired:
            self = .pairingRequired
        default:
            return nil
        }
    }

    var showsTokenField: Bool {
        switch self {
        case .tokenRequired, .tokenMismatch:
            true
        case .gatewayTokenNotConfigured, .setupCodeExpired, .passwordRequired, .pairingRequired:
            false
        }
    }

    var title: String {
        switch self {
        case .tokenRequired:
            "This gateway requires an auth token"
        case .tokenMismatch:
            "That token did not match the gateway"
        case .gatewayTokenNotConfigured:
            "This gateway host needs token setup"
        case .setupCodeExpired:
            "This setup code is no longer valid"
        case .passwordRequired:
            "This gateway is using unsupported auth"
        case .pairingRequired:
            "This device needs pairing approval"
        }
    }

    var body: String {
        switch self {
        case .tokenRequired:
            "Paste the token configured on the gateway host. On the gateway host, run `openclaw config get gateway.auth.token`. If the gateway uses an environment variable instead, use `OPENCLAW_GATEWAY_TOKEN`."
        case .tokenMismatch:
            "Check `gateway.auth.token` or `OPENCLAW_GATEWAY_TOKEN` on the gateway host and try again."
        case .gatewayTokenNotConfigured:
            "This gateway is set to token auth, but no `gateway.auth.token` is configured on the gateway host. If the gateway uses an environment variable instead, set `OPENCLAW_GATEWAY_TOKEN` before starting the gateway."
        case .setupCodeExpired:
            "Scan or paste a fresh setup code from an already-paired OpenClaw client, then try again."
        case .passwordRequired:
            "This onboarding flow does not support password auth yet. Reconfigure the gateway to use token auth, then retry."
        case .pairingRequired:
            "Approve this device from an already-paired OpenClaw client. In your OpenClaw chat, run `/pair approve`, then click **Check connection** again."
        }
    }

    var footnote: String? {
        switch self {
        case .tokenRequired, .gatewayTokenNotConfigured:
            "No token yet? Generate one on the gateway host with `openclaw doctor --generate-gateway-token`, then set it as `gateway.auth.token`."
        case .setupCodeExpired:
            nil
        case .pairingRequired:
            "If you do not have another paired OpenClaw client yet, approve the pending request on the gateway host with `openclaw devices approve`."
        case .tokenMismatch, .passwordRequired:
            nil
        }
    }

    var statusMessage: String {
        switch self {
        case .tokenRequired:
            "This gateway requires an auth token from the gateway host."
        case .tokenMismatch:
            "Gateway token mismatch. Check gateway.auth.token or OPENCLAW_GATEWAY_TOKEN on the gateway host."
        case .gatewayTokenNotConfigured:
            "This gateway has token auth enabled, but no gateway.auth.token is configured on the host."
        case .setupCodeExpired:
            "Setup code expired or already used. Scan a fresh setup code, then try again."
        case .passwordRequired:
            "This gateway uses password auth. Remote onboarding on macOS cannot collect gateway passwords yet."
        case .pairingRequired:
            "Pairing required. In an already-paired OpenClaw client, run /pair approve, then check the connection again."
        }
    }
}

enum RemoteGatewayProbeResult: Equatable {
    case ready(RemoteGatewayProbeSuccess)
    case authIssue(RemoteGatewayAuthIssue)
    case failed(String)
}

struct RemoteGatewayProbeSuccess: Equatable {
    let authSource: GatewayAuthSource?

    var title: String {
        switch self.authSource {
        case .some(.deviceToken):
            "Connected via paired device"
        case .some(.bootstrapToken):
            "Connected with setup code"
        case .some(.sharedToken):
            "Connected with gateway token"
        case .some(.password):
            "Connected with password"
        case .some(GatewayAuthSource.none), nil:
            "Remote gateway ready"
        }
    }

    var detail: String? {
        switch self.authSource {
        case .some(.deviceToken):
            "This Mac used a stored device token. New or unpaired devices may still need the gateway token."
        case .some(.bootstrapToken):
            "This Mac is still using the temporary setup code. Approve pairing to finish provisioning device-scoped auth."
        case .some(.sharedToken), .some(.password), .some(GatewayAuthSource.none), nil:
            nil
        }
    }
}

enum RemoteGatewayProbe {
    @MainActor
    static func run() async -> RemoteGatewayProbeResult {
        AppStateStore.shared.syncGatewayConfigNow()
        let settings = CommandResolver.connectionSettings()
        let transport = AppStateStore.shared.remoteTransport

        if transport == .direct {
            let trimmedUrl = AppStateStore.shared.remoteUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedUrl.isEmpty else {
                return .failed("Set a gateway URL first")
            }
            guard self.isValidWsUrl(trimmedUrl) else {
                return .failed("Gateway URL must use wss:// for remote hosts (ws:// only for localhost)")
            }
        } else {
            let trimmedTarget = settings.target.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedTarget.isEmpty else {
                return .failed("Set an SSH target first")
            }
            if let validationMessage = CommandResolver.sshTargetValidationMessage(trimmedTarget) {
                return .failed(validationMessage)
            }
            guard let sshCommand = self.sshCheckCommand(target: settings.target, identity: settings.identity) else {
                return .failed("SSH target is invalid")
            }

            let sshResult = await ShellExecutor.run(
                command: sshCommand,
                cwd: nil,
                env: nil,
                timeout: 8)
            guard sshResult.ok else {
                return .failed(self.formatSSHFailure(sshResult, target: settings.target))
            }
        }

        do {
            _ = try await GatewayConnection.shared.healthSnapshot(timeoutMs: 10000)
            let authSource = await GatewayConnection.shared.authSource()
            return .ready(RemoteGatewayProbeSuccess(authSource: authSource))
        } catch {
            if let authIssue = RemoteGatewayAuthIssue(error: error) {
                return .authIssue(authIssue)
            }
            return .failed(error.localizedDescription)
        }
    }

    private static func isValidWsUrl(_ raw: String) -> Bool {
        GatewayRemoteConfig.normalizeGatewayUrl(raw) != nil
    }

    private static func sshCheckCommand(target: String, identity: String) -> [String]? {
        guard let parsed = CommandResolver.parseSSHTarget(target) else { return nil }
        let options = [
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
        ] + CommandResolver.strictHostKeyCheckingSSHOptions + CommandResolver.updateHostKeysSSHOptions
        let args = CommandResolver.sshArguments(
            target: parsed,
            identity: identity,
            options: options,
            remoteCommand: ["echo", "ok"])
        return ["/usr/bin/ssh"] + args
    }

    private static func formatSSHFailure(_ response: Response, target: String) -> String {
        let payload = response.payload.flatMap { String(data: $0, encoding: .utf8) }
        let trimmed = payload?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isNewline)
            .joined(separator: " ")
        if let trimmed,
           trimmed.localizedCaseInsensitiveContains("host key verification failed")
        {
            let host = CommandResolver.parseSSHTarget(target)?.host ?? target
            return "SSH check failed: Host key verification failed. Remove the old key with ssh-keygen -R \(host) and try again."
        }
        if let trimmed, !trimmed.isEmpty {
            if let message = response.message, message.hasPrefix("exit ") {
                return "SSH check failed: \(trimmed) (\(message))"
            }
            return "SSH check failed: \(trimmed)"
        }
        if let message = response.message {
            return "SSH check failed (\(message))"
        }
        return "SSH check failed"
    }
}
