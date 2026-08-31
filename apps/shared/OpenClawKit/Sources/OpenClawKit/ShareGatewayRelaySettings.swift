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
    // On iOS an App Group is also a Keychain access group. Reuse the existing
    // group so the host and extension share only this credential bundle.
    private static let relayCredentialService = "ai.openclawfoundation.app.share-gateway-relay"
    private static let relayCredentialAccount = "credentials.v1"
    private static let lastEventKey = "share.gatewayRelay.event.v1"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: self.suiteName) ?? .standard
    }

    private static var isAppExtension: Bool {
        Bundle.main.object(forInfoDictionaryKey: "NSExtension") != nil
    }

    public static func loadConfig() -> ShareGatewayRelayConfig? {
        guard let data = self.defaults.data(forKey: self.relayConfigKey) else { return nil }
        guard let config = try? JSONDecoder().decode(ShareGatewayRelayConfig.self, from: data) else { return nil }
        if config.token != nil || config.password != nil {
            return self.resolveLegacyConfig(
                config,
                isAppExtension: self.isAppExtension,
                migrate: { config in
                    self.commitConfig(
                        config,
                        saveCredentials: self.saveCredentials,
                        saveMetadata: self.saveMetadata)
                },
                discard: {
                    self.defaults.removeObject(forKey: self.relayConfigKey)
                    self.saveLastEvent("Share unavailable after upgrade: open OpenClaw to reconnect securely.")
                })
        }
        // Keep relay identity in the Keychain bundle with its secrets. A partial
        // route update must never bind one gateway's credentials to another.
        let credentials = self.loadCredentials().flatMap { stored in
            self.credentials(stored, match: config) ? stored : nil
        }
        return ShareGatewayRelayConfig(
            gatewayURLString: config.gatewayURLString,
            gatewayStableID: config.gatewayStableID,
            token: credentials?.token,
            password: credentials?.password,
            sessionKey: config.sessionKey,
            deliveryChannel: config.deliveryChannel,
            deliveryTo: config.deliveryTo)
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

    @discardableResult
    public static func saveConfig(_ config: ShareGatewayRelayConfig) -> Bool {
        let saved = self.commitConfig(
            config,
            saveCredentials: self.saveCredentials,
            saveMetadata: self.saveMetadata)
        guard saved else {
            self.defaults.removeObject(forKey: self.relayConfigKey)
            self.saveLastEvent("Share unavailable: reconnect OpenClaw to save gateway access securely.")
            return false
        }
        return true
    }

    public static func clearConfig() {
        self.defaults.removeObject(forKey: self.relayConfigKey)
        _ = self.deleteCredentials()
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

    private static func saveMetadata(_ config: ShareGatewayRelayConfig) {
        let metadata = ShareGatewayRelayConfig(
            gatewayURLString: config.gatewayURLString,
            gatewayStableID: config.gatewayStableID,
            token: nil,
            password: nil,
            sessionKey: config.sessionKey,
            deliveryChannel: config.deliveryChannel,
            deliveryTo: config.deliveryTo)
        guard let data = try? JSONEncoder().encode(metadata) else { return }
        self.defaults.set(data, forKey: self.relayConfigKey)
    }

    static func commitConfig(
        _ config: ShareGatewayRelayConfig,
        saveCredentials: (ShareGatewayRelayConfig) -> Bool,
        saveMetadata: (ShareGatewayRelayConfig) -> Void) -> Bool
    {
        guard saveCredentials(config) else { return false }
        saveMetadata(config)
        return true
    }

    static func resolveLegacyConfig(
        _ config: ShareGatewayRelayConfig,
        isAppExtension: Bool,
        migrate: (ShareGatewayRelayConfig) -> Bool,
        discard: () -> Void) -> ShareGatewayRelayConfig?
    {
        // Only the host may create shared credentials. An extension-first upgrade
        // or failed Keychain write must scrub and reject the legacy auth record.
        guard !isAppExtension, migrate(config) else {
            discard()
            return nil
        }
        return config
    }

    private static func loadCredentials() -> ShareGatewayRelayConfig? {
        guard let json = GenericPasswordKeychainStore.loadString(
            service: self.relayCredentialService,
            account: self.relayCredentialAccount,
            accessGroup: self.suiteName),
            let data = json.data(using: .utf8),
            let credentials = try? JSONDecoder().decode(ShareGatewayRelayConfig.self, from: data)
        else { return nil }
        return credentials
    }

    private static func saveCredentials(_ config: ShareGatewayRelayConfig) -> Bool {
        guard config.token != nil || config.password != nil else {
            return self.deleteCredentials()
        }
        guard let data = try? JSONEncoder().encode(config),
              let json = String(data: data, encoding: .utf8),
              GenericPasswordKeychainStore.saveString(
                  json,
                  service: self.relayCredentialService,
                  account: self.relayCredentialAccount,
                  accessGroup: self.suiteName)
        else {
            return false
        }
        return true
    }

    private static func deleteCredentials() -> Bool {
        GenericPasswordKeychainStore.delete(
            service: self.relayCredentialService,
            account: self.relayCredentialAccount,
            accessGroup: self.suiteName)
    }

    private static func credentials(
        _ credentials: ShareGatewayRelayConfig,
        match metadata: ShareGatewayRelayConfig) -> Bool
    {
        if let stableID = metadata.gatewayStableID, !stableID.isEmpty {
            return credentials.gatewayStableID == stableID
        }
        return credentials.gatewayStableID?.isEmpty != false &&
            credentials.gatewayURLString == metadata.gatewayURLString
    }
}
