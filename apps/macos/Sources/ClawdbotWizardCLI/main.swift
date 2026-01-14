import ClawdbotProtocol
import Darwin
import Foundation

struct WizardCliOptions {
    var url: String?
    var token: String?
    var password: String?
    var mode: String = "local"
    var workspace: String?
    var json: Bool = false
    var help: Bool = false

    static func parse(_ args: [String]) -> WizardCliOptions {
        var opts = WizardCliOptions()
        var i = 0
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "-h", "--help":
                opts.help = true
            case "--json":
                opts.json = true
            case "--url":
                opts.url = self.nextValue(args, index: &i)
            case "--token":
                opts.token = self.nextValue(args, index: &i)
            case "--password":
                opts.password = self.nextValue(args, index: &i)
            case "--mode":
                if let value = nextValue(args, index: &i) {
                    opts.mode = value
                }
            case "--workspace":
                opts.workspace = self.nextValue(args, index: &i)
            default:
                break
            }
            i += 1
        }
        return opts
    }

    private static func nextValue(_ args: [String], index: inout Int) -> String? {
        guard index + 1 < args.count else { return nil }
        index += 1
        return args[index].trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct GatewayConfig {
    var mode: String?
    var bind: String?
    var port: Int?
    var remoteUrl: String?
    var token: String?
    var password: String?
    var remoteToken: String?
    var remotePassword: String?
}

enum WizardCliError: Error, CustomStringConvertible {
    case invalidUrl(String)
    case missingRemoteUrl
    case gatewayError(String)
    case decodeError(String)
    case cancelled

    var description: String {
        switch self {
        case let .invalidUrl(raw): "Invalid URL: \(raw)"
        case .missingRemoteUrl: "gateway.remote.url is missing"
        case let .gatewayError(msg): msg
        case let .decodeError(msg): msg
        case .cancelled: "Wizard cancelled"
        }
    }
}

@main
struct ClawdbotWizardCLI {
    static func main() async {
        let opts = WizardCliOptions.parse(Array(CommandLine.arguments.dropFirst()))
        if opts.help {
            printUsage()
            return
        }

        let config = loadGatewayConfig()
        do {
            guard isatty(STDIN_FILENO) != 0 else {
                throw WizardCliError.gatewayError("Wizard requires an interactive TTY.")
            }
            let endpoint = try resolveGatewayEndpoint(opts: opts, config: config)
            let client = GatewayWizardClient(
                url: endpoint.url,
                token: endpoint.token,
                password: endpoint.password,
                json: opts.json)
            try await client.connect()
            defer { Task { await client.close() } }
            try await runWizard(client: client, opts: opts)
        } catch {
            fputs("wizard: \(error)\n", stderr)
            exit(1)
        }
    }
}

private struct GatewayEndpoint {
    let url: URL
    let token: String?
    let password: String?
}

private func printUsage() {
    print("""
    clawdbot-mac-wizard

    Usage:
      clawdbot-mac-wizard [--url <ws://host:port>] [--token <token>] [--password <password>]
                          [--mode <local|remote>] [--workspace <path>] [--json]

    Options:
      --url <url>        Gateway WebSocket URL (overrides config)
      --token <token>    Gateway token (if required)
      --password <pw>    Gateway password (if required)
      --mode <mode>      Wizard mode (local|remote). Default: local
      --workspace <path> Wizard workspace override
      --json             Print raw wizard responses
      -h, --help         Show help
    """)
}

private func resolveGatewayEndpoint(opts: WizardCliOptions, config: GatewayConfig) throws -> GatewayEndpoint {
    if let raw = opts.url, !raw.isEmpty {
        guard let url = URL(string: raw) else { throw WizardCliError.invalidUrl(raw) }
        return GatewayEndpoint(
            url: url,
            token: resolvedToken(opts: opts, config: config),
            password: resolvedPassword(opts: opts, config: config))
    }

    let mode = (config.mode ?? "local").lowercased()
    if mode == "remote" {
        guard let raw = config.remoteUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            throw WizardCliError.missingRemoteUrl
        }
        guard let url = URL(string: raw) else { throw WizardCliError.invalidUrl(raw) }
        return GatewayEndpoint(
            url: url,
            token: resolvedToken(opts: opts, config: config),
            password: resolvedPassword(opts: opts, config: config))
    }

    let port = config.port ?? 18789
    let host = "127.0.0.1"
    guard let url = URL(string: "ws://\(host):\(port)") else {
        throw WizardCliError.invalidUrl("ws://\(host):\(port)")
    }
    return GatewayEndpoint(
        url: url,
        token: resolvedToken(opts: opts, config: config),
        password: resolvedPassword(opts: opts, config: config))
}

private func resolvedToken(opts: WizardCliOptions, config: GatewayConfig) -> String? {
    if let token = opts.token, !token.isEmpty { return token }
    if let token = ProcessInfo.processInfo.environment["CLAWDBOT_GATEWAY_TOKEN"], !token.isEmpty {
        return token
    }
    if (config.mode ?? "local").lowercased() == "remote" {
        return config.remoteToken
    }
    return config.token
}

private func resolvedPassword(opts: WizardCliOptions, config: GatewayConfig) -> String? {
    if let password = opts.password, !password.isEmpty { return password }
    if let password = ProcessInfo.processInfo.environment["CLAWDBOT_GATEWAY_PASSWORD"], !password.isEmpty {
        return password
    }
    if (config.mode ?? "local").lowercased() == "remote" {
        return config.remotePassword
    }
    return config.password
}

private func loadGatewayConfig() -> GatewayConfig {
    let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".clawdbot")
        .appendingPathComponent("clawdbot.json")
    guard let data = try? Data(contentsOf: url) else { return GatewayConfig() }
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
            cfg.remoteToken = remote["token"] as? String
            cfg.remotePassword = remote["password"] as? String
        }
    }
    return cfg
}

private func parseInt(_ value: Any?) -> Int? {
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

actor GatewayWizardClient {
    private let url: URL
    private let token: String?
    private let password: String?
    private let json: Bool
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?

    init(url: URL, token: String?, password: String?, json: Bool) {
        self.url = url
        self.token = token
        self.password = password
        self.json = json
    }

    func connect() async throws {
        let socket = self.session.webSocketTask(with: self.url)
        socket.maximumMessageSize = 16 * 1024 * 1024
        socket.resume()
        self.task = socket
        try await self.sendConnect()
    }

    func close() {
        self.task?.cancel(with: .goingAway, reason: nil)
        self.task = nil
    }

    func request(method: String, params: [String: AnyCodable]?) async throws -> ResponseFrame {
        guard let task = self.task else {
            throw WizardCliError.gatewayError("gateway not connected")
        }
        let id = UUID().uuidString
        let frame = RequestFrame(
            type: "req",
            id: id,
            method: method,
            params: params.map { AnyCodable($0) })
        let data = try self.encoder.encode(frame)
        try await task.send(.data(data))

        while true {
            let message = try await task.receive()
            let frame = try decodeFrame(message)
            if case let .res(res) = frame, res.id == id {
                if res.ok == false {
                    let msg = (res.error?["message"]?.value as? String) ?? "gateway error"
                    throw WizardCliError.gatewayError(msg)
                }
                return res
            }
        }
    }

    func decodePayload<T: Decodable>(_ response: ResponseFrame, as _: T.Type) throws -> T {
        guard let payload = response.payload else {
            throw WizardCliError.decodeError("missing payload")
        }
        let data = try self.encoder.encode(payload)
        return try self.decoder.decode(T.self, from: data)
    }

    private func decodeFrame(_ message: URLSessionWebSocketTask.Message) throws -> GatewayFrame {
        let data: Data? = switch message {
        case let .data(data): data
        case let .string(text): text.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else {
            throw WizardCliError.decodeError("empty gateway response")
        }
        return try self.decoder.decode(GatewayFrame.self, from: data)
    }

    private func sendConnect() async throws {
        guard let task = self.task else {
            throw WizardCliError.gatewayError("gateway not connected")
        }
        let osVersion = ProcessInfo.processInfo.operatingSystemVersion
        let platform = "macos \(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)"
        let client: [String: AnyCodable] = [
            "id": AnyCodable("clawdbot-macos"),
            "displayName": AnyCodable(Host.current().localizedName ?? "Clawdbot macOS Wizard CLI"),
            "version": AnyCodable("dev"),
            "platform": AnyCodable(platform),
            "deviceFamily": AnyCodable("Mac"),
            "mode": AnyCodable("ui"),
            "instanceId": AnyCodable(UUID().uuidString),
        ]

        var params: [String: AnyCodable] = [
            "minProtocol": AnyCodable(GATEWAY_PROTOCOL_VERSION),
            "maxProtocol": AnyCodable(GATEWAY_PROTOCOL_VERSION),
            "client": AnyCodable(client),
            "caps": AnyCodable([String]()),
            "locale": AnyCodable(Locale.preferredLanguages.first ?? Locale.current.identifier),
            "userAgent": AnyCodable(ProcessInfo.processInfo.operatingSystemVersionString),
        ]
        if let token = self.token {
            params["auth"] = AnyCodable(["token": AnyCodable(token)])
        } else if let password = self.password {
            params["auth"] = AnyCodable(["password": AnyCodable(password)])
        }

        let reqId = UUID().uuidString
        let frame = RequestFrame(
            type: "req",
            id: reqId,
            method: "connect",
            params: AnyCodable(params))
        let data = try self.encoder.encode(frame)
        try await task.send(.data(data))

        let message = try await task.receive()
        let frameResponse = try decodeFrame(message)
        guard case let .res(res) = frameResponse, res.id == reqId else {
            throw WizardCliError.gatewayError("connect failed (unexpected response)")
        }
        if res.ok == false {
            let msg = (res.error?["message"]?.value as? String) ?? "gateway connect failed"
            throw WizardCliError.gatewayError(msg)
        }
        _ = try self.decodePayload(res, as: HelloOk.self)
    }
}

private func runWizard(client: GatewayWizardClient, opts: WizardCliOptions) async throws {
    var params: [String: AnyCodable] = [:]
    let mode = opts.mode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if mode == "local" || mode == "remote" {
        params["mode"] = AnyCodable(mode)
    }
    if let workspace = opts.workspace?.trimmingCharacters(in: .whitespacesAndNewlines), !workspace.isEmpty {
        params["workspace"] = AnyCodable(workspace)
    }

    let startResponse = try await client.request(method: "wizard.start", params: params)
    let startResult = try await client.decodePayload(startResponse, as: WizardStartResult.self)
    if opts.json {
        dumpResult(startResponse)
    }

    let sessionId = startResult.sessionid
    var nextResult = WizardNextResult(
        done: startResult.done,
        step: startResult.step,
        status: startResult.status,
        error: startResult.error)

    do {
        while true {
            let status = wizardStatusString(nextResult.status) ?? (nextResult.done ? "done" : "running")
            if status == "cancelled" {
                print("Wizard cancelled.")
                return
            }
            if status == "error" || (nextResult.done && nextResult.error != nil) {
                throw WizardCliError.gatewayError(nextResult.error ?? "wizard error")
            }
            if status == "done" || nextResult.done {
                print("Wizard complete.")
                return
            }

            if let step = decodeWizardStep(nextResult.step) {
                let answer = try promptAnswer(for: step)
                var answerPayload: [String: AnyCodable] = [
                    "stepId": AnyCodable(step.id),
                ]
                if !(answer is NSNull) {
                    answerPayload["value"] = AnyCodable(answer)
                }
                let response = try await client.request(
                    method: "wizard.next",
                    params: [
                        "sessionId": AnyCodable(sessionId),
                        "answer": AnyCodable(answerPayload),
                    ])
                nextResult = try await client.decodePayload(response, as: WizardNextResult.self)
                if opts.json {
                    dumpResult(response)
                }
            } else {
                let response = try await client.request(
                    method: "wizard.next",
                    params: ["sessionId": AnyCodable(sessionId)])
                nextResult = try await client.decodePayload(response, as: WizardNextResult.self)
                if opts.json {
                    dumpResult(response)
                }
            }
        }
    } catch WizardCliError.cancelled {
        _ = try? await client.request(
            method: "wizard.cancel",
            params: ["sessionId": AnyCodable(sessionId)])
        throw WizardCliError.cancelled
    }
}

private func dumpResult(_ response: ResponseFrame) {
    guard let payload = response.payload else {
        print("{\"error\":\"missing payload\"}")
        return
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(payload), let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

private func promptAnswer(for step: WizardStep) throws -> Any {
    let type = wizardStepType(step)
    if let title = step.title, !title.isEmpty {
        print("\n\(title)")
    }
    if let message = step.message, !message.isEmpty {
        print(message)
    }

    switch type {
    case "note":
        _ = try readLineWithPrompt("Continue? (enter)")
        return NSNull()
    case "progress":
        _ = try readLineWithPrompt("Continue? (enter)")
        return NSNull()
    case "action":
        _ = try readLineWithPrompt("Run? (enter)")
        return true
    case "text":
        let initial = anyCodableString(step.initialvalue)
        let prompt = step.placeholder ?? "Value"
        let value = try readLineWithPrompt("\(prompt)\(initial.isEmpty ? "" : " [\(initial)]")")
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? initial : trimmed
    case "confirm":
        let initial = anyCodableBool(step.initialvalue)
        let value = try readLineWithPrompt("Confirm? (y/n) [\(initial ? "y" : "n")]")
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.isEmpty { return initial }
        return trimmed == "y" || trimmed == "yes" || trimmed == "true"
    case "select":
        return try promptSelect(step)
    case "multiselect":
        return try promptMultiSelect(step)
    default:
        _ = try readLineWithPrompt("Continue? (enter)")
        return NSNull()
    }
}

private func promptSelect(_ step: WizardStep) throws -> Any {
    let options = parseWizardOptions(step.options)
    guard !options.isEmpty else { return NSNull() }
    for (idx, option) in options.enumerated() {
        let hint = option.hint?.isEmpty == false ? " — \(option.hint!)" : ""
        print("  [\(idx + 1)] \(option.label)\(hint)")
    }
    let initialIndex = options.firstIndex(where: { anyCodableEqual($0.value, step.initialvalue) })
    let defaultLabel = initialIndex.map { " [\($0 + 1)]" } ?? ""
    while true {
        let input = try readLineWithPrompt("Select one\(defaultLabel)")
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty, let initialIndex {
            return options[initialIndex].value?.value ?? options[initialIndex].label
        }
        if trimmed.lowercased() == "q" { throw WizardCliError.cancelled }
        if let number = Int(trimmed), (1...options.count).contains(number) {
            let option = options[number - 1]
            return option.value?.value ?? option.label
        }
        print("Invalid selection.")
    }
}

private func promptMultiSelect(_ step: WizardStep) throws -> [Any] {
    let options = parseWizardOptions(step.options)
    guard !options.isEmpty else { return [] }
    for (idx, option) in options.enumerated() {
        let hint = option.hint?.isEmpty == false ? " — \(option.hint!)" : ""
        print("  [\(idx + 1)] \(option.label)\(hint)")
    }
    let initialValues = anyCodableArray(step.initialvalue)
    let initialIndices = options.enumerated().compactMap { index, option in
        initialValues.contains { anyCodableEqual($0, option.value) } ? index + 1 : nil
    }
    let defaultLabel = initialIndices.isEmpty ? "" : " [\(initialIndices.map(String.init).joined(separator: ","))]"
    while true {
        let input = try readLineWithPrompt("Select (comma-separated)\(defaultLabel)")
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return initialIndices.map { options[$0 - 1].value?.value ?? options[$0 - 1].label }
        }
        if trimmed.lowercased() == "q" { throw WizardCliError.cancelled }
        let parts = trimmed.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let indices = parts.compactMap { Int($0) }.filter { (1...options.count).contains($0) }
        if indices.isEmpty {
            print("Invalid selection.")
            continue
        }
        return indices.map { options[$0 - 1].value?.value ?? options[$0 - 1].label }
    }
}

private func readLineWithPrompt(_ prompt: String) throws -> String {
    print("\(prompt): ", terminator: "")
    guard let line = readLine() else {
        throw WizardCliError.cancelled
    }
    return line
}
