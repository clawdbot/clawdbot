import Foundation

enum GatewaySettingsStore {
    private static let gatewayService = "bot.molt.gateway"
    private static let legacyGatewayService = "com.clawdbot.gateway"
    private static let legacyBridgeService = "com.clawdbot.bridge"
    private static let nodeService = "bot.molt.node"
    private static let legacyNodeService = "com.clawdbot.node"

    private static let instanceIdDefaultsKey = "node.instanceId"
    private static let preferredGatewayStableIDDefaultsKey = "gateway.preferredStableID"
    private static let lastDiscoveredGatewayStableIDDefaultsKey = "gateway.lastDiscoveredStableID"
    private static let manualEnabledDefaultsKey = "gateway.manual.enabled"
    private static let manualHostDefaultsKey = "gateway.manual.host"
    private static let manualPortDefaultsKey = "gateway.manual.port"
    private static let manualTlsDefaultsKey = "gateway.manual.tls"
    private static let discoveryDebugLogsDefaultsKey = "gateway.discovery.debugLogs"

    private static let legacyPreferredBridgeStableIDDefaultsKey = "bridge.preferredStableID"
    private static let legacyLastDiscoveredBridgeStableIDDefaultsKey = "bridge.lastDiscoveredStableID"
    private static let legacyManualEnabledDefaultsKey = "bridge.manual.enabled"
    private static let legacyManualHostDefaultsKey = "bridge.manual.host"
    private static let legacyManualPortDefaultsKey = "bridge.manual.port"
    private static let legacyDiscoveryDebugLogsDefaultsKey = "bridge.discovery.debugLogs"

    private static let instanceIdAccount = "instanceId"
    private static let preferredGatewayStableIDAccount = "preferredStableID"
    private static let lastDiscoveredGatewayStableIDAccount = "lastDiscoveredStableID"

    static func bootstrapPersistence() {
        self.ensureStableInstanceID()
        self.ensurePreferredGatewayStableID()
        self.ensureLastDiscoveredGatewayStableID()
        self.migrateLegacyDefaults()
    }

    static func loadStableInstanceID() -> String? {
        if let value = KeychainStore.loadString(service: self.nodeService, account: self.instanceIdAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        if let legacy = KeychainStore.loadString(service: self.legacyNodeService, account: self.instanceIdAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !legacy.isEmpty
        {
            _ = KeychainStore.saveString(legacy, service: self.nodeService, account: self.instanceIdAccount)
            return legacy
        }

        return nil
    }

    static func saveStableInstanceID(_ instanceId: String) {
        _ = KeychainStore.saveString(instanceId, service: self.nodeService, account: self.instanceIdAccount)
    }

    static func loadPreferredGatewayStableID() -> String? {
        if let value = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        if let legacy = KeychainStore.loadString(
            service: self.legacyGatewayService,
            account: self.preferredGatewayStableIDAccount
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
            !legacy.isEmpty
        {
            _ = KeychainStore.saveString(
                legacy,
                service: self.gatewayService,
                account: self.preferredGatewayStableIDAccount)
            return legacy
        }

        return nil
    }

    static func savePreferredGatewayStableID(_ stableID: String) {
        _ = KeychainStore.saveString(
            stableID,
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount)
    }

    static func loadLastDiscoveredGatewayStableID() -> String? {
        if let value = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        if let legacy = KeychainStore.loadString(
            service: self.legacyGatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
            !legacy.isEmpty
        {
            _ = KeychainStore.saveString(
                legacy,
                service: self.gatewayService,
                account: self.lastDiscoveredGatewayStableIDAccount)
            return legacy
        }

        return nil
    }

    static func saveLastDiscoveredGatewayStableID(_ stableID: String) {
        _ = KeychainStore.saveString(
            stableID,
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount)
    }

    static func loadGatewayToken(instanceId: String) -> String? {
        let account = self.gatewayTokenAccount(instanceId: instanceId)
        let token = KeychainStore.loadString(service: self.gatewayService, account: account)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if token?.isEmpty == false { return token }

        let legacyAccount = self.legacyBridgeTokenAccount(instanceId: instanceId)
        let legacy = KeychainStore.loadString(service: self.legacyBridgeService, account: legacyAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let legacy, !legacy.isEmpty {
            _ = KeychainStore.saveString(legacy, service: self.gatewayService, account: account)
            return legacy
        }
        return nil
    }

    static func saveGatewayToken(_ token: String, instanceId: String) {
        _ = KeychainStore.saveString(
            token,
            service: self.gatewayService,
            account: self.gatewayTokenAccount(instanceId: instanceId))
    }

    static func loadGatewayPassword(instanceId: String) -> String? {
        KeychainStore.loadString(
            service: self.gatewayService,
            account: self.gatewayPasswordAccount(instanceId: instanceId))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func saveGatewayPassword(_ password: String, instanceId: String) {
        _ = KeychainStore.saveString(
            password,
            service: self.gatewayService,
            account: self.gatewayPasswordAccount(instanceId: instanceId))
    }

    private static func gatewayTokenAccount(instanceId: String) -> String {
        "gateway-token.\(instanceId)"
    }

    private static func legacyBridgeTokenAccount(instanceId: String) -> String {
        "bridge-token.\(instanceId)"
    }

    private static func gatewayPasswordAccount(instanceId: String) -> String {
        "gateway-password.\(instanceId)"
    }

    private static func ensureStableInstanceID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.instanceIdDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadStableInstanceID() == nil {
                self.saveStableInstanceID(existing)
            }
            return
        }

        if let stored = self.loadStableInstanceID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.instanceIdDefaultsKey)
            return
        }

        let fresh = UUID().uuidString
        self.saveStableInstanceID(fresh)
        defaults.set(fresh, forKey: self.instanceIdDefaultsKey)
    }

    private static func ensurePreferredGatewayStableID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.preferredGatewayStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadPreferredGatewayStableID() == nil {
                self.savePreferredGatewayStableID(existing)
            }
            return
        }

        if let stored = self.loadPreferredGatewayStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.preferredGatewayStableIDDefaultsKey)
        }
    }

    private static func ensureLastDiscoveredGatewayStableID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadLastDiscoveredGatewayStableID() == nil {
                self.saveLastDiscoveredGatewayStableID(existing)
            }
            return
        }

        if let stored = self.loadLastDiscoveredGatewayStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)
        }
    }

    private static func migrateLegacyDefaults() {
        let defaults = UserDefaults.standard

        if defaults.string(forKey: self.preferredGatewayStableIDDefaultsKey)?.isEmpty != false,
           let legacy = defaults.string(forKey: self.legacyPreferredBridgeStableIDDefaultsKey),
           !legacy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            defaults.set(legacy, forKey: self.preferredGatewayStableIDDefaultsKey)
            self.savePreferredGatewayStableID(legacy)
        }

        if defaults.string(forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)?.isEmpty != false,
           let legacy = defaults.string(forKey: self.legacyLastDiscoveredBridgeStableIDDefaultsKey),
           !legacy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            defaults.set(legacy, forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)
            self.saveLastDiscoveredGatewayStableID(legacy)
        }

        if defaults.object(forKey: self.manualEnabledDefaultsKey) == nil,
           defaults.object(forKey: self.legacyManualEnabledDefaultsKey) != nil
        {
            defaults.set(
                defaults.bool(forKey: self.legacyManualEnabledDefaultsKey),
                forKey: self.manualEnabledDefaultsKey)
        }

        if defaults.string(forKey: self.manualHostDefaultsKey)?.isEmpty != false,
           let legacy = defaults.string(forKey: self.legacyManualHostDefaultsKey),
           !legacy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            defaults.set(legacy, forKey: self.manualHostDefaultsKey)
        }

        if defaults.integer(forKey: self.manualPortDefaultsKey) == 0,
           defaults.integer(forKey: self.legacyManualPortDefaultsKey) > 0
        {
            defaults.set(
                defaults.integer(forKey: self.legacyManualPortDefaultsKey),
                forKey: self.manualPortDefaultsKey)
        }

        if defaults.object(forKey: self.discoveryDebugLogsDefaultsKey) == nil,
           defaults.object(forKey: self.legacyDiscoveryDebugLogsDefaultsKey) != nil
        {
            defaults.set(
                defaults.bool(forKey: self.legacyDiscoveryDebugLogsDefaultsKey),
                forKey: self.discoveryDebugLogsDefaultsKey)
        }
    }
}
