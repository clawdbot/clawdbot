import ClawdbotProtocol
import Foundation

enum ConfigStore {
    struct Overrides: Sendable {
        var isRemoteMode: (@Sendable () async -> Bool)?
        var loadLocal: (@MainActor @Sendable () -> [String: Any])?
        var saveLocal: (@MainActor @Sendable ([String: Any]) -> Void)?
        var loadRemote: (@MainActor @Sendable () async -> [String: Any])?
        var saveRemote: (@MainActor @Sendable ([String: Any]) async throws -> Void)?
    }

    private actor OverrideStore {
        var overrides = Overrides()

        func setOverride(_ overrides: Overrides) {
            self.overrides = overrides
        }
    }

    private static let overrideStore = OverrideStore()
    @MainActor private static var lastHash: String?

    private static func isRemoteMode() async -> Bool {
        let overrides = await self.overrideStore.overrides
        if let override = overrides.isRemoteMode {
            return await override()
        }
        return await MainActor.run { AppStateStore.shared.connectionMode == .remote }
    }

    @MainActor
    static func load() async -> [String: Any] {
        let overrides = await self.overrideStore.overrides
        if await self.isRemoteMode() {
            if let override = overrides.loadRemote {
                return await override()
            }
            return await self.loadFromGateway() ?? [:]
        }
        if let override = overrides.loadLocal {
            return override()
        }
        if let gateway = await self.loadFromGateway() {
            return gateway
        }
        return ClawdbotConfigFile.loadDict()
    }

    @MainActor
    static func save(_ root: sending [String: Any]) async throws {
        let overrides = await self.overrideStore.overrides
        if await self.isRemoteMode() {
            if let override = overrides.saveRemote {
                try await override(root)
            } else {
                try await self.saveToGateway(root)
            }
        } else {
            if let override = overrides.saveLocal {
                override(root)
            } else {
                do {
                    try await self.saveToGateway(root)
                } catch {
                    ClawdbotConfigFile.saveDict(root)
                }
            }
        }
    }

    @MainActor
    private static func loadFromGateway() async -> [String: Any]? {
        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .configGet,
                params: nil,
                timeoutMs: 8000)
            self.lastHash = snap.hash
            return snap.config?.mapValues { $0.foundationValue } ?? [:]
        } catch {
            return nil
        }
    }

    @MainActor
    private static func saveToGateway(_ root: [String: Any]) async throws {
        if self.lastHash == nil {
            _ = await self.loadFromGateway()
        }
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        guard let raw = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "ConfigStore", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode config.",
            ])
        }
        var params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
        if let baseHash = self.lastHash {
            params["baseHash"] = AnyCodable(baseHash)
        }
        _ = try await GatewayConnection.shared.requestRaw(
            method: .configSet,
            params: params,
            timeoutMs: 10000)
        _ = await self.loadFromGateway()
    }

    #if DEBUG
    static func _testSetOverrides(_ overrides: Overrides) async {
        await self.overrideStore.setOverride(overrides)
    }

    static func _testClearOverrides() async {
        await self.overrideStore.setOverride(.init())
    }
    #endif
}
