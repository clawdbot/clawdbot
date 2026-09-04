import Foundation
import OpenClawProtocol

extension GatewayNodeSession {
    struct ConnectOptionsKey: Equatable {
        private let normalizedInputs: String
        private let deviceAuthGatewayIDBytes: [UInt8]?

        init(_ options: GatewayConnectOptions) {
            func sorted(_ values: [String]) -> String {
                values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .sorted()
                    .joined(separator: ",")
            }
            let role = options.role.trimmingCharacters(in: .whitespacesAndNewlines)
            let scopes = sorted(options.scopes)
            let caps = sorted(options.caps)
            let commands = sorted(options.commands)
            let pathEnv = options.pathEnv?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let clientId = options.clientId.trimmingCharacters(in: .whitespacesAndNewlines)
            let clientMode = options.clientMode.trimmingCharacters(in: .whitespacesAndNewlines)
            let clientDisplayName = (options.clientDisplayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let deviceIdentityProfile = options.deviceIdentityProfile.rawValue
            let includeDeviceIdentity = options.includeDeviceIdentity ? "1" : "0"
            let allowStoredDeviceAuth = options.allowStoredDeviceAuth ? "1" : "0"
            let permissions = options.permissions
                .map { key, value in
                    let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
                    return "\(trimmed)=\(value ? "1" : "0")"
                }
                .sorted()
                .joined(separator: ",")

            self.normalizedInputs = [
                role,
                scopes,
                caps,
                commands,
                pathEnv,
                clientId,
                clientMode,
                clientDisplayName,
                deviceIdentityProfile,
                includeDeviceIdentity,
                allowStoredDeviceAuth,
                permissions,
            ].joined(separator: "|")
            self.deviceAuthGatewayIDBytes = options.deviceAuthGatewayID.map { Array($0.utf8) }
        }
    }

    /// Keeps the flat overload source-compatible while credentials remain one reconnect identity.
    public func connect(
        url: URL,
        token: String? = nil,
        bootstrapToken: String? = nil,
        password: String? = nil,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?,
        extraHeadersProvider: (@Sendable () -> [String: String])? = nil,
        onConnected: @escaping @Sendable () async -> Void,
        onDisconnected: @escaping @Sendable (String) async -> Void,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        onInvokeInput: (@Sendable (NodeInvokeInputEvent) async -> Void)? = nil,
        onInvokeCancel: (@Sendable (String) async -> Void)? = nil,
        onRouteInvalidated: (@Sendable () async -> Void)? = nil) async throws
    {
        try await self.connect(
            url: url,
            credentials: GatewayNodeSessionCredentials(
                token: token,
                bootstrapToken: bootstrapToken,
                password: password),
            connectOptions: connectOptions,
            sessionBox: sessionBox,
            extraHeadersProvider: extraHeadersProvider,
            onConnected: onConnected,
            onDisconnected: onDisconnected,
            onInvoke: onInvoke,
            onInvokeInput: onInvokeInput,
            onInvokeCancel: onInvokeCancel,
            onRouteInvalidated: onRouteInvalidated)
    }
}
