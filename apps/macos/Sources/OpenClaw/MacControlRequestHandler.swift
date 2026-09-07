import Foundation
import OpenClawIPC

@MainActor
protocol MacControlOwner {
    func status() async throws -> MacControlStatus
    func setPrimary(_ configuration: PrimaryGatewayControlConfiguration) async throws -> MacControlPrimaryStatus
    func gateways() async throws -> [MacControlGatewayStatus]
    func addGateway(_ request: MacControlRequest) async throws -> MacControlGatewayStatus
    func removeGateway(id: String) async throws
    func reconnectGateway(id: String) async throws -> MacControlGatewayStatus
}

/// Dispatch stays independent of app singletons; the live owner holds all persistence and lifecycle authority.
@MainActor
final class MacControlRequestHandler {
    private let owner: any MacControlOwner
    private var mutationInProgress = false

    init(owner: any MacControlOwner) {
        self.owner = owner
    }

    func handle(_ request: MacControlRequest) async -> Data {
        do {
            try Task.checkCancellation()
            switch request.operation {
            case "status":
                var status = try await self.owner.status()
                status.primary = Self.redacted(status.primary)
                status.gateways = status.gateways.map(Self.redacted)
                return try Self.encode(status)
            case "gateway.list":
                return try await Self.encode(self.owner.gateways().map(Self.redacted))
            case "primary.set", "primary.clear", "gateway.add", "gateway.remove", "gateway.reconnect":
                guard !self.mutationInProgress else {
                    throw MacControlError(
                        code: "busy",
                        message: "Another Gateway change is in progress. Try again when it finishes.")
                }
                self.mutationInProgress = true
                defer { self.mutationInProgress = false }
                return try await self.mutate(request)
            default:
                throw MacControlError(code: "invalid_request", message: "Unknown control operation.")
            }
        } catch {
            return Self.encodeError(error)
        }
    }

    private func mutate(_ request: MacControlRequest) async throws -> Data {
        switch request.operation {
        case "primary.set", "primary.clear":
            let configuration = request.operation == "primary.clear"
                ? PrimaryGatewayControlConfiguration.clear
                : try Self.primaryConfiguration(request)
            try Task.checkCancellation()
            return try await Self.encode(Self.redacted(self.owner.setPrimary(configuration)))
        case "gateway.add":
            guard let name = request.name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let address = request.url, !address.isEmpty,
                  request.browser == true ||
                  request.token?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ||
                  request.password?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            else {
                throw MacControlError(
                    code: "invalid_request",
                    message: "Provide a name and URL; choose --browser or token/password file or stdin authentication.")
            }
            try Task.checkCancellation()
            return try await Self.encode(Self.redacted(self.owner.addGateway(request)))
        case "gateway.remove", "gateway.reconnect":
            guard let query = request.idOrName, !query.isEmpty else {
                throw MacControlError(code: "invalid_request", message: "Provide the saved Gateway ID or name.")
            }
            let profiles = try await self.owner.gateways()
            let profile = try Self.resolve(query, in: profiles)
            try Task.checkCancellation()
            if request.operation == "gateway.remove" {
                try await self.owner.removeGateway(id: profile.id)
                return try Self.encode(RemovalResult(id: profile.id, removed: true))
            }
            return try await Self.encode(Self.redacted(self.owner.reconnectGateway(id: profile.id)))
        default:
            throw MacControlError(code: "invalid_request", message: "Unknown control operation.")
        }
    }

    private struct RemovalResult: Codable, Sendable {
        let id: String
        let removed: Bool
    }

    private static func primaryConfiguration(_ request: MacControlRequest) throws
    -> PrimaryGatewayControlConfiguration {
        if request.mode == "local", request.transport == nil, request.url == nil, request.sshTarget == nil,
           request.token == nil, request.password == nil, request.remotePort == nil, request.localPort == nil,
           request.identityPath == nil, request.hostKeyPolicy == nil, request.tlsFingerprint == nil
        {
            return .local
        }
        guard request.mode == nil else {
            throw MacControlError(code: "invalid_request", message: "Choose local mode or one remote transport.")
        }
        switch request.transport {
        case "direct":
            guard let raw = request.url, let url = URL(string: raw), request.sshTarget == nil,
                  request.remotePort == nil, request.localPort == nil, request.identityPath == nil,
                  request.hostKeyPolicy == nil
            else {
                throw MacControlError(
                    code: "invalid_request",
                    message: "Direct transport requires a WebSocket URL and no SSH options.")
            }
            return .direct(
                url: url,
                token: request.token,
                password: request.password,
                tlsFingerprint: request.tlsFingerprint)
        case "ssh":
            guard let target = request.sshTarget, request.url == nil, request.tlsFingerprint == nil else {
                throw MacControlError(
                    code: "invalid_request",
                    message: "SSH transport requires an SSH target and no direct URL options.")
            }
            let policy = request.hostKeyPolicy.flatMap(CommandResolver.SSHHostKeyPolicy.init(rawValue:))
            guard request.hostKeyPolicy == nil || policy != nil else {
                throw MacControlError(
                    code: "invalid_request",
                    message: "SSH host-key policy must be strict or openssh.")
            }
            return .ssh(
                target: target,
                remotePort: request.remotePort,
                localPort: request.localPort,
                identity: request.identityPath,
                hostKeyPolicy: policy,
                token: request.token,
                password: request.password)
        default:
            throw MacControlError(
                code: "invalid_request",
                message: "Choose local mode, SSH transport, or direct transport.")
        }
    }

    private static func resolve(
        _ query: String,
        in profiles: [MacControlGatewayStatus]) throws -> MacControlGatewayStatus
    {
        if let exact = profiles.first(where: { $0.id == query }) { return exact }
        let matches = profiles.filter { $0.name.caseInsensitiveCompare(query) == .orderedSame }
        if matches.count == 1, let match = matches.first { return match }
        guard !matches.isEmpty else {
            throw MacControlError(code: "not_found", message: "No saved Gateway matches that ID or name.")
        }
        let candidates = matches.map { "\($0.name) (\($0.id))" }.sorted().joined(separator: ", ")
        throw MacControlError(code: "ambiguous_name", message: "Gateway name is ambiguous. Use an ID: \(candidates)")
    }

    static func redactedURL(_ raw: String) -> String {
        guard var parts = URLComponents(string: raw),
              ["ws", "wss"].contains(parts.scheme?.lowercased() ?? ""),
              parts.host?.isEmpty == false
        else { return "" }
        parts.user = nil
        parts.password = nil
        parts.query = nil
        parts.fragment = nil
        return parts.url?.absoluteString ?? ""
    }

    private static func redacted(_ primary: MacControlPrimaryStatus) -> MacControlPrimaryStatus {
        var value = primary
        value.url = self.redactedURL(value.url)
        value.connection = self.redacted(value.connection)
        return value
    }

    private static func redacted(_ gateway: MacControlGatewayStatus) -> MacControlGatewayStatus {
        var value = gateway
        value.url = self.redactedURL(value.url)
        value.connection = self.redacted(value.connection)
        return value
    }

    private static func redacted(_ connection: MacControlConnectionStatus) -> MacControlConnectionStatus {
        var value = connection
        if value.error != nil {
            value.error = "Connection unavailable. Check Gateway settings and reconnect."
        }
        return value
    }

    private static func encode(_ result: some Codable & Sendable) throws -> Data {
        try JSONEncoder().encode(MacControlResponse(result: result))
    }

    private static func encodeError(_ error: Error) -> Data {
        let safe: MacControlError = switch error {
        case let error as MacControlError:
            error
        case is CancellationError:
            MacControlError(code: "cancelled", message: "The control request was cancelled.")
        case let error as PrimaryGatewayControlError:
            MacControlError(code: "primary_failed", message: error.localizedDescription)
        case let error as MacGatewayProfileError:
            MacControlError(code: "gateway_failed", message: error.localizedDescription)
        case let error as GatewayBrowserSessionError:
            MacControlError(code: "sign_in_failed", message: error.localizedDescription)
        default:
            MacControlError(
                code: "operation_failed",
                message: "The app could not complete the Gateway operation. Check Gateway settings and try again.")
        }
        return (try? JSONEncoder().encode(MacControlResponse<String>(error: safe))) ??
            Data(#"{"ok":false,"error":{"code":"operation_failed","message":"Could not encode the response."}}"#.utf8)
    }
}
