import CryptoKit
import Foundation
import OpenClawProtocol

enum OpenClawConfigFile {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "config")
    private static let configAuditFileName = "config-audit.jsonl"
    private static let configHealthFileName = "config-health.json"
    private static let fileLock = NSRecursiveLock()

    private static func withFileLock<T>(_ body: () throws -> T) rethrows -> T {
        self.fileLock.lock()
        defer { self.fileLock.unlock() }
        return try body()
    }

    #if DEBUG
    static func withTestingFileLock<T>(_ body: () throws -> T) rethrows -> T {
        try self.withFileLock(body)
    }
    #endif

    static func url() -> URL {
        OpenClawPaths.configURL
    }

    static func stateDirURL() -> URL {
        OpenClawPaths.stateDirURL
    }

    static func defaultWorkspaceURL() -> URL {
        OpenClawPaths.workspaceURL
    }

    static func loadDict() -> [String: Any] {
        self.withFileLock {
            let url = self.url()
            guard FileManager().fileExists(atPath: url.path) else { return [:] }
            do {
                let data = try Data(contentsOf: url)
                guard let root = self.parseConfigData(data) else {
                    self.observeConfigRead(data: data, root: nil, configURL: url, valid: false)
                    self.logger.warning("config JSON root invalid")
                    return [:]
                }
                self.observeConfigRead(data: data, root: root, configURL: url, valid: true)
                return root
            } catch {
                self.logger.warning("config read failed: \(error.localizedDescription)")
                return [:]
            }
        }
    }

    static func saveDict(_ dict: [String: Any]) {
        self.withFileLock {
            // Nix mode disables config writes in production, but tests rely on saving temp configs.
            if ProcessInfo.processInfo.isNixMode, !ProcessInfo.processInfo.isRunningTests { return }
            let url = self.url()
            let previousData = try? Data(contentsOf: url)
            let previousRoot = previousData.flatMap { self.parseConfigData($0) }
            let previousBytes = previousData?.count
            let previousAttributes = try? FileManager().attributesOfItem(atPath: url.path)
            let hadMetaBefore = self.hasMeta(previousRoot)
            let gatewayModeBefore = self.gatewayMode(previousRoot)

            var output = dict
            self.stampMeta(&output)

            do {
                let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
                try FileManager().createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                try data.write(to: url, options: [.atomic])
                let nextBytes = data.count
                let nextAttributes = try? FileManager().attributesOfItem(atPath: url.path)
                let gatewayModeAfter = self.gatewayMode(output)
                let suspicious = self.configWriteSuspiciousReasons(
                    existsBefore: previousData != nil,
                    previousBytes: previousBytes,
                    nextBytes: nextBytes,
                    hadMetaBefore: hadMetaBefore,
                    gatewayModeBefore: gatewayModeBefore,
                    gatewayModeAfter: gatewayModeAfter)
                if !suspicious.isEmpty {
                    self.logger.warning("config write anomaly (\(suspicious.joined(separator: ", "))) at \(url.path)")
                }
                self.appendConfigWriteAudit([
                    "result": "success",
                    "configPath": url.path,
                    "existsBefore": previousData != nil,
                    "previousBytes": previousBytes ?? NSNull(),
                    "nextBytes": nextBytes,
                    "previousDev": self.fileSystemNumber(previousAttributes?[.systemNumber]) ?? NSNull(),
                    "nextDev": self.fileSystemNumber(nextAttributes?[.systemNumber]) ?? NSNull(),
                    "previousIno": self.fileSystemNumber(previousAttributes?[.systemFileNumber]) ?? NSNull(),
                    "nextIno": self.fileSystemNumber(nextAttributes?[.systemFileNumber]) ?? NSNull(),
                    "previousMode": self.posixMode(previousAttributes?[.posixPermissions]) ?? NSNull(),
                    "nextMode": self.posixMode(nextAttributes?[.posixPermissions]) ?? NSNull(),
                    "previousNlink": self.fileAttributeInt(previousAttributes?[.referenceCount]) ?? NSNull(),
                    "nextNlink": self.fileAttributeInt(nextAttributes?[.referenceCount]) ?? NSNull(),
                    "previousUid": self.fileAttributeInt(previousAttributes?[.ownerAccountID]) ?? NSNull(),
                    "nextUid": self.fileAttributeInt(nextAttributes?[.ownerAccountID]) ?? NSNull(),
                    "previousGid": self.fileAttributeInt(previousAttributes?[.groupOwnerAccountID]) ?? NSNull(),
                    "nextGid": self.fileAttributeInt(nextAttributes?[.groupOwnerAccountID]) ?? NSNull(),
                    "hasMetaBefore": hadMetaBefore,
                    "hasMetaAfter": self.hasMeta(output),
                    "gatewayModeBefore": gatewayModeBefore ?? NSNull(),
                    "gatewayModeAfter": gatewayModeAfter ?? NSNull(),
                    "suspicious": suspicious,
                ])
                self.observeConfigRead(data: data, root: output, configURL: url, valid: true)
            } catch {
                self.logger.error("config save failed: \(error.localizedDescription)")
                self.appendConfigWriteAudit([
                    "result": "failed",
                    "configPath": url.path,
                    "existsBefore": previousData != nil,
                    "previousBytes": previousBytes ?? NSNull(),
                    "nextBytes": NSNull(),
                    "hasMetaBefore": hadMetaBefore,
                    "hasMetaAfter": self.hasMeta(output),
                    "gatewayModeBefore": gatewayModeBefore ?? NSNull(),
                    "gatewayModeAfter": self.gatewayMode(output) ?? NSNull(),
                    "suspicious": [],
                    "error": error.localizedDescription,
                ])
            }
        }
    }

    static func loadGatewayDict() -> [String: Any] {
        let root = self.loadDict()
        return root["gateway"] as? [String: Any] ?? [:]
    }

    static func updateGatewayDict(_ mutate: (inout [String: Any]) -> Void) {
        var root = self.loadDict()
        var gateway = root["gateway"] as? [String: Any] ?? [:]
        mutate(&gateway)
        if gateway.isEmpty {
            root.removeValue(forKey: "gateway")
        } else {
            root["gateway"] = gateway
        }
        self.saveDict(root)
    }

    static func browserControlEnabled(defaultValue: Bool = true) -> Bool {
        let root = self.loadDict()
        let browser = root["browser"] as? [String: Any]
        return browser?["enabled"] as? Bool ?? defaultValue
    }

    static func setBrowserControlEnabled(_ enabled: Bool) {
        var root = self.loadDict()
        var browser = root["browser"] as? [String: Any] ?? [:]
        browser["enabled"] = enabled
        root["browser"] = browser
        self.saveDict(root)
        self.logger.debug("browser control updated enabled=\(enabled)")
    }

    static func agentWorkspace() -> String? {
        AgentWorkspaceConfig.workspace(from: self.loadDict())
    }

    static func setAgentWorkspace(_ workspace: String?) {
        var root = self.loadDict()
        AgentWorkspaceConfig.setWorkspace(in: &root, workspace: workspace)
        self.saveDict(root)
        let hasWorkspace = !(workspace?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        self.logger.debug("agents.defaults.workspace updated set=\(hasWorkspace)")
    }

    static func gatewayPassword() -> String? {
        let root = self.loadDict()
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any]
        else {
            return nil
        }
        return remote["password"] as? String
    }

    static func gatewayPort() -> Int? {
        let root = self.loadDict()
        guard let gateway = root["gateway"] as? [String: Any] else { return nil }
        if let port = gateway["port"] as? Int, port > 0 { return port }
        if let number = gateway["port"] as? NSNumber, number.intValue > 0 {
            return number.intValue
        }
        if let raw = gateway["port"] as? String,
           let parsed = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           parsed > 0
        {
            return parsed
        }
        return nil
    }

    static func remoteGatewayPort() -> Int? {
        guard let url = self.remoteGatewayUrl(),
              let port = url.port,
              port > 0
        else { return nil }
        return port
    }

    static func remoteGatewayPort(matchingHost sshHost: String) -> Int? {
        guard let normalizedSshHost = canonicalHostForComparison(sshHost),
              let url = self.remoteGatewayUrl(),
              let port = url.port,
              port > 0,
              let urlHost = url.host,
              let normalizedUrlHost = canonicalHostForComparison(urlHost)
        else {
            return nil
        }

        guard normalizedSshHost == normalizedUrlHost else { return nil }
        return port
    }

    static func setRemoteGatewayUrl(host: String, port: Int?) {
        guard let port, port > 0 else { return }
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty else { return }
        self.updateGatewayDict { gateway in
            var remote = gateway["remote"] as? [String: Any] ?? [:]
            let existingUrl = (remote["url"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let scheme = URL(string: existingUrl)?.scheme ?? "ws"
            remote["url"] = "\(scheme)://\(trimmedHost):\(port)"
            gateway["remote"] = remote
        }
    }

    static func setRemoteGatewayUrlString(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.updateGatewayDict { gateway in
            var remote = gateway["remote"] as? [String: Any] ?? [:]
            remote["url"] = trimmed
            gateway["remote"] = remote
        }
    }

    static func clearRemoteGatewayUrl() {
        self.updateGatewayDict { gateway in
            guard var remote = gateway["remote"] as? [String: Any] else { return }
            guard remote["url"] != nil else { return }
            remote.removeValue(forKey: "url")
            if remote.isEmpty {
                gateway.removeValue(forKey: "remote")
            } else {
                gateway["remote"] = remote
            }
        }
    }

    private static func remoteGatewayUrl() -> URL? {
        let root = self.loadDict()
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any],
              let raw = remote["url"] as? String
        else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
        return url
    }

    static func canonicalHostForComparison(_ raw: String?) -> String? {
        guard var host = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !host.isEmpty
        else {
            return nil
        }
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        while host.hasSuffix(".") {
            host.removeLast()
        }
        return host.isEmpty ? nil : host
    }

    private static func parseConfigData(_ data: Data) -> [String: Any]? {
        if let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return root
        }
        let decoder = JSONDecoder()
        if #available(macOS 12.0, *) {
            decoder.allowsJSON5 = true
        }
        if let decoded = try? decoder.decode([String: AnyCodable].self, from: data) {
            self.logger.notice("config parsed with JSON5 decoder")
            return decoded.mapValues { $0.foundationValue }
        }
        return nil
    }

    private static func stampMeta(_ root: inout [String: Any]) {
        var meta = root["meta"] as? [String: Any] ?? [:]
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "macos-app"
        meta["lastTouchedVersion"] = version
        meta["lastTouchedAt"] = ISO8601DateFormatter().string(from: Date())
        root["meta"] = meta
    }

    private static func hasMeta(_ root: [String: Any]?) -> Bool {
        guard let root else { return false }
        return root["meta"] is [String: Any]
    }

    private static func hasMeta(_ root: [String: Any]) -> Bool {
        root["meta"] is [String: Any]
    }

    private static func gatewayMode(_ root: [String: Any]?) -> String? {
        guard let root else { return nil }
        return self.gatewayMode(root)
    }

    private static func gatewayMode(_ root: [String: Any]) -> String? {
        guard let gateway = root["gateway"] as? [String: Any],
              let mode = gateway["mode"] as? String
        else { return nil }
        let trimmed = mode.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func configWriteSuspiciousReasons(
        existsBefore: Bool,
        previousBytes: Int?,
        nextBytes: Int,
        hadMetaBefore: Bool,
        gatewayModeBefore: String?,
        gatewayModeAfter: String?) -> [String]
    {
        var reasons: [String] = []
        if !existsBefore {
            return reasons
        }
        if let previousBytes, previousBytes >= 512, nextBytes < max(1, previousBytes / 2) {
            reasons.append("size-drop:\(previousBytes)->\(nextBytes)")
        }
        if !hadMetaBefore {
            reasons.append("missing-meta-before-write")
        }
        if gatewayModeBefore != nil, gatewayModeAfter == nil {
            reasons.append("gateway-mode-removed")
        }
        return reasons
    }

    private static func configAuditLogURL() -> URL {
        self.stateDirURL()
            .appendingPathComponent("logs", isDirectory: true)
            .appendingPathComponent(self.configAuditFileName, isDirectory: false)
    }

    private static func configHealthStateURL() -> URL {
        self.stateDirURL()
            .appendingPathComponent("logs", isDirectory: true)
            .appendingPathComponent(self.configHealthFileName, isDirectory: false)
    }

    private static func readConfigHealthState() -> [String: Any] {
        let url = self.configHealthStateURL()
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return [:]
        }
        return root
    }

    private static func writeConfigHealthState(_ root: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(root),
              let data = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        else {
            return
        }
        let url = self.configHealthStateURL()
        do {
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
        } catch {
            // best-effort
        }
    }

    private static func configHealthEntry(state: [String: Any], configPath: String) -> [String: Any] {
        let entries = state["entries"] as? [String: Any]
        return entries?[configPath] as? [String: Any] ?? [:]
    }

    private static func setConfigHealthEntry(
        state: [String: Any],
        configPath: String,
        entry: [String: Any]) -> [String: Any]
    {
        var next = state
        var entries = next["entries"] as? [String: Any] ?? [:]
        entries[configPath] = entry
        next["entries"] = entries
        return next
    }

    private static func isUpdateChannelOnlyRoot(_ root: [String: Any]) -> Bool {
        let keys = Array(root.keys)
        guard keys.count == 1, keys.first == "update" else { return false }
        guard let update = root["update"] as? [String: Any] else { return false }
        let updateKeys = Array(update.keys)
        return updateKeys.count == 1 && update["channel"] is String
    }

    private static func fileTimestampMs(_ value: Any?) -> Double? {
        guard let date = value as? Date else { return nil }
        return date.timeIntervalSince1970 * 1000
    }

    private static func fileAttributeInt(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let number = value as? Int { return number }
        return nil
    }

    private static func fileSystemNumber(_ value: Any?) -> String? {
        if let number = value as? NSNumber { return number.stringValue }
        if let number = value as? Int { return String(number) }
        return nil
    }

    private static func posixMode(_ value: Any?) -> Int? {
        guard let mode = self.fileAttributeInt(value) else { return nil }
        return mode & 0o777
    }

    private static func configFingerprint(
        data: Data,
        root: [String: Any]?,
        configURL: URL,
        observedAt: String) -> [String: Any]
    {
        let attributes = try? FileManager().attributesOfItem(atPath: configURL.path)
        return [
            "hash": SHA256.hash(data: data).compactMap { String(format: "%02x", $0) }.joined(),
            "bytes": data.count,
            "mtimeMs": self.fileTimestampMs(attributes?[.modificationDate]) ?? NSNull(),
            "ctimeMs": self.fileTimestampMs(attributes?[.creationDate]) ?? NSNull(),
            "dev": self.fileSystemNumber(attributes?[.systemNumber]) ?? NSNull(),
            "ino": self.fileSystemNumber(attributes?[.systemFileNumber]) ?? NSNull(),
            "mode": self.posixMode(attributes?[.posixPermissions]) ?? NSNull(),
            "nlink": self.fileAttributeInt(attributes?[.referenceCount]) ?? NSNull(),
            "uid": self.fileAttributeInt(attributes?[.ownerAccountID]) ?? NSNull(),
            "gid": self.fileAttributeInt(attributes?[.groupOwnerAccountID]) ?? NSNull(),
            "hasMeta": self.hasMeta(root),
            "gatewayMode": self.gatewayMode(root) ?? NSNull(),
            "observedAt": observedAt,
        ]
    }

    private static func sameFingerprint(_ left: [String: Any]?, _ right: [String: Any]) -> Bool {
        guard let left else { return false }
        return (left["hash"] as? String) == (right["hash"] as? String) &&
            (left["bytes"] as? Int) == (right["bytes"] as? Int) &&
            (left["mtimeMs"] as? Double) == (right["mtimeMs"] as? Double) &&
            (left["ctimeMs"] as? Double) == (right["ctimeMs"] as? Double) &&
            (left["dev"] as? String) == (right["dev"] as? String) &&
            (left["ino"] as? String) == (right["ino"] as? String) &&
            (left["mode"] as? Int) == (right["mode"] as? Int) &&
            (left["nlink"] as? Int) == (right["nlink"] as? Int) &&
            (left["uid"] as? Int) == (right["uid"] as? Int) &&
            (left["gid"] as? Int) == (right["gid"] as? Int) &&
            (left["hasMeta"] as? Bool) == (right["hasMeta"] as? Bool) &&
            (left["gatewayMode"] as? String) == (right["gatewayMode"] as? String)
    }

    private static func observeSuspiciousReasons(
        root: [String: Any]?,
        bytes: Int,
        lastKnownGood: [String: Any]?) -> [String]
    {
        guard let lastKnownGood else { return [] }
        var reasons: [String] = []
        if let previousBytes = lastKnownGood["bytes"] as? Int,
           previousBytes >= 512,
           bytes < max(1, previousBytes / 2)
        {
            reasons.append("size-drop-vs-last-good:\(previousBytes)->\(bytes)")
        }
        if (lastKnownGood["hasMeta"] as? Bool) == true, !self.hasMeta(root) {
            reasons.append("missing-meta-vs-last-good")
        }
        if (lastKnownGood["gatewayMode"] as? String) != nil, self.gatewayMode(root) == nil {
            reasons.append("gateway-mode-missing-vs-last-good")
        }
        if let root, (lastKnownGood["gatewayMode"] as? String) != nil, self.isUpdateChannelOnlyRoot(root) {
            reasons.append("update-channel-only-root")
        }
        return reasons
    }

    private static func readConfigFingerprint(at url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let root = self.parseConfigData(data)
        return self.configFingerprint(
            data: data,
            root: root,
            configURL: url,
            observedAt: ISO8601DateFormatter().string(from: Date()))
    }

    private static func configTimestampToken(_ timestamp: String) -> String {
        timestamp.replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
    }

    private static func persistClobberedSnapshot(data: Data, configURL: URL, observedAt: String) -> String? {
        let url = configURL.deletingLastPathComponent()
            .appendingPathComponent("\(configURL.lastPathComponent).clobbered.\(self.configTimestampToken(observedAt))")
        guard !FileManager().fileExists(atPath: url.path) else { return url.path }
        do {
            try data.write(to: url, options: [])
            return url.path
        } catch {
            return nil
        }
    }

    private static func observeConfigRead(data: Data, root: [String: Any]?, configURL: URL, valid: Bool) {
        let observedAt = ISO8601DateFormatter().string(from: Date())
        let current = self.configFingerprint(data: data, root: root, configURL: configURL, observedAt: observedAt)
        var state = self.readConfigHealthState()
        let entry = self.configHealthEntry(state: state, configPath: configURL.path)
        let lastKnownGood = entry["lastKnownGood"] as? [String: Any]
        let suspicious = self.observeSuspiciousReasons(
            root: root,
            bytes: current["bytes"] as? Int ?? 0,
            lastKnownGood: lastKnownGood)

        if suspicious.isEmpty {
            guard valid else { return }
            let nextEntry: [String: Any] = [
                "lastKnownGood": current,
                "lastObservedSuspiciousSignature": NSNull(),
            ]
            if !self.sameFingerprint(lastKnownGood, current) || entry["lastObservedSuspiciousSignature"] != nil {
                state = self.setConfigHealthEntry(state: state, configPath: configURL.path, entry: nextEntry)
                self.writeConfigHealthState(state)
            }
            return
        }

        let signature = "\((current["hash"] as? String) ?? ""):\(suspicious.joined(separator: ","))"
        if (entry["lastObservedSuspiciousSignature"] as? String) == signature {
            return
        }

        let backup = self.readConfigFingerprint(
            at: configURL.deletingLastPathComponent().appendingPathComponent("\(configURL.lastPathComponent).bak"))
        let clobberedPath = self.persistClobberedSnapshot(
            data: data,
            configURL: configURL,
            observedAt: observedAt)
        self.logger.warning("config observe anomaly (\(suspicious.joined(separator: ", "))) at \(configURL.path)")
        self.appendConfigObserveAudit([
            "phase": "read",
            "configPath": configURL.path,
            "exists": true,
            "valid": valid,
            "hash": current["hash"] ?? NSNull(),
            "bytes": current["bytes"] ?? NSNull(),
            "mtimeMs": current["mtimeMs"] ?? NSNull(),
            "ctimeMs": current["ctimeMs"] ?? NSNull(),
            "dev": current["dev"] ?? NSNull(),
            "ino": current["ino"] ?? NSNull(),
            "mode": current["mode"] ?? NSNull(),
            "nlink": current["nlink"] ?? NSNull(),
            "uid": current["uid"] ?? NSNull(),
            "gid": current["gid"] ?? NSNull(),
            "hasMeta": current["hasMeta"] ?? false,
            "gatewayMode": current["gatewayMode"] ?? NSNull(),
            "suspicious": suspicious,
            "lastKnownGoodHash": lastKnownGood?["hash"] ?? NSNull(),
            "lastKnownGoodBytes": lastKnownGood?["bytes"] ?? NSNull(),
            "lastKnownGoodMtimeMs": lastKnownGood?["mtimeMs"] ?? NSNull(),
            "lastKnownGoodCtimeMs": lastKnownGood?["ctimeMs"] ?? NSNull(),
            "lastKnownGoodDev": lastKnownGood?["dev"] ?? NSNull(),
            "lastKnownGoodIno": lastKnownGood?["ino"] ?? NSNull(),
            "lastKnownGoodMode": lastKnownGood?["mode"] ?? NSNull(),
            "lastKnownGoodNlink": lastKnownGood?["nlink"] ?? NSNull(),
            "lastKnownGoodUid": lastKnownGood?["uid"] ?? NSNull(),
            "lastKnownGoodGid": lastKnownGood?["gid"] ?? NSNull(),
            "lastKnownGoodGatewayMode": lastKnownGood?["gatewayMode"] ?? NSNull(),
            "backupHash": backup?["hash"] ?? NSNull(),
            "backupBytes": backup?["bytes"] ?? NSNull(),
            "backupMtimeMs": backup?["mtimeMs"] ?? NSNull(),
            "backupCtimeMs": backup?["ctimeMs"] ?? NSNull(),
            "backupDev": backup?["dev"] ?? NSNull(),
            "backupIno": backup?["ino"] ?? NSNull(),
            "backupMode": backup?["mode"] ?? NSNull(),
            "backupNlink": backup?["nlink"] ?? NSNull(),
            "backupUid": backup?["uid"] ?? NSNull(),
            "backupGid": backup?["gid"] ?? NSNull(),
            "backupGatewayMode": backup?["gatewayMode"] ?? NSNull(),
            "clobberedPath": clobberedPath ?? NSNull(),
        ])
        var nextEntry = entry
        nextEntry["lastObservedSuspiciousSignature"] = signature
        state = self.setConfigHealthEntry(state: state, configPath: configURL.path, entry: nextEntry)
        self.writeConfigHealthState(state)
    }

    private static func appendConfigWriteAudit(_ fields: [String: Any]) {
        var record: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "source": "macos-openclaw-config-file",
            "event": "config.write",
            "pid": ProcessInfo.processInfo.processIdentifier,
            "argv": Array(ProcessInfo.processInfo.arguments.prefix(8)),
        ]
        for (key, value) in fields {
            record[key] = value is NSNull ? NSNull() : value
        }
        guard JSONSerialization.isValidJSONObject(record),
              let data = try? JSONSerialization.data(withJSONObject: record)
        else {
            return
        }
        var line = Data()
        line.append(data)
        line.append(0x0A)
        let logURL = self.configAuditLogURL()
        do {
            try FileManager().createDirectory(
                at: logURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            if !FileManager().fileExists(atPath: logURL.path) {
                FileManager().createFile(atPath: logURL.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: logURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } catch {
            // best-effort
        }
    }

    private static func appendConfigObserveAudit(_ fields: [String: Any]) {
        var record: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "source": "macos-openclaw-config-file",
            "event": "config.observe",
            "pid": ProcessInfo.processInfo.processIdentifier,
            "argv": Array(ProcessInfo.processInfo.arguments.prefix(8)),
        ]
        for (key, value) in fields {
            record[key] = value is NSNull ? NSNull() : value
        }
        guard JSONSerialization.isValidJSONObject(record),
              let data = try? JSONSerialization.data(withJSONObject: record)
        else {
            return
        }
        var line = Data()
        line.append(data)
        line.append(0x0A)
        let logURL = self.configAuditLogURL()
        do {
            try FileManager().createDirectory(
                at: logURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            if !FileManager().fileExists(atPath: logURL.path) {
                FileManager().createFile(atPath: logURL.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: logURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } catch {
            // best-effort
        }
    }
}
