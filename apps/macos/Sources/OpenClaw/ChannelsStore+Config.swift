import Foundation
import OpenClawProtocol

extension ChannelsStore {
    func loadConfigSchema(source expected: Source? = nil) async {
        guard let source = await self.resolveSource(expected) else { return }
        let sourceKey = source.cacheKey
        self.resetConfigSchemaCacheIfSourceChanged(sourceKey)
        if self.configSchema != nil {
            return
        }
        if self.configSchemaTask == nil {
            self.configSchemaTask = Task { await self.performConfigSchemaLoad(source: source) }
        }
        await self.configSchemaTask?.value
    }

    private func performConfigSchemaLoad(source: Source) async {
        defer { if self.owns(source) { self.configSchemaTask = nil } }
        do {
            let res: ConfigSchemaResponse = try await self.gateway.requestDecoded(
                method: .configSchema,
                params: nil,
                timeoutMs: 8000,
                ifCurrentRoute: source.lease.route)
            guard self.owns(source) else { return }
            self.applyConfigSchemaResponse(res, sourceKey: source.cacheKey)
        } catch {
            guard self.owns(source) else { return }
            self.configStatus = error.localizedDescription
        }
    }

    @discardableResult
    func loadConfigSchemaLookup(
        path: String,
        force: Bool = false,
        source expected: Source? = nil) async -> ConfigSchemaLookupNode?
    {
        guard let source = await self.resolveSource(expected) else { return nil }
        let sourceKey = source.cacheKey
        self.resetConfigSchemaCacheIfSourceChanged(sourceKey)
        let normalizedPath = Self.normalizeConfigLookupPath(path)
        if !force, let cached = self.configLookupNode(path: normalizedPath) {
            return cached
        }
        if self.configLookupTasks[normalizedPath] == nil {
            self.configLookupErrors.removeValue(forKey: normalizedPath)
            // SwiftUI restarts the caller when acquisition publishes its Source.
            // The Source owns the read so replacement callers can await the same result.
            self.configLookupTasks[normalizedPath] = Task {
                await self.performConfigSchemaLookup(path: normalizedPath, source: source)
            }
        }
        await self.configLookupTasks[normalizedPath]?.value
        guard self.owns(source), !Task.isCancelled else { return nil }
        return self.configLookupNode(path: normalizedPath)
    }

    private func performConfigSchemaLookup(path: String, source: Source) async {
        defer { if self.owns(source) { self.configLookupTasks.removeValue(forKey: path) } }
        do {
            let res: ConfigSchemaLookupResult = try await self.gateway.requestDecoded(
                method: .configSchemaLookup,
                params: ["path": AnyCodable(path)],
                timeoutMs: 5000,
                ifCurrentRoute: source.lease.route)
            guard self.owns(source) else { return }
            guard let node = self.makeConfigLookupNode(res) else {
                self.configLookupErrors[path] = "Config schema lookup returned an unsupported payload."
                return
            }
            self.applyConfigLookupNode(node, sourceKey: source.cacheKey)
        } catch {
            guard self.owns(source) else { return }
            self.configLookupErrors[path] = error.localizedDescription
        }
    }

    func loadConfig(force: Bool = true, refresh: Bool = false, source expected: Source? = nil) async {
        guard let source = await self.resolveSource(expected) else { return }
        let sourceKey = source.cacheKey
        self.resetConfigCacheIfSourceChanged(sourceKey)
        if !force, !refresh, self.configLoaded {
            return
        }
        if self.configTask == nil {
            // Source publication cancels SwiftUI callers. Keep the read and any
            // explicit reloads owned by the Source, like path-scoped lookups.
            self.configTask = Task {
                await self.performConfigLoad(force: force, source: source)
            }
        } else if force {
            self.configReloadPending = .force
        } else if refresh, self.configReloadPending == .none {
            self.configReloadPending = .refresh
        }
        await self.configTask?.value
    }

    private func performConfigLoad(force: Bool, source: Source) async {
        defer { if self.owns(source) { self.configTask = nil } }
        var requestForce = force
        while self.owns(source) {
            do {
                let snap: ConfigSnapshot = try await self.gateway.requestDecoded(
                    method: .configGet,
                    params: nil,
                    timeoutMs: 10000,
                    ifCurrentRoute: source.lease.route)
                guard self.owns(source) else { return }
                self.applyConfigSnapshot(snap, sourceKey: source.cacheKey, force: requestForce)
            } catch {
                guard self.owns(source) else { return }
                self.configStatus = error.localizedDescription
            }

            guard self.configReloadPending != .none else { break }
            requestForce = self.configReloadPending == .force
            self.configReloadPending = .none
        }
    }

    func applyConfigSnapshot(_ snap: ConfigSnapshot, sourceKey: String, force: Bool) {
        guard self.configSourceKey == sourceKey else { return }
        // Preserving edits also preserves the revision token they were based on.
        guard force || !self.configDirty else { return }

        self.configStatus = snap.valid == false
            ? "Config invalid; fix it in ~/.openclaw/openclaw.json."
            : nil
        if let source = self.source, self.owns(source) {
            self.configDocument = ConfigStore.document(snapshot: snap, gateway: self.gateway, lease: source.lease)
        }
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

    func configLookupNode(path: String) -> ConfigSchemaLookupNode? {
        let normalizedPath = Self.normalizeConfigLookupPath(path)
        if normalizedPath == "." {
            return self.configLookupRoot
        }
        return self.configLookupCache[normalizedPath]
    }

    func makeConfigLookupNode(_ res: ConfigSchemaLookupResult) -> ConfigSchemaLookupNode? {
        let schemaValue = res.schema.foundationValue
        guard let schema = ConfigSchemaNode(raw: schemaValue) else { return nil }
        let hint = res.hint.map { ConfigUiHint(raw: $0.mapValues(\.foundationValue)) }
        let children = res.children.compactMap(ConfigSchemaLookupChild.init(raw:))
        return ConfigSchemaLookupNode(
            path: Self.normalizeConfigLookupPath(res.path),
            schema: schema,
            hint: hint,
            hintPath: res.hintpath,
            children: children)
    }

    func applyConfigLookupNode(_ node: ConfigSchemaLookupNode, sourceKey: String) {
        guard self.configSchemaSourceKey == sourceKey else { return }
        if node.path == "." {
            self.configLookupRoot = node
        } else {
            self.configLookupCache[node.path] = node
        }
        if let hint = node.hint {
            self.configUiHints[node.path] = hint
        }
        for child in node.children {
            if let hint = child.hint {
                self.configUiHints[child.path] = hint
            }
        }
    }

    private func applyUIConfig(_ snap: ConfigSnapshot) {
        let ui = snap.config?["ui"]?.dictionaryValue
        AppStateStore.shared.seamColorHex = Self.uiAccent(
            userAccent: ui?["prefs"]?.dictionaryValue?["accent"]?.stringValue,
            seamColor: ui?["seamColor"]?.stringValue)
    }

    /// User accent wins over the operator seam color, mirroring the gateway's
    /// talk.config precedence (ui.prefs.accent -> ui.seamColor -> theme default).
    static func uiAccent(userAccent: String?, seamColor: String?) -> String? {
        [userAccent, seamColor]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
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
        guard let source = self.source, self.owns(source), var document = self.configDocument else {
            self.configStatus = "Gateway changed since this config was loaded. Reload it before saving."
            return
        }
        self.isSavingConfig = true
        defer { if self.owns(source) { self.isSavingConfig = false } }

        do {
            document.root = self.configDraft
            try await ConfigStore.save(document)
            guard self.owns(source) else { return }
            await self.loadConfig(source: source)
        } catch {
            guard self.owns(source) else { return }
            self.configStatus = error.localizedDescription
        }
    }

    func reloadConfigDraft(lookupPath: String? = nil) async {
        guard let source = await self.resolveSource() else { return }
        await self.loadConfig(force: true, source: source)
        if let lookupPath {
            _ = await self.loadConfigSchemaLookup(path: lookupPath, source: source)
        }
    }

    func resetConfigSchemaCacheIfSourceChanged(_ sourceKey: String) {
        guard let cachedSourceKey = self.configSchemaSourceKey else {
            self.configSchemaSourceKey = sourceKey
            return
        }
        guard cachedSourceKey != sourceKey else { return }
        self.configSchemaTask?.cancel()
        self.configSchemaTask = nil
        self.configSchema = nil
        self.configLookupRoot = nil
        self.configLookupCache.removeAll(keepingCapacity: true)
        self.configLookupErrors.removeAll(keepingCapacity: true)
        for task in self.configLookupTasks.values {
            task.cancel()
        }
        self.configLookupTasks.removeAll(keepingCapacity: true)
        self.configUiHints = [:]
        self.configSchemaSourceKey = sourceKey
    }

    func resetConfigCacheIfSourceChanged(_ sourceKey: String) {
        guard let cachedSourceKey = self.configSourceKey else {
            self.configSourceKey = sourceKey
            return
        }
        guard cachedSourceKey != sourceKey else { return }
        self.configTask?.cancel()
        self.configTask = nil
        self.configReloadPending = .none
        self.configDocument = nil
        self.configRoot = [:]
        self.configDraft = [:]
        self.configDirty = false
        self.configLoaded = false
        self.configSourceKey = sourceKey
    }

    static func normalizeConfigLookupPath(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "." : trimmed
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
