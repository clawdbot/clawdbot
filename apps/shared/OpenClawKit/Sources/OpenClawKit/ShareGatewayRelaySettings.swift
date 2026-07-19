import Foundation

public struct ShareGatewayRelayConfig: Codable, Sendable, Equatable {
    public let gatewayURLString: String
    public let gatewayStableID: String?
    public let token: String?
    public let password: String?
    public let sessionKey: String
    public let deliveryChannel: String?
    public let deliveryTo: String?

    public init(
        gatewayURLString: String,
        gatewayStableID: String? = nil,
        token: String?,
        password: String?,
        sessionKey: String,
        deliveryChannel: String? = nil,
        deliveryTo: String? = nil)
    {
        self.gatewayURLString = gatewayURLString
        self.gatewayStableID = gatewayStableID
        self.token = token
        self.password = password
        self.sessionKey = sessionKey
        self.deliveryChannel = deliveryChannel
        self.deliveryTo = deliveryTo
    }
}

public enum ShareGatewayRelaySettings {
    private static var suiteName: String {
        OpenClawAppGroup.identifier
    }

    private static let relayConfigKey = "share.gatewayRelay.config.v1"
    private static let lastEventKey = "share.gatewayRelay.event.v1"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: self.suiteName) ?? .standard
    }

    public static func loadConfig() -> ShareGatewayRelayConfig? {
        guard let data = self.defaults.data(forKey: self.relayConfigKey) else { return nil }
        return try? JSONDecoder().decode(ShareGatewayRelayConfig.self, from: data)
    }

    /// An endpoint is not a gateway identity. If the extension launches before the
    /// host can prove a stable ID, discard unscoped device auth and use explicit auth only.
    public static func loadConfigDiscardingUnscopedDeviceAuth() -> ShareGatewayRelayConfig? {
        guard let config = self.loadConfig() else { return nil }
        if config.gatewayStableID?.isEmpty == false {
            return config
        }
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .shareExtension) else {
            return config
        }
        DeviceAuthStore.discardUnscopedTokens(
            deviceId: identity.deviceId,
            profile: .shareExtension)
        return config
    }

    public static func saveConfig(_ config: ShareGatewayRelayConfig) {
        guard let data = try? JSONEncoder().encode(config) else { return }
        self.defaults.set(data, forKey: self.relayConfigKey)
    }

    public static func clearConfig() {
        self.defaults.removeObject(forKey: self.relayConfigKey)
    }

    public static func saveLastEvent(_ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let payload = "[\(timestamp)] \(message)"
        self.defaults.set(payload, forKey: self.lastEventKey)
    }

    public static func loadLastEvent() -> String? {
        let value = self.defaults.string(forKey: self.lastEventKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }
}
