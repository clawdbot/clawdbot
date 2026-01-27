import MoltbotProtocol
import Foundation

enum MoltbotConfigFile {
    private static let logger = Logger(subsystem: "com.clawdbot", category: "config")

    static func url() -> URL {
        MoltbotPaths.configURL
    }

    static func stateDirURL() -> URL {
        MoltbotPaths.stateDirURL
    }

    static func defaultWorkspaceURL() -> URL {
        MoltbotPaths.workspaceURL
    }

    static func loadDict() -> [String: Any] {
        let url = self.url()
        guard FileManager().fileExists(atPath: url.path) else { return [:] }
        do {
            let data = try Data(contentsOf: url)
            guard let root = self.parseConfigData(data) else {
                self.logger.warning("config JSON root invalid")
                return [:]
            }
            return root
        } catch {
            self.logger.warning("config read failed: \(error.localizedDescription)")
            return [:]
        }
    }

    static func saveDict(_ dict: [String: Any]) {
        // Nix mode disables config writes in production, but tests rely on saving temp configs.
        if ProcessInfo.processInfo.isNixMode, !ProcessInfo.processInfo.isRunningTests { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
            let url = self.url()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
        } catch {
            self.logger.error("config save failed: \(error.localizedDescription)")
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
        let root = self.loadDict()
        let agents = root["agents"] as? [String: Any]
        let defaults = agents?["defaults"] as? [String: Any]
        return defaults?["workspace"] as? String
    }

    static func setAgentWorkspace(_ workspace: String?) {
        var root = self.loadDict()
        var agents = root["agents"] as? [String: Any] ?? [:]
        var defaults = agents["defaults"] as? [String: Any] ?? [:]
        let trimmed = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            defaults.removeValue(forKey: "workspace")
        } else {
            defaults["workspace"] = trimmed
        }
        if defaults.isEmpty {
            agents.removeValue(forKey: "defaults")
        } else {
            agents["defaults"] = defaults
        }
        if agents.isEmpty {
            root.removeValue(forKey: "agents")
        } else {
            root["agents"] = agents
        }
        self.saveDict(root)
        self.logger.debug("agents.defaults.workspace updated set=\(!trimmed.isEmpty)")
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
        let trimmedSshHost = sshHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSshHost.isEmpty,
              let url = self.remoteGatewayUrl(),
              let port = url.port,
              port > 0,
              let urlHost = url.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !urlHost.isEmpty
        else {
            return nil
        }

        let sshKey = Self.hostKey(trimmedSshHost)
        let urlKey = Self.hostKey(urlHost)
        guard !sshKey.isEmpty, !urlKey.isEmpty, sshKey == urlKey else { return nil }
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

    private static func hostKey(_ host: String) -> String {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return "" }
        if trimmed.contains(":") { return trimmed }
        let digits = CharacterSet(charactersIn: "0123456789.")
        if trimmed.rangeOfCharacter(from: digits.inverted) == nil {
            return trimmed
        }
        return trimmed.split(separator: ".").first.map(String.init) ?? trimmed
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
}
