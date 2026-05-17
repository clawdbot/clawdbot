import Foundation
#if canImport(Darwin)
import Darwin
#endif

private let appDefaultsSuites = ["ai.openclaw.mac", "ai.openclaw.mac.debug"]
private let appOnboardingVersion = 7

struct ConfigureRemoteOptions {
    var sshTarget: String?
    var directUrl: String?
    var localPort: Int = 18789
    var remotePort: Int = 18789
    var token: String?
    var password: String?
    var identity: String?
    var projectRoot: String?
    var cliPath: String?
    var json = false
    var help = false

    static func parse(_ args: [String]) throws -> ConfigureRemoteOptions {
        var opts = ConfigureRemoteOptions()
        var i = 0
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "-h", "--help":
                opts.help = true
            case "--json":
                opts.json = true
            case "--ssh-target":
                opts.sshTarget = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--direct-url":
                opts.directUrl = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--local-port":
                opts.localPort = try parsePortFlag(args, index: &i, flag: arg)
            case "--remote-port":
                opts.remotePort = try parsePortFlag(args, index: &i, flag: arg)
            case "--token":
                opts.token = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--password":
                opts.password = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--identity":
                opts.identity = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--project-root":
                opts.projectRoot = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--cli-path":
                opts.cliPath = CLIArgParsingSupport.nextValue(args, index: &i)
            default:
                break
            }
            i += 1
        }
        return opts
    }
}

struct ConfigureRemoteOutput: Encodable {
    var status: String
    var configPath: String
    var mode: String
    var transport: String
    var sshTarget: String?
    var localUrl: String?
    var remoteUrl: String
    var remotePort: Int
    var onboardingSkipped: Bool
}

func runConfigureRemote(_ args: [String]) {
    do {
        let opts = try ConfigureRemoteOptions.parse(args)
        if opts.help {
            print("""
            openclaw-mac configure-remote

            Usage:
              openclaw-mac configure-remote --ssh-target <user@host[:port]> [--local-port <port>]
                                          [--remote-port <port>] [--token <token>] [--password <password>]
                                          [--identity <path>] [--project-root <path>] [--cli-path <path>] [--json]
              openclaw-mac configure-remote --direct-url <ws://host:port|wss://host> [--token <token>]
                                          [--password <password>] [--project-root <path>] [--cli-path <path>] [--json]

            Options:
              --ssh-target <t>    SSH target for the remote gateway host.
              --direct-url <url>  Direct remote gateway URL; skips SSH tunneling.
              --local-port <p>    Local tunnel port for the mac app/UI. Default: 18789.
              --remote-port <p>   Gateway port on the remote host. Default: 18789.
              --token <token>     Remote gateway token.
              --password <pw>     Remote gateway password.
              --identity <path>   SSH identity file.
              --project-root <p>  Remote OpenClaw checkout for CLI commands.
              --cli-path <path>   Remote openclaw executable or entrypoint.
              --json              Emit JSON.
              -h, --help          Show help.
            """)
            return
        }
        let output = try configureRemote(opts)
        printConfigureRemoteOutput(output, json: opts.json)
    } catch {
        if args.contains("--json") {
            printJSONError(error.localizedDescription)
        } else {
            fputs("configure-remote: \(error.localizedDescription)\n", stderr)
        }
        exit(1)
    }
}

@discardableResult
func configureRemote(_ opts: ConfigureRemoteOptions) throws -> ConfigureRemoteOutput {
    if let directUrlRaw = opts.directUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
       !directUrlRaw.isEmpty
    {
        return try configureDirectRemote(opts, directUrlRaw: directUrlRaw)
    }
    return try configureSSHRemote(opts)
}

private func configureSSHRemote(_ opts: ConfigureRemoteOptions) throws -> ConfigureRemoteOutput {
    let target = opts.sshTarget?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard isValidSSHTarget(target) else {
        throw NSError(
            domain: "ConfigureRemote",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "SSH target must look like user@host[:port]"])
    }

    let configURL = openClawConfigURL()
    var root = try loadConfigRoot(from: configURL)
    var gateway = root["gateway"] as? [String: Any] ?? [:]
    var remote = gateway["remote"] as? [String: Any] ?? [:]
    let localURL = "ws://127.0.0.1:\(opts.localPort)"

    gateway["mode"] = "remote"
    gateway["port"] = opts.localPort
    remote["transport"] = "ssh"
    remote["url"] = localURL
    remote["remotePort"] = opts.remotePort
    remote["sshTarget"] = target
    updateStringIfProvided(&remote, key: "sshIdentity", value: opts.identity)
    updateStringIfProvided(&remote, key: "token", value: opts.token)
    updateStringIfProvided(&remote, key: "password", value: opts.password)
    gateway["remote"] = remote
    root["gateway"] = gateway

    try saveConfigRoot(root, to: configURL)
    writeAppDefaults(opts: opts, target: target)

    return ConfigureRemoteOutput(
        status: "ok",
        configPath: configURL.path,
        mode: "remote",
        transport: "ssh",
        sshTarget: target,
        localUrl: localURL,
        remoteUrl: localURL,
        remotePort: opts.remotePort,
        onboardingSkipped: true)
}

private func configureDirectRemote(
    _ opts: ConfigureRemoteOptions,
    directUrlRaw: String) throws -> ConfigureRemoteOutput
{
    guard let directURL = normalizeDirectURL(directUrlRaw) else {
        throw NSError(
            domain: "ConfigureRemote",
            code: 2,
            userInfo: [
                NSLocalizedDescriptionKey: "Direct URL must be ws:// for private/Tailscale hosts or wss:// for remote hosts",
            ])
    }

    let configURL = openClawConfigURL()
    var root = try loadConfigRoot(from: configURL)
    var gateway = root["gateway"] as? [String: Any] ?? [:]
    var remote = gateway["remote"] as? [String: Any] ?? [:]

    gateway["mode"] = "remote"
    remote["transport"] = "direct"
    remote["url"] = directURL.absoluteString
    remote.removeValue(forKey: "remotePort")
    remote.removeValue(forKey: "sshTarget")
    remote.removeValue(forKey: "sshIdentity")
    updateStringIfProvided(&remote, key: "token", value: opts.token)
    updateStringIfProvided(&remote, key: "password", value: opts.password)
    gateway["remote"] = remote
    root["gateway"] = gateway

    try saveConfigRoot(root, to: configURL)
    writeAppDefaults(opts: opts, target: "")

    return ConfigureRemoteOutput(
        status: "ok",
        configPath: configURL.path,
        mode: "remote",
        transport: "direct",
        sshTarget: nil,
        localUrl: nil,
        remoteUrl: directURL.absoluteString,
        remotePort: defaultPort(for: directURL) ?? opts.remotePort,
        onboardingSkipped: true)
}

private func openClawConfigURL() -> URL {
    if let raw = ProcessInfo.processInfo.environment["OPENCLAW_CONFIG_PATH"],
       !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    {
        return URL(fileURLWithPath: NSString(string: raw).expandingTildeInPath)
    }
    return FileManager().homeDirectoryForCurrentUser.appendingPathComponent(".openclaw/openclaw.json")
}

private func loadConfigRoot(from url: URL) throws -> [String: Any] {
    guard FileManager().isReadableFile(atPath: url.path) else { return [:] }
    let data = try Data(contentsOf: url)
    return try (JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
}

private func saveConfigRoot(_ root: [String: Any], to url: URL) throws {
    try FileManager().createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: url, options: [.atomic])
}

private func writeAppDefaults(opts: ConfigureRemoteOptions, target: String) {
    for suite in appDefaultsSuites {
        guard let defaults = UserDefaults(suiteName: suite) else { continue }
        defaults.set("remote", forKey: "openclaw.connectionMode")
        setDefaultString(defaults, key: "openclaw.remoteTarget", value: target)
        defaults.set(true, forKey: "openclaw.onboardingSeen")
        defaults.set(appOnboardingVersion, forKey: "openclaw.onboardingVersion")
        setDefaultStringIfProvided(defaults, key: "openclaw.remoteIdentity", value: opts.identity)
        setDefaultStringIfProvided(defaults, key: "openclaw.remoteProjectRoot", value: opts.projectRoot)
        setDefaultStringIfProvided(defaults, key: "openclaw.remoteCliPath", value: opts.cliPath)
        defaults.synchronize()
    }
}

private func normalizeDirectURL(_ raw: String) -> URL? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
    let scheme = url.scheme?.lowercased() ?? ""
    guard scheme == "ws" || scheme == "wss" else { return nil }
    let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !host.isEmpty else { return nil }
    if scheme == "ws",
       !isLoopbackHost(host),
       !isTrustedPlaintextRemoteHost(host)
    {
        return nil
    }
    if scheme == "ws", url.port == nil {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        components.port = 18789
        return components.url
    }
    return url
}

private func defaultPort(for url: URL) -> Int? {
    if let port = url.port { return port }
    switch url.scheme?.lowercased() {
    case "wss":
        return 443
    case "ws":
        return 18789
    default:
        return nil
    }
}

private func isLoopbackHost(_ host: String) -> Bool {
    let lower = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return lower == "localhost" || lower == "127.0.0.1" || lower == "::1"
}

private func isTrustedPlaintextRemoteHost(_ host: String) -> Bool {
    let lower = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !lower.isEmpty else { return false }
    if lower.hasSuffix(".local") || lower.hasSuffix(".ts.net") {
        return true
    }
    if isPrivateIPv6Literal(lower) {
        return true
    }
    guard let parts = ipv4Parts(lower) else { return false }
    switch (parts[0], parts[1]) {
    case (10, _), (192, 168), (169, 254):
        return true
    case (172, 16...31), (100, 64...127):
        return true
    default:
        return false
    }
}

private func ipv4Parts(_ value: String) -> [Int]? {
    let labels = value.split(separator: ".", omittingEmptySubsequences: false)
    guard labels.count == 4 else { return nil }
    var parts: [Int] = []
    parts.reserveCapacity(4)
    for label in labels {
        guard !label.isEmpty,
              label.allSatisfy(\.isNumber),
              let part = Int(label),
              part >= 0,
              part <= 255
        else {
            return nil
        }
        parts.append(part)
    }
    return parts
}

private func isPrivateIPv6Literal(_ value: String) -> Bool {
    #if canImport(Darwin)
    var addr = in6_addr()
    guard value.withCString({ inet_pton(AF_INET6, $0, &addr) }) == 1 else {
        return false
    }
    return value.hasPrefix("fc") || value.hasPrefix("fd") || value.hasPrefix("fe80:")
    #else
    return false
    #endif
}

private func setDefaultStringIfProvided(_ defaults: UserDefaults, key: String, value: String?) {
    guard let value else { return }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        defaults.removeObject(forKey: key)
    } else {
        defaults.set(trimmed, forKey: key)
    }
}

private func setDefaultString(_ defaults: UserDefaults, key: String, value: String) {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        defaults.removeObject(forKey: key)
    } else {
        defaults.set(trimmed, forKey: key)
    }
}

private func updateStringIfProvided(_ dictionary: inout [String: Any], key: String, value: String?) {
    guard let value else { return }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        dictionary.removeValue(forKey: key)
    } else {
        dictionary[key] = trimmed
    }
}

private func parsePort(_ raw: String) -> Int? {
    let port = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines))
    guard let port, port > 0, port <= 65535 else { return nil }
    return port
}

private func parsePortFlag(_ args: [String], index: inout Int, flag: String) throws -> Int {
    guard let value = CLIArgParsingSupport.nextValue(args, index: &index),
          let port = parsePort(value)
    else {
        throw NSError(
            domain: "ConfigureRemote",
            code: 4,
            userInfo: [NSLocalizedDescriptionKey: "\(flag) must be an integer from 1 to 65535"])
    }
    return port
}

private func isValidSSHTarget(_ raw: String) -> Bool {
    if raw.isEmpty || raw.hasPrefix("-") { return false }
    if raw.rangeOfCharacter(from: CharacterSet.whitespacesAndNewlines.union(.controlCharacters)) != nil {
        return false
    }
    let targetParts = raw.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false)
    let hostPort: String
    if targetParts.count == 2 {
        guard !targetParts[0].isEmpty, !targetParts[1].isEmpty else { return false }
        hostPort = String(targetParts[1])
    } else {
        hostPort = raw
    }
    guard !hostPort.isEmpty else { return false }
    guard !hostPort.hasPrefix(":") else { return false }
    if let colon = hostPort.lastIndex(of: ":"), colon != hostPort.startIndex {
        let portRaw = hostPort[hostPort.index(after: colon)...]
        return parsePort(String(portRaw)) != nil
    }
    return true
}

private func printConfigureRemoteOutput(_ output: ConfigureRemoteOutput, json: Bool) {
    if json {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(output),
           let text = String(data: data, encoding: .utf8)
        {
            print(text)
        }
        return
    }
    print("OpenClaw macOS Remote Config")
    print("Status: \(output.status)")
    print("Config: \(output.configPath)")
    print("Mode: \(output.mode)")
    print("Transport: \(output.transport)")
    if let sshTarget = output.sshTarget {
        print("SSH target: \(sshTarget)")
    }
    if let localUrl = output.localUrl {
        print("Local URL: \(localUrl)")
    }
    print("Remote URL: \(output.remoteUrl)")
    print("Remote port: \(output.remotePort)")
    print("Onboarding: skipped")
}

private func printJSONError(_ message: String) {
    let payload = [
        "status": "error",
        "error": message,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]),
       let text = String(data: data, encoding: .utf8)
    {
        print(text)
    } else {
        print("{\"status\":\"error\"}")
    }
}
