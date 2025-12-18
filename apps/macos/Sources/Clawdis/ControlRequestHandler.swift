import ClawdisIPC
import Foundation
import OSLog

enum ControlRequestHandler {
    private static let cameraCapture = CameraCaptureService()

    struct NodeListNode: Codable {
        var nodeId: String
        var displayName: String?
        var platform: String?
        var version: String?
        var deviceFamily: String?
        var modelIdentifier: String?
        var remoteAddress: String?
        var connected: Bool
        var paired: Bool
        var capabilities: [String]?
        var commands: [String]?
    }

    struct NodeListResult: Codable {
        var ts: Int
        var connectedNodeIds: [String]
        var pairedNodeIds: [String]
        var nodes: [NodeListNode]
    }

    struct GatewayNodeListPayload: Decodable {
        struct Node: Decodable {
            var nodeId: String
            var displayName: String?
            var platform: String?
            var version: String?
            var deviceFamily: String?
            var modelIdentifier: String?
            var remoteIp: String?
            var connected: Bool?
            var paired: Bool?
            var caps: [String]?
            var commands: [String]?
        }

        var ts: Int?
        var nodes: [Node]
    }

    static func process(
        request: Request,
        notifier: NotificationManager = NotificationManager(),
        logger: Logger = Logger(subsystem: "com.steipete.clawdis", category: "control")) async throws -> Response
    {
        // Keep `status` responsive even if the main actor is busy.
        let paused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        if paused, case .status = request {
            // allow status through
        } else if paused {
            return Response(ok: false, message: "clawdis paused")
        }

        switch request {
        case let .notify(title, body, sound, priority, delivery):
            let notify = NotifyRequest(
                title: title,
                body: body,
                sound: sound,
                priority: priority,
                delivery: delivery)
            return await self.handleNotify(notify, notifier: notifier)

        case let .ensurePermissions(caps, interactive):
            return await self.handleEnsurePermissions(caps: caps, interactive: interactive)

        case .status:
            return paused
                ? Response(ok: false, message: "clawdis paused")
                : Response(ok: true, message: "ready")

        case .rpcStatus:
            return await self.handleRPCStatus()

        case let .runShell(command, cwd, env, timeoutSec, needsSR):
            return await self.handleRunShell(
                command: command,
                cwd: cwd,
                env: env,
                timeoutSec: timeoutSec,
                needsSR: needsSR)

        case let .agent(message, thinking, session, deliver, to):
            return await self.handleAgent(
                message: message,
                thinking: thinking,
                session: session,
                deliver: deliver,
                to: to)

        case let .canvasShow(session, path, placement):
            return await self.handleCanvasShow(session: session, path: path, placement: placement)

        case let .canvasHide(session):
            return await self.handleCanvasHide(session: session)

        case let .canvasEval(session, javaScript):
            return await self.handleCanvasEval(session: session, javaScript: javaScript)

        case let .canvasSnapshot(session, outPath):
            return await self.handleCanvasSnapshot(session: session, outPath: outPath)

        case let .canvasA2UI(session, command, jsonl):
            return await self.handleCanvasA2UI(session: session, command: command, jsonl: jsonl)

        case .nodeList:
            return await self.handleNodeList()

        case let .nodeDescribe(nodeId):
            return await self.handleNodeDescribe(nodeId: nodeId)

        case let .nodeInvoke(nodeId, command, paramsJSON):
            return await self.handleNodeInvoke(
                nodeId: nodeId,
                command: command,
                paramsJSON: paramsJSON,
                logger: logger)

        case let .cameraSnap(facing, maxWidth, quality, outPath):
            return await self.handleCameraSnap(facing: facing, maxWidth: maxWidth, quality: quality, outPath: outPath)

        case let .cameraClip(facing, durationMs, includeAudio, outPath):
            return await self.handleCameraClip(
                facing: facing,
                durationMs: durationMs,
                includeAudio: includeAudio,
                outPath: outPath)
        }
    }

    private struct NotifyRequest {
        var title: String
        var body: String
        var sound: String?
        var priority: NotificationPriority?
        var delivery: NotificationDelivery?
    }

    private static func handleNotify(_ request: NotifyRequest, notifier: NotificationManager) async -> Response {
        let chosenSound = request.sound?.trimmingCharacters(in: .whitespacesAndNewlines)
        let chosenDelivery = request.delivery ?? .system

        switch chosenDelivery {
        case .system:
            let ok = await notifier.send(
                title: request.title,
                body: request.body,
                sound: chosenSound,
                priority: request.priority)
            return ok ? Response(ok: true) : Response(ok: false, message: "notification not authorized")
        case .overlay:
            await NotifyOverlayController.shared.present(title: request.title, body: request.body)
            return Response(ok: true)
        case .auto:
            let ok = await notifier.send(
                title: request.title,
                body: request.body,
                sound: chosenSound,
                priority: request.priority)
            if ok { return Response(ok: true) }
            await NotifyOverlayController.shared.present(title: request.title, body: request.body)
            return Response(ok: true, message: "notification not authorized; used overlay")
        }
    }

    private static func handleEnsurePermissions(caps: [Capability], interactive: Bool) async -> Response {
        let statuses = await PermissionManager.ensure(caps, interactive: interactive)
        let missing = statuses.filter { !$0.value }.map(\.key.rawValue)
        let ok = missing.isEmpty
        let msg = ok ? "all granted" : "missing: \(missing.joined(separator: ","))"
        return Response(ok: ok, message: msg)
    }

    private static func handleRPCStatus() async -> Response {
        let result = await GatewayConnection.shared.status()
        return Response(ok: result.ok, message: result.error)
    }

    private static func handleRunShell(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeoutSec: Double?,
        needsSR: Bool) async -> Response
    {
        if needsSR {
            let authorized = await PermissionManager
                .ensure([.screenRecording], interactive: false)[.screenRecording] ?? false
            guard authorized else { return Response(ok: false, message: "screen recording permission missing") }
        }
        return await ShellExecutor.run(command: command, cwd: cwd, env: env, timeout: timeoutSec)
    }

    private static func handleAgent(
        message: String,
        thinking: String?,
        session: String?,
        deliver: Bool,
        to: String?) async -> Response
    {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Response(ok: false, message: "message empty") }
        let sessionKey = session ?? "main"
        let invocation = GatewayAgentInvocation(
            message: trimmed,
            sessionKey: sessionKey,
            thinking: thinking,
            deliver: deliver,
            to: to,
            channel: .last)
        let rpcResult = await GatewayConnection.shared.sendAgent(invocation)
        return rpcResult.ok ? Response(ok: true, message: "sent") : Response(ok: false, message: rpcResult.error)
    }

    private static func canvasEnabled() -> Bool {
        UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
    }

    private static func cameraEnabled() -> Bool {
        UserDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? true
    }

    private static func handleCanvasShow(
        session: String,
        path: String?,
        placement: CanvasPlacement?) async -> Response
    {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        let logger = Logger(subsystem: "com.steipete.clawdis", category: "CanvasControl")
        logger.info("canvas show start session=\(session, privacy: .public) path=\(path ?? "", privacy: .public)")
        do {
            logger.info("canvas show awaiting CanvasManager")
            let res = try await CanvasManager.shared.showDetailed(sessionKey: session, target: path, placement: placement)
            logger.info("canvas show done dir=\(res.directory, privacy: .public) status=\(String(describing: res.status), privacy: .public)")
            let payload = try? JSONEncoder().encode(res)
            return Response(ok: true, message: res.directory, payload: payload)
        } catch {
            logger.error("canvas show failed \(error.localizedDescription, privacy: .public)")
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasHide(session: String) async -> Response {
        await CanvasManager.shared.hide(sessionKey: session)
        return Response(ok: true)
    }

    private static func handleCanvasEval(session: String, javaScript: String) async -> Response {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        let logger = Logger(subsystem: "com.steipete.clawdis", category: "CanvasControl")
        logger.info("canvas eval start session=\(session, privacy: .public) bytes=\(javaScript.utf8.count)")
        do {
            logger.info("canvas eval awaiting CanvasManager.eval")
            let result = try await CanvasManager.shared.eval(sessionKey: session, javaScript: javaScript)
            logger.info("canvas eval done bytes=\(result.utf8.count)")
            return Response(ok: true, payload: Data(result.utf8))
        } catch {
            logger.error("canvas eval failed \(error.localizedDescription, privacy: .public)")
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasSnapshot(session: String, outPath: String?) async -> Response {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        do {
            let path = try await CanvasManager.shared.snapshot(sessionKey: session, outPath: outPath)
            return Response(ok: true, message: path)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCanvasA2UI(session: String, command: CanvasA2UICommand, jsonl: String?) async -> Response {
        guard self.canvasEnabled() else { return Response(ok: false, message: "Canvas disabled by user") }
        do {
            // Ensure the Canvas is visible without forcing a navigation/reload.
            _ = try await CanvasManager.shared.show(sessionKey: session, path: nil)

            // Wait for the in-page A2UI bridge. If it doesn't appear, force-load the bundled A2UI shell once.
            var ready = await Self.waitForCanvasA2UI(session: session, requireBuiltinPath: false, timeoutMs: 2_000)
            if !ready {
                _ = try await CanvasManager.shared.show(sessionKey: session, path: "/__clawdis__/a2ui/")
                ready = await Self.waitForCanvasA2UI(session: session, requireBuiltinPath: true, timeoutMs: 5_000)
            }

            guard ready else { return Response(ok: false, message: "A2UI not ready") }

            let js: String
            switch command {
            case .reset:
                js = """
                (() => {
                  try {
                    if (!globalThis.clawdisA2UI) { return JSON.stringify({ ok: false, error: "missing clawdisA2UI" }); }
                    return JSON.stringify(globalThis.clawdisA2UI.reset());
                  } catch (e) {
                    return JSON.stringify({ ok: false, error: String(e?.message ?? e), stack: e?.stack });
                  }
                })()
                """

            case .pushJSONL:
                guard let jsonl, !jsonl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return Response(ok: false, message: "missing jsonl")
                }
                let items: [ParsedJSONLItem]
                do {
                    items = try Self.parseJSONL(jsonl)
                } catch {
                    return Response(ok: false, message: "invalid jsonl: \(error.localizedDescription)")
                }

                do {
                    try Self.validateA2UIV0_8(items)
                } catch {
                    return Response(ok: false, message: error.localizedDescription)
                }

                let messages = items.map(\.value)
                let data = try JSONSerialization.data(withJSONObject: messages, options: [])
                let json = String(data: data, encoding: .utf8) ?? "[]"
                js = """
                (() => {
                  try {
                    if (!globalThis.clawdisA2UI) { return JSON.stringify({ ok: false, error: "missing clawdisA2UI" }); }
                    const messages = \(json);
                    return JSON.stringify(globalThis.clawdisA2UI.applyMessages(messages));
                  } catch (e) {
                    return JSON.stringify({ ok: false, error: String(e?.message ?? e), stack: e?.stack });
                  }
                })()
                """
            }

            let result = try await CanvasManager.shared.eval(sessionKey: session, javaScript: js)

            let payload = Data(result.utf8)
            if let obj = try? JSONSerialization.jsonObject(with: payload, options: []) as? [String: Any],
               let ok = obj["ok"] as? Bool
            {
                let error = obj["error"] as? String
                return Response(ok: ok, message: ok ? "" : (error ?? "A2UI error"), payload: payload)
            }

            return Response(ok: true, payload: payload)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private struct ParsedJSONLItem {
        let lineNumber: Int
        let value: Any
    }

    private static func parseJSONL(_ text: String) throws -> [ParsedJSONLItem] {
        var out: [ParsedJSONLItem] = []
        var lineNumber = 0
        for rawLine in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            lineNumber += 1
            let line = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            let data = Data(line.utf8)
            let obj = try JSONSerialization.jsonObject(with: data, options: [])
            out.append(ParsedJSONLItem(lineNumber: lineNumber, value: obj))
        }
        return out
    }

    private static func validateA2UIV0_8(_ items: [ParsedJSONLItem]) throws {
        let allowed = Set(["beginRendering", "surfaceUpdate", "dataModelUpdate", "deleteSurface"])
        for item in items {
            guard let dict = item.value as? [String: Any] else {
                throw NSError(domain: "A2UI", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "A2UI JSONL line \(item.lineNumber): expected a JSON object",
                ])
            }

            if dict.keys.contains("createSurface") {
                throw NSError(domain: "A2UI", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: """
                    A2UI JSONL line \(item.lineNumber): looks like A2UI v0.9 (`createSurface`).
                    Canvas currently supports A2UI v0.8 server→client messages (`beginRendering`, `surfaceUpdate`, `dataModelUpdate`, `deleteSurface`).
                    """,
                ])
            }

            let matched = dict.keys.filter { allowed.contains($0) }
            if matched.count != 1 {
                let found = dict.keys.sorted().joined(separator: ", ")
                throw NSError(domain: "A2UI", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: """
                    A2UI JSONL line \(item.lineNumber): expected exactly one of \(allowed.sorted().joined(separator: ", ")); found: \(found)
                    """,
                ])
            }
        }
    }

    private static func waitForCanvasA2UI(session: String, requireBuiltinPath: Bool, timeoutMs: Int) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(timeoutMs))
        while clock.now < deadline {
            do {
                let res = try await CanvasManager.shared.eval(
                    sessionKey: session,
                    javaScript: """
                    (() => {
                      try {
                        if (document?.readyState !== 'complete') { return ''; }
                        if (!globalThis.clawdisA2UI) { return ''; }
                        if (typeof globalThis.clawdisA2UI.applyMessages !== 'function') { return ''; }
                        if (\(requireBuiltinPath ? "true" : "false")) {
                          const p = String(location?.pathname ?? '');
                          if (!p.startsWith('/__clawdis__/a2ui')) { return ''; }
                        }
                        return 'ready';
                      } catch {
                        return '';
                      }
                    })()
                    """)
                if res == "ready" { return true }
            } catch {
                // Ignore; keep waiting.
            }
            try? await Task.sleep(nanoseconds: 60_000_000)
        }
        return false
    }

    private static func handleNodeList() async -> Response {
        do {
            let data = try await GatewayConnection.shared.request(
                method: "node.list",
                params: [:],
                timeoutMs: 10_000)
            let payload = try JSONDecoder().decode(GatewayNodeListPayload.self, from: data)
            let result = self.buildNodeListResult(payload: payload)

            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let json = (try? encoder.encode(result))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            return Response(ok: true, payload: Data(json.utf8))
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleNodeDescribe(nodeId: String) async -> Response {
        do {
            let data = try await GatewayConnection.shared.request(
                method: "node.describe",
                params: ["nodeId": AnyCodable(nodeId)],
                timeoutMs: 10_000)
            return Response(ok: true, payload: data)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    static func buildNodeListResult(payload: GatewayNodeListPayload) -> NodeListResult {
        let nodes = payload.nodes.map { n -> NodeListNode in
            NodeListNode(
                nodeId: n.nodeId,
                displayName: n.displayName,
                platform: n.platform,
                version: n.version,
                deviceFamily: n.deviceFamily,
                modelIdentifier: n.modelIdentifier,
                remoteAddress: n.remoteIp,
                connected: n.connected == true,
                paired: n.paired == true,
                capabilities: n.caps,
                commands: n.commands)
        }

        let sorted = nodes.sorted { a, b in
            (a.displayName ?? a.nodeId) < (b.displayName ?? b.nodeId)
        }

        let pairedNodeIds = sorted.filter(\.paired).map(\.nodeId).sorted()
        let connectedNodeIds = sorted.filter(\.connected).map(\.nodeId).sorted()

        return NodeListResult(
            ts: payload.ts ?? Int(Date().timeIntervalSince1970 * 1000),
            connectedNodeIds: connectedNodeIds,
            pairedNodeIds: pairedNodeIds,
            nodes: sorted)
    }

    private static func handleNodeInvoke(
        nodeId: String,
        command: String,
        paramsJSON: String?,
        logger: Logger) async -> Response
    {
        do {
            var paramsObj: Any? = nil
            let raw = (paramsJSON ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !raw.isEmpty {
                if let data = raw.data(using: .utf8) {
                    paramsObj = try JSONSerialization.jsonObject(with: data)
                } else {
                    return Response(ok: false, message: "params-json not UTF-8")
                }
            }

            var params: [String: AnyCodable] = [
                "nodeId": AnyCodable(nodeId),
                "command": AnyCodable(command),
                "idempotencyKey": AnyCodable(UUID().uuidString),
            ]
            if let paramsObj {
                params["params"] = AnyCodable(paramsObj)
            }

            let data = try await GatewayConnection.shared.request(
                method: "node.invoke",
                params: params,
                timeoutMs: 30_000)
            return Response(ok: true, payload: data)
        } catch {
            logger.error("node invoke failed: \(error.localizedDescription, privacy: .public)")
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCameraSnap(
        facing: CameraFacing?,
        maxWidth: Int?,
        quality: Double?,
        outPath: String?) async -> Response
    {
        guard self.cameraEnabled() else { return Response(ok: false, message: "Camera disabled by user") }
        do {
            let res = try await self.cameraCapture.snap(facing: facing, maxWidth: maxWidth, quality: quality)
            let url: URL = if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                URL(fileURLWithPath: outPath)
            } else {
                FileManager.default.temporaryDirectory
                    .appendingPathComponent("clawdis-camera-snap-\(UUID().uuidString).jpg")
            }

            try res.data.write(to: url, options: [.atomic])
            return Response(ok: true, message: url.path)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }

    private static func handleCameraClip(
        facing: CameraFacing?,
        durationMs: Int?,
        includeAudio: Bool,
        outPath: String?) async -> Response
    {
        guard self.cameraEnabled() else { return Response(ok: false, message: "Camera disabled by user") }
        do {
            let res = try await self.cameraCapture.clip(
                facing: facing,
                durationMs: durationMs,
                includeAudio: includeAudio,
                outPath: outPath)
            return Response(ok: true, message: res.path)
        } catch {
            return Response(ok: false, message: error.localizedDescription)
        }
    }
}
