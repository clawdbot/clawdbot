import OpenClawKit

extension GatewaySettingsStore {
    struct GatewayRegistry: Codable, Equatable {
        var version: Int = 1
        var activeStableID: String?
        /// Gateways whose operator sessions should stay live. `activeStableID`
        /// is only the UI focus and does not imply exclusive connectivity.
        var connectedStableIDs: [String] = []
        var entries: [GatewayRegistryEntry] = []

        static let empty = GatewayRegistry()

        private enum CodingKeys: String, CodingKey {
            case version
            case activeStableID
            case connectedStableIDs
            case entries
        }

        init(
            version: Int = 1,
            activeStableID: String? = nil,
            connectedStableIDs: [String] = [],
            entries: [GatewayRegistryEntry] = [])
        {
            self.version = version
            self.activeStableID = activeStableID
            self.connectedStableIDs = connectedStableIDs
            self.entries = entries
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            let version = try values.decode(Int.self, forKey: .version)
            let activeStableID = try values.decodeIfPresent(String.self, forKey: .activeStableID)
            self.version = version
            self.activeStableID = activeStableID
            self.connectedStableIDs = try values.decodeIfPresent(
                [String].self,
                forKey: .connectedStableIDs) ?? (version == 1 ? activeStableID.map { [$0] } ?? [] : [])
            self.entries = try values.decodeIfPresent([GatewayRegistryEntry].self, forKey: .entries) ?? []
        }
    }

    @discardableResult
    static func setActiveGateway(stableID: String) -> Bool {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return false }
        var registry = self.loadGatewayRegistry()
        guard let storedID = registry.entries.first(where: {
            GatewayStableIdentifier.matches($0.stableID, stableID)
        })?.stableID else { return false }
        registry.activeStableID = storedID
        if !registry.connectedStableIDs.contains(where: {
            GatewayStableIdentifier.matches($0, storedID)
        }) {
            registry.connectedStableIDs.append(storedID)
        }
        return self.saveGatewayRegistry(registry)
    }

    @discardableResult
    static func setGatewayConnectionEnabled(stableID: String, enabled: Bool) -> Bool {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return false }
        var registry = self.loadGatewayRegistry()
        guard let storedID = registry.entries.first(where: {
            GatewayStableIdentifier.matches($0.stableID, stableID)
        })?.stableID else { return false }
        registry.connectedStableIDs.removeAll {
            GatewayStableIdentifier.matches($0, storedID)
        }
        if enabled {
            registry.connectedStableIDs.append(storedID)
        }
        return self.saveGatewayRegistry(registry)
    }

    static func connectedGatewayEntries() -> [GatewayRegistryEntry] {
        let registry = self.loadGatewayRegistry()
        return registry.connectedStableIDs.compactMap { connectedID in
            registry.entries.first {
                GatewayStableIdentifier.matches($0.stableID, connectedID)
            }
        }
    }
}
