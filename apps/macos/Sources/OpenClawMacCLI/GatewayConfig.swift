import Foundation

struct GatewayConfig {
    var mode: String?
    var bind: String?
    var port: Int?
    var remoteUrl: String?
    var remotePort: Int?
    var token: String?
    var password: String?
    var remoteToken: String?
    var remotePassword: String?
}

struct GatewayEndpoint {
    let url: URL
    let token: String?
    let password: String?
    let mode: String
}

/// Keep standalone CLI reads and configure-remote writes on the same profile.
/// An explicit config path wins; otherwise the selected state directory owns openclaw.json.
func resolveOpenClawConfigURL() -> URL {
    if let configPath = openClawEnvironmentPath("OPENCLAW_CONFIG_PATH") {
        return URL(fileURLWithPath: NSString(string: configPath).expandingTildeInPath)
    }
    let stateDir = openClawEnvironmentPath("OPENCLAW_STATE_DIR").map {
        URL(fileURLWithPath: NSString(string: $0).expandingTildeInPath, isDirectory: true)
    } ?? FileManager().homeDirectoryForCurrentUser.appendingPathComponent(".openclaw", isDirectory: true)
    return stateDir.appendingPathComponent("openclaw.json")
}

private func openClawEnvironmentPath(_ key: String) -> String? {
    guard let raw = ProcessInfo.processInfo.environment[key] else { return nil }
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
}

func loadGatewayConfig() -> GatewayConfig {
    guard let data = try? Data(contentsOf: resolveOpenClawConfigURL()) else { return GatewayConfig() }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return GatewayConfig()
    }

    var cfg = GatewayConfig()
    if let gateway = json["gateway"] as? [String: Any] {
        cfg.mode = gateway["mode"] as? String
        cfg.bind = gateway["bind"] as? String
        cfg.port = gateway["port"] as? Int ?? parseInt(gateway["port"])

        if let auth = gateway["auth"] as? [String: Any] {
            cfg.token = auth["token"] as? String
            cfg.password = auth["password"] as? String
        }
        if let remote = gateway["remote"] as? [String: Any] {
            cfg.remoteUrl = remote["url"] as? String
            cfg.remotePort = remote["remotePort"] as? Int ?? parseInt(remote["remotePort"])
            cfg.remoteToken = remote["token"] as? String
            cfg.remotePassword = remote["password"] as? String
        }
    }
    return cfg
}

func parseInt(_ value: Any?) -> Int? {
    switch value {
    case let number as Int:
        number
    case let number as Double:
        Int(number)
    case let raw as String:
        Int(raw.trimmingCharacters(in: .whitespacesAndNewlines))
    default:
        nil
    }
}
