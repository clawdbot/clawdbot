import ClawdisIPC
import Darwin
import Foundation

@main
struct ClawdisCLI {
    static func main() async {
        do {
            var args = Array(CommandLine.arguments.dropFirst())
            let jsonOutput = args.contains("--json")
            args.removeAll(where: { $0 == "--json" })

            if args.first == "browser" {
                let code = try await BrowserCLI.run(args: Array(args.dropFirst()), jsonOutput: jsonOutput)
                exit(code)
            }

            let parsed = try parseCommandLine(args: args)
            let response = try await send(request: parsed.request)

            if jsonOutput {
                try self.printJSON(parsed: parsed, response: response)
            } else {
                try self.printText(parsed: parsed, response: response)
            }

            exit(response.ok ? 0 : 1)
        } catch CLIError.help {
            self.printHelp()
            exit(0)
        } catch CLIError.version {
            self.printVersion()
            exit(0)
        } catch {
            // Keep errors readable for CLI + SSH callers; print full domains/codes only when asked.
            let verbose = ProcessInfo.processInfo.environment["CLAWDIS_MAC_VERBOSE_ERRORS"] == "1"
            if verbose {
                fputs("clawdis-mac error: \(error)\n", stderr)
            } else {
                let ns = error as NSError
                let message = ns.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                let desc = message.isEmpty ? String(describing: error) : message
                fputs("clawdis-mac error: \(desc) (\(ns.domain), \(ns.code))\n", stderr)
            }
            exit(2)
        }
    }

    private struct ParsedCLIRequest {
        var request: Request
        var kind: Kind
        var verbose: Bool = false

        enum Kind {
            case generic
            case mediaPath
        }
    }

    private static func parseCommandLine(args: [String]) throws -> ParsedCLIRequest {
        var args = args
        guard !args.isEmpty else { throw CLIError.help }
        let command = args.removeFirst()

        switch command {
        case "--help", "-h", "help":
            throw CLIError.help

        case "--version", "-V", "version":
            throw CLIError.version

        case "notify":
            return try self.parseNotify(args: &args)

        case "ensure-permissions":
            return self.parseEnsurePermissions(args: &args)

        case "run":
            return self.parseRunShell(args: &args)

        case "status":
            return ParsedCLIRequest(request: .status, kind: .generic)

        case "rpc-status":
            return ParsedCLIRequest(request: .rpcStatus, kind: .generic)

        case "agent":
            return try self.parseAgent(args: &args)

        case "node":
            return try self.parseNode(args: &args)

        case "canvas":
            return try self.parseCanvas(args: &args)

        case "camera":
            return try self.parseCamera(args: &args)

        default:
            throw CLIError.help
        }
    }

    private static func parseNotify(args: inout [String]) throws -> ParsedCLIRequest {
        var title: String?
        var body: String?
        var sound: String?
        var priority: NotificationPriority?
        var delivery: NotificationDelivery?
        while !args.isEmpty {
            let arg = args.removeFirst()
            switch arg {
            case "--title": title = args.popFirst()
            case "--body": body = args.popFirst()
            case "--sound": sound = args.popFirst()
            case "--priority":
                if let val = args.popFirst(), let p = NotificationPriority(rawValue: val) { priority = p }
            case "--delivery":
                if let val = args.popFirst(), let d = NotificationDelivery(rawValue: val) { delivery = d }
            default: break
            }
        }
        guard let t = title, let b = body else { throw CLIError.help }
        return ParsedCLIRequest(
            request: .notify(title: t, body: b, sound: sound, priority: priority, delivery: delivery),
            kind: .generic)
    }

    private static func parseEnsurePermissions(args: inout [String]) -> ParsedCLIRequest {
        var caps: [Capability] = []
        var interactive = false
        while !args.isEmpty {
            let arg = args.removeFirst()
            switch arg {
            case "--cap":
                if let val = args.popFirst(), let cap = Capability(rawValue: val) { caps.append(cap) }
            case "--interactive":
                interactive = true
            default:
                break
            }
        }
        if caps.isEmpty { caps = Capability.allCases }
        return ParsedCLIRequest(request: .ensurePermissions(caps, interactive: interactive), kind: .generic)
    }

    private static func parseRunShell(args: inout [String]) -> ParsedCLIRequest {
        var cwd: String?
        var env: [String: String] = [:]
        var timeout: Double?
        var needsSR = false
        var cmd: [String] = []
        while !args.isEmpty {
            let arg = args.removeFirst()
            switch arg {
            case "--cwd":
                cwd = args.popFirst()
            case "--env":
                if let pair = args.popFirst() {
                    self.parseEnvPair(pair, into: &env)
                }
            case "--timeout":
                if let val = args.popFirst(), let dbl = Double(val) { timeout = dbl }
            case "--needs-screen-recording":
                needsSR = true
            default:
                cmd.append(arg)
            }
        }
        return ParsedCLIRequest(
            request: .runShell(
                command: cmd,
                cwd: cwd,
                env: env.isEmpty ? nil : env,
                timeoutSec: timeout,
                needsScreenRecording: needsSR),
            kind: .generic)
    }

    private static func parseEnvPair(_ pair: String, into env: inout [String: String]) {
        guard let eq = pair.firstIndex(of: "=") else { return }
        let key = String(pair[..<eq])
        let value = String(pair[pair.index(after: eq)...])
        env[key] = value
    }

    private static func parseAgent(args: inout [String]) throws -> ParsedCLIRequest {
        var message: String?
        var thinking: String?
        var session: String?
        var deliver = false
        var to: String?

        while !args.isEmpty {
            let arg = args.removeFirst()
            switch arg {
            case "--message": message = args.popFirst()
            case "--thinking": thinking = args.popFirst()
            case "--session": session = args.popFirst()
            case "--deliver": deliver = true
            case "--to": to = args.popFirst()
            default:
                if message == nil {
                    message = arg
                }
            }
        }

        guard let message else { throw CLIError.help }
        return ParsedCLIRequest(
            request: .agent(message: message, thinking: thinking, session: session, deliver: deliver, to: to),
            kind: .generic)
    }

    private static func parseNode(args: inout [String]) throws -> ParsedCLIRequest {
        guard let sub = args.popFirst() else { throw CLIError.help }
        switch sub {
        case "list":
            var verbose = false
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--verbose":
                    verbose = true
                default:
                    break
                }
            }
            return ParsedCLIRequest(request: .nodeList, kind: .generic, verbose: verbose)

        case "describe":
            var nodeId: String?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--node":
                    nodeId = args.popFirst()
                default:
                    if nodeId == nil { nodeId = arg }
                }
            }
            guard let nodeId else { throw CLIError.help }
            return ParsedCLIRequest(request: .nodeDescribe(nodeId: nodeId), kind: .generic)

        case "invoke":
            var nodeId: String?
            var command: String?
            var paramsJSON: String?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--node": nodeId = args.popFirst()
                case "--command": command = args.popFirst()
                case "--params-json": paramsJSON = args.popFirst()
                default: break
                }
            }
            guard let nodeId, let command else { throw CLIError.help }
            return ParsedCLIRequest(
                request: .nodeInvoke(nodeId: nodeId, command: command, paramsJSON: paramsJSON),
                kind: .generic)
        default:
            throw CLIError.help
        }
    }

    private static func parseCanvas(args: inout [String]) throws -> ParsedCLIRequest {
        guard let sub = args.popFirst() else { throw CLIError.help }
        switch sub {
        case "show":
            var session = "main"
            var target: String?
            let placement = self.parseCanvasPlacement(args: &args, session: &session, target: &target)
            return ParsedCLIRequest(
                request: .canvasShow(session: session, path: target, placement: placement),
                kind: .generic)
        case "a2ui":
            return try self.parseCanvasA2UI(args: &args)
        case "hide":
            var session = "main"
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--session": session = args.popFirst() ?? session
                default: break
                }
            }
            return ParsedCLIRequest(request: .canvasHide(session: session), kind: .generic)
        case "eval":
            var session = "main"
            var js: String?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--session": session = args.popFirst() ?? session
                case "--js": js = args.popFirst()
                default: break
                }
            }
            guard let js else { throw CLIError.help }
            return ParsedCLIRequest(request: .canvasEval(session: session, javaScript: js), kind: .generic)
        case "snapshot":
            var session = "main"
            var outPath: String?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--session": session = args.popFirst() ?? session
                case "--out": outPath = args.popFirst()
                default: break
                }
            }
            return ParsedCLIRequest(request: .canvasSnapshot(session: session, outPath: outPath), kind: .generic)
        default:
            throw CLIError.help
        }
    }

    private static func parseCanvasA2UI(args: inout [String]) throws -> ParsedCLIRequest {
        guard let sub = args.popFirst() else { throw CLIError.help }
        switch sub {
        case "push":
            var session = "main"
            var jsonlPath: String?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--session": session = args.popFirst() ?? session
                case "--jsonl": jsonlPath = args.popFirst()
                default: break
                }
            }
            guard let jsonlPath else { throw CLIError.help }
            let jsonl = try String(contentsOfFile: jsonlPath, encoding: .utf8)
            return ParsedCLIRequest(
                request: .canvasA2UI(session: session, command: .pushJSONL, jsonl: jsonl),
                kind: .generic)

        case "reset":
            var session = "main"
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--session": session = args.popFirst() ?? session
                default: break
                }
            }
            return ParsedCLIRequest(
                request: .canvasA2UI(session: session, command: .reset, jsonl: nil),
                kind: .generic)

        default:
            throw CLIError.help
        }
    }

    private static func parseCamera(args: inout [String]) throws -> ParsedCLIRequest {
        guard let sub = args.popFirst() else { throw CLIError.help }
        switch sub {
        case "snap":
            var facing: CameraFacing?
            var maxWidth: Int?
            var quality: Double?
            var outPath: String?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--facing":
                    if let val = args.popFirst(), let f = CameraFacing(rawValue: val) { facing = f }
                case "--max-width":
                    maxWidth = args.popFirst().flatMap(Int.init)
                case "--quality":
                    quality = args.popFirst().flatMap(Double.init)
                case "--out":
                    outPath = args.popFirst()
                default:
                    break
                }
            }
            return ParsedCLIRequest(
                request: .cameraSnap(facing: facing, maxWidth: maxWidth, quality: quality, outPath: outPath),
                kind: .mediaPath)

        case "clip":
            var facing: CameraFacing?
            var durationMs: Int?
            var includeAudio = true
            var outPath: String?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--facing":
                    if let val = args.popFirst(), let f = CameraFacing(rawValue: val) { facing = f }
                case "--duration-ms":
                    durationMs = args.popFirst().flatMap(Int.init)
                case "--no-audio":
                    includeAudio = false
                case "--out":
                    outPath = args.popFirst()
                default:
                    break
                }
            }
            return ParsedCLIRequest(
                request: .cameraClip(
                    facing: facing,
                    durationMs: durationMs,
                    includeAudio: includeAudio,
                    outPath: outPath),
                kind: .mediaPath)

        default:
            throw CLIError.help
        }
    }

    private static func parseCanvasPlacement(
        args: inout [String],
        session: inout String,
        target: inout String?) -> CanvasPlacement?
    {
        var x: Double?
        var y: Double?
        var width: Double?
        var height: Double?
        while !args.isEmpty {
            let arg = args.removeFirst()
            switch arg {
            case "--session": session = args.popFirst() ?? session
            case "--target", "--path": target = args.popFirst()
            case "--x": x = args.popFirst().flatMap(Double.init)
            case "--y": y = args.popFirst().flatMap(Double.init)
            case "--width": width = args.popFirst().flatMap(Double.init)
            case "--height": height = args.popFirst().flatMap(Double.init)
            default: break
            }
        }
        if x == nil, y == nil, width == nil, height == nil { return nil }
        return CanvasPlacement(x: x, y: y, width: width, height: height)
    }

    private static func printText(parsed: ParsedCLIRequest, response: Response) throws {
        guard response.ok else {
            let msg = response.message ?? "failed"
            fputs("\(msg)\n", stderr)
            return
        }

        if case .canvasShow = parsed.request {
            if let message = response.message, !message.isEmpty {
                FileHandle.standardOutput.write(Data((message + "\n").utf8))
            }
            if let payload = response.payload, let info = try? JSONDecoder().decode(CanvasShowResult.self, from: payload) {
                FileHandle.standardOutput.write(Data(("STATUS:\(info.status.rawValue)\n").utf8))
                if let url = info.url, !url.isEmpty {
                    FileHandle.standardOutput.write(Data(("URL:\(url)\n").utf8))
                }
            }
            return
        }

        if case .nodeList = parsed.request, let payload = response.payload {
            struct NodeListResult: Decodable {
                struct Node: Decodable {
                    var nodeId: String
                    var displayName: String?
                    var platform: String?
                    var version: String?
                    var deviceFamily: String?
                    var modelIdentifier: String?
                    var remoteAddress: String?
                    var connected: Bool
                    var paired: Bool?
                    var capabilities: [String]?
                    var commands: [String]?
                }

                var pairedNodeIds: [String]?
                var connectedNodeIds: [String]?
                var nodes: [Node]
            }

            if let decoded = try? JSONDecoder().decode(NodeListResult.self, from: payload) {
                let pairedCount = decoded.pairedNodeIds?.count ?? decoded.nodes.count
                let connectedCount = decoded.connectedNodeIds?.count ?? decoded.nodes.filter(\.connected).count
                print("Paired: \(pairedCount) · Connected: \(connectedCount)")

                for n in decoded.nodes {
                    let nameTrimmed = n.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let name = nameTrimmed.isEmpty ? n.nodeId : nameTrimmed

                    let ipTrimmed = n.remoteAddress?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let ip = ipTrimmed.isEmpty ? nil : ipTrimmed

                    let familyTrimmed = n.deviceFamily?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let family = familyTrimmed.isEmpty ? nil : familyTrimmed
                    let modelTrimmed = n.modelIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let model = modelTrimmed.isEmpty ? nil : modelTrimmed

                    let caps = n.capabilities?.sorted().joined(separator: ",")
                    let capsText = caps.map { "[\($0)]" } ?? "?"

                    var parts: [String] = ["- \(name)", n.nodeId]
                    if let ip { parts.append(ip) }
                    if let family { parts.append("device: \(family)") }
                    if let model { parts.append("hw: \(model)") }
                    let paired = n.paired ?? true
                    parts.append(paired ? "paired" : "unpaired")
                    parts.append(n.connected ? "connected" : "disconnected")
                    parts.append("caps: \(capsText)")
                    print(parts.joined(separator: " · "))

                    if parsed.verbose {
                        let platform = (n.platform ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        let version = (n.version ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        if !platform.isEmpty || !version.isEmpty {
                            let pv = [platform.isEmpty ? nil : platform, version.isEmpty ? nil : version]
                                .compactMap { $0 }
                                .joined(separator: " ")
                            if !pv.isEmpty { print("  platform: \(pv)") }
                        }

                        let commands = n.commands?.sorted() ?? []
                        if !commands.isEmpty {
                            print("  commands: \(commands.joined(separator: ", "))")
                        }
                    }
                }
                return
            }
        }

        if case .nodeDescribe = parsed.request, let payload = response.payload {
            struct NodeDescribeResult: Decodable {
                var nodeId: String
                var displayName: String?
                var platform: String?
                var version: String?
                var deviceFamily: String?
                var modelIdentifier: String?
                var remoteIp: String?
                var caps: [String]?
                var commands: [String]?
                var paired: Bool?
                var connected: Bool?
            }

            if let decoded = try? JSONDecoder().decode(NodeDescribeResult.self, from: payload) {
                let nameTrimmed = decoded.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let name = nameTrimmed.isEmpty ? decoded.nodeId : nameTrimmed

                let ipTrimmed = decoded.remoteIp?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let ip = ipTrimmed.isEmpty ? nil : ipTrimmed

                let familyTrimmed = decoded.deviceFamily?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let family = familyTrimmed.isEmpty ? nil : familyTrimmed
                let modelTrimmed = decoded.modelIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let model = modelTrimmed.isEmpty ? nil : modelTrimmed

                let caps = decoded.caps?.sorted().joined(separator: ",")
                let capsText = caps.map { "[\($0)]" } ?? "?"
                let commands = decoded.commands?.sorted() ?? []

                var parts: [String] = ["Node:", name, decoded.nodeId]
                if let ip { parts.append(ip) }
                if let family { parts.append("device: \(family)") }
                if let model { parts.append("hw: \(model)") }
                if let paired = decoded.paired { parts.append(paired ? "paired" : "unpaired") }
                if let connected = decoded.connected { parts.append(connected ? "connected" : "disconnected") }
                parts.append("caps: \(capsText)")
                print(parts.joined(separator: " · "))
                if !commands.isEmpty {
                    print("Commands:")
                    for c in commands { print("- \(c)") }
                }
                return
            }
        }

        switch parsed.kind {
        case .generic:
            if let payload = response.payload, let text = String(data: payload, encoding: .utf8), !text.isEmpty {
                FileHandle.standardOutput.write(payload)
                if !text.hasSuffix("\n") { FileHandle.standardOutput.write(Data([0x0A])) }
                return
            }
            if let message = response.message, !message.isEmpty {
                FileHandle.standardOutput.write(Data((message + "\n").utf8))
            }
        case .mediaPath:
            if let message = response.message, !message.isEmpty {
                print("MEDIA:\(message)")
            }
        }
    }

    private static func printJSON(parsed: ParsedCLIRequest, response: Response) throws {
        var output: [String: Any] = [
            "ok": response.ok,
            "message": response.message ?? "",
        ]

        switch parsed.kind {
        case .generic:
            if let payload = response.payload, !payload.isEmpty {
                if let obj = try? JSONSerialization.jsonObject(with: payload) {
                    output["result"] = obj
                } else if let text = String(data: payload, encoding: .utf8) {
                    output["payload"] = text
                }
            }
        case .mediaPath:
            break
        }

        let json = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted])
        FileHandle.standardOutput.write(json)
        FileHandle.standardOutput.write(Data([0x0A]))
    }

    private static func decodePayload<T: Decodable>(_ type: T.Type, payload: Data?) throws -> T {
        guard let payload else { throw POSIXError(.EINVAL) }
        return try JSONDecoder().decode(T.self, from: payload)
    }

    private static func printHelp() {
        let usage = """
        clawdis-mac — talk to the running Clawdis.app (local control socket)

        Usage:
          clawdis-mac [--json] <command> ...

        Commands:
          Notifications:
            clawdis-mac notify --title <t> --body <b> [--sound <name>]
              [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>]

          Permissions:
            clawdis-mac ensure-permissions
              [--cap <notifications|accessibility|screenRecording|microphone|speechRecognition>]
              [--interactive]

          Shell:
            clawdis-mac run [--cwd <path>] [--env KEY=VAL] [--timeout <sec>]
              [--needs-screen-recording] <command ...>

          Status:
            clawdis-mac status
            clawdis-mac rpc-status

          Agent:
            clawdis-mac agent --message <text> [--thinking <low|default|high>]
              [--session <key>] [--deliver] [--to <E.164>]

          Nodes:
            clawdis-mac node list [--verbose]         # paired + connected nodes (+ capabilities when available)
            clawdis-mac node describe --node <id>
            clawdis-mac node invoke --node <id> --command <name> [--params-json <json>]

          Canvas:
            clawdis-mac canvas show [--session <key>] [--target </...|https://...|file://...>]
              [--x <screenX> --y <screenY>] [--width <w> --height <h>]
            clawdis-mac canvas a2ui push --jsonl <path> [--session <key>]   # A2UI v0.8 JSONL
            clawdis-mac canvas a2ui reset [--session <key>]
            clawdis-mac canvas hide [--session <key>]
            clawdis-mac canvas eval --js <code> [--session <key>]
            clawdis-mac canvas snapshot [--out <path>] [--session <key>]

          Camera:
            clawdis-mac camera snap [--facing <front|back>] [--max-width <px>] [--quality <0-1>] [--out <path>]
            clawdis-mac camera clip [--facing <front|back>] [--duration-ms <ms>] [--no-audio] [--out <path>]

          Browser (clawd):
            clawdis-mac browser status|start|stop|tabs|open|focus|close|screenshot|eval|query|dom|snapshot

        UI Automation (Peekaboo):
          Install and use the `peekaboo` CLI; it will connect to Peekaboo.app (preferred) or Clawdis.app
          (fallback) via PeekabooBridge. See `docs/mac/peekaboo.md`.

        Browser notes:
          - Uses clawd’s dedicated Chrome/Chromium profile (separate user-data dir).
          - Talks to the gateway’s loopback browser-control server (config: ~/.clawdis/clawdis.json).
          - Keys: browser.enabled, browser.controlUrl (default: http://127.0.0.1:18791).

        Examples:
          clawdis-mac status
          clawdis-mac agent --message "Hello from clawd" --thinking low
          clawdis-mac browser start
          clawdis-mac browser open https://example.com
          clawdis-mac browser tabs
          clawdis-mac browser screenshot --full-page
          clawdis-mac browser eval \"location.href\"
          clawdis-mac browser query \"a\" --limit 5
          clawdis-mac browser dom --format text --max-chars 5000
          clawdis-mac browser snapshot --format aria --limit 200

        Output:
          Default output is text. Use --json for machine-readable output.
          In text mode, `browser screenshot` prints MEDIA:<path>.
          In text mode, `camera snap` and `camera clip` print MEDIA:<path>.
        """
        print(usage)
    }

    private static func printVersion() {
        let info = self.loadInfo()
        let version = (info["CFBundleShortVersionString"] as? String) ?? self.loadPackageJSONVersion() ?? "unknown"
        var build = info["CFBundleVersion"] as? String ?? ""
        if build.isEmpty, version != "unknown" {
            build = version
        }
        let git = info["ClawdisGitCommit"] as? String ?? "unknown"
        let ts = info["ClawdisBuildTimestamp"] as? String ?? "unknown"

        let buildPart = build.isEmpty ? "" : " (\(build))"
        print("clawdis-mac \(version)\(buildPart) git:\(git) built:\(ts)")
    }

    private static func loadInfo() -> [String: Any] {
        if let dict = Bundle.main.infoDictionary, !dict.isEmpty { return dict }

        guard let exeURL = self.resolveExecutableURL() else { return [:] }

        var dir = exeURL.deletingLastPathComponent()
        for _ in 0..<10 {
            let candidate = dir.appendingPathComponent("Info.plist")
            if let dict = self.loadPlistDictionary(at: candidate) {
                return dict
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }

        return [:]
    }

    private static func loadPlistDictionary(at url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? PropertyListSerialization
            .propertyList(from: data, options: [], format: nil) as? [String: Any]
    }

    private static func resolveExecutableURL() -> URL? {
        var size = UInt32(PATH_MAX)
        var buffer = [CChar](repeating: 0, count: Int(size))

        let result = buffer.withUnsafeMutableBufferPointer { ptr in
            _NSGetExecutablePath(ptr.baseAddress, &size)
        }

        if result != 0 {
            buffer = [CChar](repeating: 0, count: Int(size))
            let result2 = buffer.withUnsafeMutableBufferPointer { ptr in
                _NSGetExecutablePath(ptr.baseAddress, &size)
            }
            guard result2 == 0 else { return nil }
        }

        let nulIndex = buffer.firstIndex(of: 0) ?? buffer.count
        let bytes = buffer.prefix(nulIndex).map { UInt8(bitPattern: $0) }
        guard let path = String(bytes: bytes, encoding: .utf8) else { return nil }
        return URL(fileURLWithPath: path).resolvingSymlinksInPath()
    }

    private static func loadPackageJSONVersion() -> String? {
        guard let exeURL = self.resolveExecutableURL() else { return nil }

        var dir = exeURL.deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("package.json")
            if let version = self.loadPackageJSONVersion(at: candidate) {
                return version
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }

        return nil
    }

    private static func loadPackageJSONVersion(at url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        guard obj["name"] as? String == "clawdis" else { return nil }
        return obj["version"] as? String
    }

    private static func send(request: Request) async throws -> Response {
        try await self.ensureAppRunning()

        let timeout = self.rpcTimeoutSeconds(for: request)
        return try await self.sendViaSocket(request: request, timeoutSeconds: timeout)
    }

    /// Attempt a direct UNIX socket call; falls back to XPC if unavailable.
    private static func sendViaSocket(request: Request, timeoutSeconds: TimeInterval) async throws -> Response {
        let path = controlSocketPath
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.ECONNREFUSED) }
        defer { close(fd) }

        var noSigPipe: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout.size(ofValue: noSigPipe)))

        let flags = fcntl(fd, F_GETFL)
        if flags != -1 {
            _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        let copied = path.withCString { cstr -> Int in
            strlcpy(&addr.sun_path.0, cstr, capacity)
        }
        guard copied < capacity else { throw POSIXError(.ENAMETOOLONG) }
        addr.sun_len = UInt8(MemoryLayout.size(ofValue: addr))
        let len = socklen_t(MemoryLayout.size(ofValue: addr))
        let result = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(fd, sockPtr, len)
            }
        }
        if result != 0 {
            let err = errno
            if err == EINPROGRESS {
                try self.waitForSocket(
                    fd: fd,
                    events: Int16(POLLOUT),
                    until: deadline,
                    timeoutSeconds: timeoutSeconds)
                var soError: Int32 = 0
                var soLen = socklen_t(MemoryLayout.size(ofValue: soError))
                _ = getsockopt(fd, SOL_SOCKET, SO_ERROR, &soError, &soLen)
                if soError != 0 { throw POSIXError(POSIXErrorCode(rawValue: soError) ?? .ECONNREFUSED) }
            } else {
                throw POSIXError(POSIXErrorCode(rawValue: err) ?? .ECONNREFUSED)
            }
        }

        let payload = try JSONEncoder().encode(request)
        try payload.withUnsafeBytes { buf in
            guard let base = buf.baseAddress else { return }
            var written = 0
            while written < payload.count {
                try self.ensureDeadline(deadline, timeoutSeconds: timeoutSeconds)
                let n = write(fd, base.advanced(by: written), payload.count - written)
                if n > 0 {
                    written += n
                    continue
                }
                if n == -1, errno == EINTR { continue }
                if n == -1, errno == EAGAIN {
                    try self.waitForSocket(
                        fd: fd,
                        events: Int16(POLLOUT),
                        until: deadline,
                        timeoutSeconds: timeoutSeconds)
                    continue
                }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        }
        shutdown(fd, SHUT_WR)

        var data = Data()
        let decoder = JSONDecoder()
        var buffer = [UInt8](repeating: 0, count: 8192)
        let bufSize = buffer.count
        while true {
            try self.ensureDeadline(deadline, timeoutSeconds: timeoutSeconds)
            try self.waitForSocket(
                fd: fd,
                events: Int16(POLLIN),
                until: deadline,
                timeoutSeconds: timeoutSeconds)
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress!, bufSize) }
            if n > 0 {
                data.append(buffer, count: n)
                if let resp = try? decoder.decode(Response.self, from: data) {
                    return resp
                }
                continue
            }
            if n == 0 { break }
            if n == -1, errno == EINTR { continue }
            if n == -1, errno == EAGAIN { continue }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard !data.isEmpty else { throw POSIXError(.ECONNRESET) }
        return try decoder.decode(Response.self, from: data)
    }

    private static func rpcTimeoutSeconds(for request: Request) -> TimeInterval {
        switch request {
        case let .runShell(_, _, _, timeoutSec, _):
            // Allow longer for commands; still cap overall to a sane bound.
            min(300, max(10, (timeoutSec ?? 10) + 2))
        default:
            // Fail-fast so callers (incl. SSH tool calls) don't hang forever.
            10
        }
    }

    private static func ensureDeadline(_ deadline: Date, timeoutSeconds: TimeInterval) throws {
        if Date() >= deadline {
            throw CLITimeoutError(seconds: timeoutSeconds)
        }
    }

    private static func waitForSocket(
        fd: Int32,
        events: Int16,
        until deadline: Date,
        timeoutSeconds: TimeInterval) throws
    {
        while true {
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 { throw CLITimeoutError(seconds: timeoutSeconds) }
            var pfd = pollfd(fd: fd, events: events, revents: 0)
            let ms = Int32(max(1, min(remaining, 0.5) * 1000)) // small slices so we enforce total timeout
            let n = poll(&pfd, 1, ms)
            if n > 0 { return }
            if n == 0 { continue }
            if errno == EINTR { continue }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    private static func ensureAppRunning() async throws {
        let appURL = URL(fileURLWithPath: CommandLine.arguments.first ?? "")
            .resolvingSymlinksInPath()
            .deletingLastPathComponent() // MacOS
            .deletingLastPathComponent() // Contents
        let proc = Process()
        proc.launchPath = "/usr/bin/open"
        proc.arguments = ["-n", appURL.path]
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try proc.run()
        try? await Task.sleep(nanoseconds: 100_000_000)
    }
}

enum CLIError: Error { case help, version }

struct CLITimeoutError: Error, CustomStringConvertible {
    let seconds: TimeInterval
    var description: String {
        let rounded = Int(max(1, seconds.rounded(.toNearestOrEven)))
        return "timed out after \(rounded)s"
    }
}

extension [String] {
    mutating func popFirst() -> String? {
        guard let first else { return nil }
        self = Array(self.dropFirst())
        return first
    }
}
