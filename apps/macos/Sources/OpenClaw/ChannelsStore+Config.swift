import Foundation
import OpenClawProtocol

extension ChannelsStore {
    func loadConfigSchema(force: Bool = false) async {
        let sourceKey = self.currentConfigCacheSourceKey()
        self.resetConfigSchemaCacheIfSourceChanged(sourceKey)
        if !force, self.configSchema != nil {
            return
        }
        guard !self.queueConfigSchemaReloadIfLoading(sourceKey: sourceKey, force: force) else { return }
        self.configSchemaLoading = true
        self.configSchemaLoadingSourceKey = sourceKey
        defer {
            self.configSchemaLoading = false
            self.configSchemaLoadingSourceKey = nil
        }

        var requestSourceKey = sourceKey

        while true {
            self.configSchemaLoadingSourceKey = requestSourceKey
            do {
                let res: ConfigSchemaResponse = try await GatewayConnection.shared.requestDecoded(
                    method: .configSchema,
                    params: nil,
                    timeoutMs: 8000)
                self.applyConfigSchemaResponse(res, sourceKey: requestSourceKey)
            } catch {
                self.configStatus = error.localizedDescription
            }

            guard self.configSchemaReloadPending else { break }
            self.configSchemaReloadPending = false
            requestSourceKey = self.currentConfigCacheSourceKey()
            self.resetConfigSchemaCacheIfSourceChanged(requestSourceKey)
        }
    }

    func loadConfig(force: Bool = true) async {
        let sourceKey = self.currentConfigCacheSourceKey()
        self.resetConfigCacheIfSourceChanged(sourceKey)
        if !force, self.configLoaded {
            return
        }
        guard !self.queueConfigReloadIfLoading(sourceKey: sourceKey, force: force) else { return }
        self.configLoading = true
        self.configLoadingSourceKey = sourceKey
        defer {
            self.configLoading = false
            self.configLoadingSourceKey = nil
        }

        var requestForce = force
        var requestSourceKey = sourceKey

        while true {
            self.configLoadingSourceKey = requestSourceKey
            do {
                let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                    method: .configGet,
                    params: nil,
                    timeoutMs: 10000)
                self.applyConfigSnapshot(snap, sourceKey: requestSourceKey, force: requestForce)
            } catch {
                self.configStatus = error.localizedDescription
            }

            guard self.configForceReloadPending else { break }
            self.configForceReloadPending = false
            requestForce = true
            requestSourceKey = self.currentConfigCacheSourceKey()
            self.resetConfigCacheIfSourceChanged(requestSourceKey)
        }
    }

    func applyConfigSnapshot(_ snap: ConfigSnapshot, sourceKey: String, force: Bool) {
        guard self.configSourceKey == sourceKey else { return }
        guard force || !self.configDirty else { return }

        self.configStatus = snap.valid == false
            ? "Config invalid; fix it in ~/.openclaw/openclaw.json."
            : nil
        self.configRoot = snap.config?.mapValues { $0.foundationValue } ?? [:]
        self.configDraft = cloneConfigValue(self.configRoot) as? [String: Any] ?? self.configRoot
        self.configDirty = false
        self.configLoaded = true
        self.configSourceKey = sourceKey

        self.applyUIConfig(snap)
    }

    func applyConfigSchemaResponse(_ res: ConfigSchemaResponse, sourceKey: String) {
        guard self.configSchemaSourceKey == sourceKey else { return }

        let schemaValue = res.schema.foundationValue
        self.configSchema = ConfigSchemaNode(raw: schemaValue)
        let hintValues = res.uihints.mapValues { $0.foundationValue }
        self.configUiHints = decodeUiHints(hintValues)
        self.configSchemaSourceKey = sourceKey
    }

    private func applyUIConfig(_ snap: ConfigSnapshot) {
        let ui = snap.config?["ui"]?.dictionaryValue
        let rawSeam = ui?["seamColor"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        AppStateStore.shared.seamColorHex = rawSeam.isEmpty ? nil : rawSeam
    }

    func channelConfigSchema(for channelId: String) -> ConfigSchemaNode? {
        guard let root = self.configSchema else { return nil }
        return root.node(at: [.key("channels"), .key(channelId)])
    }

    func configValue(at path: ConfigPath) -> Any? {
        if let value = valueAtPath(self.configDraft, path: path) {
            return value
        }
        guard path.count >= 2 else { return nil }
        if case .key("channels") = path[0], case .key = path[1] {
            let fallbackPath = Array(path.dropFirst())
            return valueAtPath(self.configDraft, path: fallbackPath)
        }
        return nil
    }

    func updateConfigValue(path: ConfigPath, value: Any?) {
        var root: Any = self.configDraft
        setValue(&root, path: path, value: value)
        self.configDraft = root as? [String: Any] ?? self.configDraft
        self.configDirty = true
    }

    func saveConfigDraft() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }

        do {
            try await ConfigStore.save(self.configDraft)
            await self.loadConfig()
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    func reloadConfigDraft() async {
        await self.loadConfig(force: true)
    }

    func resetConfigSchemaCacheIfSourceChanged(_ sourceKey: String) {
        guard let cachedSourceKey = self.configSchemaSourceKey else {
            self.configSchemaSourceKey = sourceKey
            return
        }
        guard cachedSourceKey != sourceKey else { return }
        self.configSchema = nil
        self.configUiHints = [:]
        self.configSchemaSourceKey = sourceKey
    }

    func resetConfigCacheIfSourceChanged(_ sourceKey: String) {
        guard let cachedSourceKey = self.configSourceKey else {
            self.configSourceKey = sourceKey
            return
        }
        guard cachedSourceKey != sourceKey else { return }
        self.configRoot = [:]
        self.configDraft = [:]
        self.configDirty = false
        self.configLoaded = false
        self.configSourceKey = sourceKey
    }

    func queueConfigReloadIfLoading(sourceKey: String, force: Bool) -> Bool {
        guard self.configLoading else { return false }
        if force || self.configLoadingSourceKey != sourceKey {
            self.configForceReloadPending = true
        }
        return true
    }

    func queueConfigSchemaReloadIfLoading(sourceKey: String, force: Bool) -> Bool {
        guard self.configSchemaLoading else { return false }
        if force || self.configSchemaLoadingSourceKey != sourceKey {
            self.configSchemaReloadPending = true
        }
        return true
    }

    private func currentConfigCacheSourceKey() -> String {
        let root = OpenClawConfigFile.loadDict()
        let settings = CommandResolver.connectionSettings(configRoot: root)
        let env = ProcessInfo.processInfo.environment
        return [
            "mode:\(settings.mode.rawValue)",
            "target:\(settings.target)",
            "identity:\(settings.identity)",
            "project:\(settings.projectRoot)",
            "cli:\(settings.cliPath)",
            "port:\(GatewayEnvironment.gatewayPort())",
            "gateway:\(Self.configFingerprint(root["gateway"]))",
            "token:\(Self.configFingerprint(env["OPENCLAW_GATEWAY_TOKEN"]))",
            "password:\(Self.configFingerprint(env["OPENCLAW_GATEWAY_PASSWORD"]))",
        ].joined(separator: "|")
    }

    private static func configFingerprint(_ value: Any?) -> String {
        guard let value else { return "nil" }
        if JSONSerialization.isValidJSONObject(value),
           let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        {
            return "\(data.count):\(data.hashValue)"
        }
        let text = String(describing: value)
        return "\(text.count):\(text.hashValue)"
    }
}

private func valueAtPath(_ root: Any, path: ConfigPath) -> Any? {
    var current: Any? = root
    for segment in path {
        switch segment {
        case let .key(key):
            guard let dict = current as? [String: Any] else { return nil }
            current = dict[key]
        case let .index(index):
            guard let array = current as? [Any], array.indices.contains(index) else { return nil }
            current = array[index]
        }
    }
    return current
}

private func setValue(_ root: inout Any, path: ConfigPath, value: Any?) {
    guard let segment = path.first else { return }
    switch segment {
    case let .key(key):
        var dict = root as? [String: Any] ?? [:]
        if path.count == 1 {
            if let value {
                dict[key] = value
            } else {
                dict.removeValue(forKey: key)
            }
            root = dict
            return
        }
        var child = dict[key] ?? [:]
        setValue(&child, path: Array(path.dropFirst()), value: value)
        dict[key] = child
        root = dict
    case let .index(index):
        var array = root as? [Any] ?? []
        if index >= array.count {
            array.append(contentsOf: repeatElement(NSNull() as Any, count: index - array.count + 1))
        }
        if path.count == 1 {
            if let value {
                array[index] = value
            } else if array.indices.contains(index) {
                array.remove(at: index)
            }
            root = array
            return
        }
        var child = array[index]
        setValue(&child, path: Array(path.dropFirst()), value: value)
        array[index] = child
        root = array
    }
}

private func cloneConfigValue(_ value: Any) -> Any {
    guard JSONSerialization.isValidJSONObject(value) else { return value }
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        return try JSONSerialization.jsonObject(with: data, options: [])
    } catch {
        return value
    }
}
