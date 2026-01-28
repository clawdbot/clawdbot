import MoltbotKit
import MoltbotProtocol
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

func runWizardCommand(_ args: [String]) async {
    let opts = WizardCliOptions.parse(args)
    if opts.help {
        print("""
        moltbot-mac wizard

        Usage:
          moltbot-mac wizard [--url <ws://host:port>] [--token <token>] [--password <password>]
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
        return
    }

    let config = loadGatewayConfig()
    do {
        guard isatty(STDIN_FILENO) != 0 else {
            throw WizardCliError.gatewayError("Wizard requires an interactive TTY.")
        }
        let endpoint = try resolveWizardGatewayEndpoint(opts: opts, config: config)
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

private func resolveWizardGatewayEndpoint(opts: WizardCliOptions, config: GatewayConfig) throws -> GatewayEndpoint {
    if let raw = opts.url, !raw.isEmpty {
        guard let url = URL(string: raw) else { throw WizardCliError.invalidUrl(raw) }
        return GatewayEndpoint(
            url: url,
            token: resolvedToken(opts: opts, config: config),
            password: resolvedPassword(opts: opts, config: config),
            mode: (config.mode ?? "local").lowercased())
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
            password: resolvedPassword(opts: opts, config: config),
            mode: mode)
    }

    let port = config.port ?? 18789
    let host = "127.0.0.1"
    guard let url = URL(string: "ws://\(host):\(port)") else {
        throw WizardCliError.invalidUrl("ws://\(host):\(port)")
    }
    return GatewayEndpoint(
        url: url,
        token: resolvedToken(opts: opts, config: config),
        password: resolvedPassword(opts: opts, config: config),
        mode: mode)
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

actor GatewayWizardClient {
    private enum ConnectChallengeError: Error {
        case timeout
    }

    private let url: URL
    private let token: String?
    private let password: String?
    private let json: Bool
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let session = URLSession(configuration: .default)
    private let connectChallengeTimeoutSeconds: Double = 0.75
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

    func request(method: String, params: [String: ProtoAnyCodable]?) async throws -> ResponseFrame {
        guard let task = self.task else {
            throw WizardCliError.gatewayError("gateway not connected")
        }
        let id = UUID().uuidString
        let frame = RequestFrame(
            type: "req",
            id: id,
            method: method,
            params: params.map { ProtoAnyCodable($0) })
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
        let clientId = "moltbot-macos"
        let clientMode = "ui"
        let role = "operator"
        let scopes: [String] = []
        let client: [String: ProtoAnyCodable] = [
            "id": ProtoAnyCodable(clientId),
            "displayName": ProtoAnyCodable(Host.current().localizedName ?? "Moltbot macOS Wizard CLI"),
            "version": ProtoAnyCodable("dev"),
            "platform": ProtoAnyCodable(platform),
            "deviceFamily": ProtoAnyCodable("Mac"),
            "mode": ProtoAnyCodable(clientMode),
            "instanceId": ProtoAnyCodable(UUID().uuidString),
        ]

        var params: [String: ProtoAnyCodable] = [
            "minProtocol": ProtoAnyCodable(GATEWAY_PROTOCOL_VERSION),
            "maxProtocol": ProtoAnyCodable(GATEWAY_PROTOCOL_VERSION),
            "client": ProtoAnyCodable(client),
            "caps": ProtoAnyCodable([String]()),
            "locale": ProtoAnyCodable(Locale.preferredLanguages.first ?? Locale.current.identifier),
            "userAgent": ProtoAnyCodable(ProcessInfo.processInfo.operatingSystemVersionString),
            "role": ProtoAnyCodable(role),
            "scopes": ProtoAnyCodable(scopes),
        ]
        if let token = self.token {
            params["auth"] = ProtoAnyCodable(["token": ProtoAnyCodable(token)])
        } else if let password = self.password {
            params["auth"] = ProtoAnyCodable(["password": ProtoAnyCodable(password)])
        }
        let connectNonce = try await self.waitForConnectChallenge()
        let identity = DeviceIdentityStore.loadOrCreate()
        let signedAtMs = Int(Date().timeIntervalSince1970 * 1000)
        let scopesValue = scopes.joined(separator: ",")
        var payloadParts = [
            connectNonce == nil ? "v1" : "v2",
            identity.deviceId,
            clientId,
            clientMode,
            role,
            scopesValue,
            String(signedAtMs),
            self.token ?? "",
        ]
        if let connectNonce {
            payloadParts.append(connectNonce)
        }
        let payload = payloadParts.joined(separator: "|")
        if let signature = DeviceIdentityStore.signPayload(payload, identity: identity),
           let publicKey = DeviceIdentityStore.publicKeyBase64Url(identity)
        {
            var device: [String: ProtoAnyCodable] = [
                "id": ProtoAnyCodable(identity.deviceId),
                "publicKey": ProtoAnyCodable(publicKey),
                "signature": ProtoAnyCodable(signature),
                "signedAt": ProtoAnyCodable(signedAtMs),
            ]
            if let connectNonce {
                device["nonce"] = ProtoAnyCodable(connectNonce)
            }
            params["device"] = ProtoAnyCodable(device)
        }

        let reqId = UUID().uuidString
        let frame = RequestFrame(
            type: "req",
            id: reqId,
            method: "connect",
            params: ProtoAnyCodable(params))
        let data = try self.encoder.encode(frame)
        try await task.send(.data(data))

        while true {
            let message = try await task.receive()
            let frameResponse = try decodeFrame(message)
            if case let .res(res) = frameResponse, res.id == reqId {
                if res.ok == false {
                    let msg = (res.error?["message"]?.value as? String) ?? "gateway connect failed"
                    throw WizardCliError.gatewayError(msg)
                }
                _ = try self.decodePayload(res, as: HelloOk.self)
                return
            }
        }
    }

    private func waitForConnectChallenge() async throws -> String? {
        guard let task = self.task else { return nil }
        do {
            return try await AsyncTimeout.withTimeout(
                seconds: self.connectChallengeTimeoutSeconds,
                onTimeout: { ConnectChallengeError.timeout },
                operation: {
                    while true {
                        let message = try await task.receive()
                        let frame = try await self.decodeFrame(message)
                        if case let .event(evt) = frame, evt.event == "connect.challenge" {
                            if let payload = evt.payload?.value as? [String: ProtoAnyCodable],
                               let nonce = payload["nonce"]?.value as? String
                            {
                                return nonce
                            }
                        }
                    }
                })
        } catch {
            if error is ConnectChallengeError { return nil }
            throw error
        }
    }
}

private func runWizard(client: GatewayWizardClient, opts: WizardCliOptions) async throws {
    var params: [String: ProtoAnyCodable] = [:]
    let mode = opts.mode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if mode == "local" || mode == "remote" {
        params["mode"] = ProtoAnyCodable(mode)
    }
    if let workspace = opts.workspace?.trimmingCharacters(in: .whitespacesAndNewlines), !workspace.isEmpty {
        params["workspace"] = ProtoAnyCodable(workspace)
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
                var answerPayload: [String: ProtoAnyCodable] = [
                    "stepId": ProtoAnyCodable(step.id),
                ]
                if !(answer is NSNull) {
                    answerPayload["value"] = ProtoAnyCodable(answer)
                }
                let response = try await client.request(
                    method: "wizard.next",
                    params: [
                        "sessionId": ProtoAnyCodable(sessionId),
                        "answer": ProtoAnyCodable(answerPayload),
                    ])
                nextResult = try await client.decodePayload(response, as: WizardNextResult.self)
                if opts.json {
                    dumpResult(response)
                }
            } else {
                let response = try await client.request(
                    method: "wizard.next",
                    params: ["sessionId": ProtoAnyCodable(sessionId)])
                nextResult = try await client.decodePayload(response, as: WizardNextResult.self)
                if opts.json {
                    dumpResult(response)
                }
            }
        }
    } catch WizardCliError.cancelled {
        _ = try? await client.request(
            method: "wizard.cancel",
            params: ["sessionId": ProtoAnyCodable(sessionId)])
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
