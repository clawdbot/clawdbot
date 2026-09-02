import CryptoKit
import Foundation
import OpenClawDiscovery
import OpenClawKit
import OpenClawProtocol

struct ConnectOptions {
    var url: String?
    var token: String?
    var password: String?
    var mode: String?
    var timeoutMs: Int = 15000
    var json: Bool = false
    var probe: Bool = false
    var clientId: String = "openclaw-macos"
    var clientMode: String = "ui"
    var displayName: String?
    var role: String = "operator"
    var scopes: [String] = defaultOperatorConnectScopes
    var scopesAreExplicit: Bool = false
    var help: Bool = false

    static func parse(_ args: [String]) -> ConnectOptions {
        var opts = ConnectOptions()
        let flagHandlers: [String: (inout ConnectOptions) -> Void] = [
            "-h": { $0.help = true },
            "--help": { $0.help = true },
            "--json": { $0.json = true },
            "--probe": { $0.probe = true },
        ]
        let valueHandlers: [String: (inout ConnectOptions, String) -> Void] = [
            "--url": { $0.url = $1 },
            "--token": { $0.token = $1 },
            "--password": { $0.password = $1 },
            "--mode": { $0.mode = $1 },
            "--timeout": { opts, raw in
                if let parsed = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    opts.timeoutMs = max(250, parsed)
                }
            },
            "--client-id": { $0.clientId = $1 },
            "--client-mode": { $0.clientMode = $1 },
            "--display-name": { $0.displayName = $1 },
            "--role": { $0.role = $1 },
            "--scopes": { opts, raw in
                opts.scopes = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                opts.scopesAreExplicit = true
            },
        ]
        var i = 0
        while i < args.count {
            let arg = args[i]
            if let handler = flagHandlers[arg] {
                handler(&opts)
                i += 1
                continue
            }
            if let handler = valueHandlers[arg], let value = CLIArgParsingSupport.nextValue(args, index: &i) {
                handler(&opts, value)
                i += 1
                continue
            }
            i += 1
        }
        return opts
    }
}

struct ConnectOutput: Encodable {
    var status: String
    var url: String
    var mode: String
    var role: String
    var clientId: String
    var clientMode: String
    var scopes: [String]
    var snapshot: HelloOk?
    var health: ProtoAnyCodable?
    var error: String?
}

actor SnapshotStore {
    private var value: (snapshot: HelloOk, generation: UInt64)?
    // The channel awaits retirement before reconnecting. Keep that socket epoch
    // so a queued old callback cannot overwrite the replacement snapshot.
    private var activeGeneration: UInt64?
    private var lastRetiredGeneration: UInt64?

    func set(_ snapshot: HelloOk, generation: UInt64) {
        guard self.admitGeneration(generation) else { return }
        self.value = (snapshot, generation)
    }

    func retire(generation: UInt64) {
        guard self.retireGeneration(generation) else { return }
        if self.value?.generation == generation {
            self.value = nil
        }
    }

    func get() -> HelloOk? {
        self.value?.snapshot
    }

    private func admitGeneration(_ generation: UInt64) -> Bool {
        if let lastRetiredGeneration,
           generation <= lastRetiredGeneration
        {
            return false
        }
        if let activeGeneration {
            return generation == activeGeneration
        }
        self.activeGeneration = generation
        return true
    }

    private func retireGeneration(_ generation: UInt64) -> Bool {
        if let lastRetiredGeneration,
           generation <= lastRetiredGeneration
        {
            return false
        }
        if let activeGeneration,
           generation != activeGeneration
        {
            return false
        }
        self.activeGeneration = nil
        self.lastRetiredGeneration = generation
        return true
    }
}

func runConnect(_ args: [String]) async {
    let opts = ConnectOptions.parse(args)
    if opts.help {
        print("""
        openclaw-mac connect

        Usage:
          openclaw-mac connect [--url <ws://host:port>] [--token <token>] [--password <password>]
                               [--mode <local|remote>] [--timeout <ms>] [--probe] [--json]
                               [--client-id <id>] [--client-mode <mode>] [--display-name <name>]
                               [--role <role>] [--scopes <a,b,c>]

        Options:
          --url <url>        Gateway WebSocket URL (overrides config)
          --token <token>    Gateway token (if required)
          --password <pw>    Gateway password (if required)
          --mode <mode>      Resolve from config: local|remote (default: config or local)
          --timeout <ms>     Request timeout (default: 15000)
          --probe            Force a fresh health probe
          --json             Emit JSON
          --client-id <id>   Override client id (default: openclaw-macos)
          --client-mode <m>  Override client mode (default: ui)
          --display-name <n> Override display name
          --role <role>      Override role (default: operator)
          --scopes <a,b,c>   Override scopes list
          -h, --help         Show help
        """)
        return
    }

    let config = loadGatewayConfig()
    do {
        let endpoint = try resolveGatewayEndpoint(opts: opts, config: config)
        let displayName = opts.displayName ?? Host.current().localizedName ?? "OpenClaw macOS Debug CLI"
        let connectOptions = makeGatewayConnectOptions(
            opts: opts,
            endpoint: endpoint,
            displayName: displayName)

        let snapshotStore = SnapshotStore()
        let channel = GatewayChannelActor(
            url: endpoint.url,
            token: endpoint.token,
            password: endpoint.password,
            pushHandler: { push, socketGeneration in
                if case let .snapshot(ok) = push {
                    await snapshotStore.set(ok, generation: socketGeneration)
                }
            },
            connectOptions: connectOptions,
            disconnectHandler: { _, socketGeneration in
                await snapshotStore.retire(generation: socketGeneration)
            })

        let params: [String: KitAnyCodable]? = opts.probe ? ["probe": KitAnyCodable(true)] : nil
        let data = try await channel.request(
            method: "health",
            params: params,
            timeoutMs: Double(opts.timeoutMs))
        let health = try? JSONDecoder().decode(ProtoAnyCodable.self, from: data)
        let snapshot = await snapshotStore.get()
        await channel.shutdown()

        let output = ConnectOutput(
            status: "ok",
            url: endpoint.url.absoluteString,
            mode: endpoint.mode,
            role: opts.role,
            clientId: opts.clientId,
            clientMode: opts.clientMode,
            scopes: opts.scopes,
            snapshot: snapshot,
            health: health,
            error: nil)
        printConnectOutput(output, json: opts.json)
    } catch {
        let endpoint = bestEffortEndpoint(opts: opts, config: config)
        let fallbackMode = (opts.mode ?? config.mode ?? "local").lowercased()
        let output = ConnectOutput(
            status: "error",
            url: endpoint?.url.absoluteString ?? "unknown",
            mode: endpoint?.mode ?? fallbackMode,
            role: opts.role,
            clientId: opts.clientId,
            clientMode: opts.clientMode,
            scopes: opts.scopes,
            snapshot: nil,
            health: nil,
            error: error.localizedDescription)
        printConnectOutput(output, json: opts.json)
        exit(1)
    }
}

private func printConnectOutput(_ output: ConnectOutput, json: Bool) {
    if json {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(output),
           let text = String(data: data, encoding: .utf8)
        {
            print(text)
        } else {
            print("{\"error\":\"failed to encode JSON\"}")
        }
        return
    }

    print("OpenClaw macOS Gateway Connect")
    print("Status: \(output.status)")
    print("URL: \(output.url)")
    print("Mode: \(output.mode)")
    print("Client: \(output.clientId) (\(output.clientMode))")
    print("Role: \(output.role)")
    print("Scopes: \(output.scopes.joined(separator: ", "))")
    if let snapshot = output.snapshot {
        print("Protocol: \(snapshot._protocol)")
        if let version = snapshot.server["version"]?.value as? String {
            print("Server: \(version)")
        }
    }
    if let health = output.health,
       let ok = (health.value as? [String: ProtoAnyCodable])?["ok"]?.value as? Bool
    {
        print("Health: \(ok ? "ok" : "error")")
    } else if output.health != nil {
        print("Health: received")
    }
    if let error = output.error {
        print("Error: \(error)")
    }
}

func resolveGatewayEndpoint(opts: ConnectOptions, config: GatewayConfig) throws -> GatewayEndpoint {
    let resolvedMode = (opts.mode ?? config.mode ?? "local").lowercased()
    if let raw = opts.url, !raw.isEmpty {
        return try gatewayEndpoint(
            fromRawURL: raw,
            opts: opts,
            mode: resolvedMode,
            config: config,
            inheritConfigCredentials: false)
    }

    if resolvedMode == "remote" {
        guard let raw = config.remoteUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty
        else {
            throw NSError(
                domain: "Gateway",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "gateway.remote.url is missing"])
        }
        return try gatewayEndpoint(fromRawURL: raw, opts: opts, mode: resolvedMode, config: config)
    }

    let port = config.port ?? 18789
    let host = resolveLocalHost(bind: config.bind)
    guard let url = URL(string: "ws://\(host):\(port)") else {
        throw NSError(
            domain: "Gateway",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "invalid url: ws://\(host):\(port)"])
    }
    return GatewayEndpoint(
        url: url,
        token: resolvedToken(opts: opts, mode: resolvedMode, config: config),
        password: resolvedPassword(opts: opts, mode: resolvedMode, config: config),
        mode: resolvedMode)
}

private func bestEffortEndpoint(opts: ConnectOptions, config: GatewayConfig) -> GatewayEndpoint? {
    try? resolveGatewayEndpoint(opts: opts, config: config)
}

private func gatewayEndpoint(
    fromRawURL raw: String,
    opts: ConnectOptions,
    mode: String,
    config: GatewayConfig,
    inheritConfigCredentials: Bool = true) throws -> GatewayEndpoint
{
    guard let url = URL(string: raw) else {
        throw NSError(domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid url: \(raw)"])
    }
    return GatewayEndpoint(
        url: url,
        token: resolvedToken(
            opts: opts,
            mode: mode,
            config: config,
            inheritConfigCredentials: inheritConfigCredentials),
        password: resolvedPassword(
            opts: opts,
            mode: mode,
            config: config,
            inheritConfigCredentials: inheritConfigCredentials),
        mode: mode)
}

private func resolvedToken(
    opts: ConnectOptions,
    mode: String,
    config: GatewayConfig,
    inheritConfigCredentials: Bool = true) -> String?
{
    if let token = opts.token, !token.isEmpty { return token }
    guard inheritConfigCredentials else { return nil }
    if mode == "remote" {
        return config.remoteToken
    }
    return config.token
}

private func resolvedPassword(
    opts: ConnectOptions,
    mode: String,
    config: GatewayConfig,
    inheritConfigCredentials: Bool = true) -> String?
{
    if let password = opts.password, !password.isEmpty { return password }
    guard inheritConfigCredentials else { return nil }
    if mode == "remote" {
        return config.remotePassword
    }
    return config.password
}

func makeGatewayConnectOptions(
    opts: ConnectOptions,
    endpoint: GatewayEndpoint,
    displayName: String) -> GatewayConnectOptions
{
    let hasExplicitURL = opts.url?.isEmpty == false
    let deviceAuthGatewayID = gatewayURLDeviceAuthOwner(
        endpoint.url,
        mode: endpoint.mode)
    return GatewayConnectOptions(
        role: opts.role,
        scopes: opts.scopes,
        scopesAreExplicit: opts.scopesAreExplicit,
        caps: [],
        commands: [],
        permissions: [:],
        clientId: opts.clientId,
        clientMode: opts.clientMode,
        clientDisplayName: displayName,
        allowStoredDeviceAuth: !hasExplicitURL,
        // Explicit endpoints never consume stored auth. Every route still owns
        // newly issued tokens so config-selected endpoints never fall back to
        // the legacy role-global namespace either.
        deviceAuthGatewayID: deviceAuthGatewayID)
}

func gatewayURLDeviceAuthOwner(_ url: URL, mode: String) -> String {
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    components?.user = nil
    components?.password = nil
    let queryItems = components?.queryItems
    components?.queryItems = queryItems?.filter { queryItem in
        !isSensitiveGatewayQueryItem(queryItem.name)
    }
    if components?.queryItems?.isEmpty == true {
        components?.query = nil
    }
    components?.fragment = nil
    let endpoint = components?.string ?? "\(url.scheme ?? "")://\(url.host ?? "")\(url.path)"
    let route = "\(mode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())|\(endpoint)"
    let digest = SHA256.hash(data: Data(route.utf8))
    let fingerprint = digest.map { String(format: "%02x", $0) }.joined()
    return "openclaw-mac-cli:route:\(fingerprint)"
}

private func isSensitiveGatewayQueryItem(_ value: String) -> Bool {
    let normalized = value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
        .replacingOccurrences(of: "-", with: "_")
    return [
        "access_token", "api_key", "apikey", "app_secret", "auth", "auth_token",
        "authorization", "client_secret", "code", "credential", "hook_token", "id_token",
        "jwt", "key", "pass", "passwd", "password", "private_key", "refresh_token",
        "secret", "session", "signature", "token", "x_amz_security_token", "x_amz_signature",
    ].contains(normalized)
}

private func resolveLocalHost(bind: String?) -> String {
    let normalized = (bind ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let tailnetIP = TailscaleNetwork.detectTailnetIPv4()
    switch normalized {
    case "tailnet":
        return tailnetIP ?? "127.0.0.1"
    default:
        return "127.0.0.1"
    }
}
