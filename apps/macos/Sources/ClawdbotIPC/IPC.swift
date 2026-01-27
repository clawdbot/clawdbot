import CoreGraphics
import Foundation

// MARK: - Capabilities

public enum Capability: String, Codable, CaseIterable, Sendable {
    /// AppleScript / Automation access to control other apps (TCC Automation).
    case appleScript
    case notifications
    case accessibility
    case screenRecording
    case microphone
    case speechRecognition
    case camera
    case location
}

public enum CameraFacing: String, Codable, Sendable {
    case front
    case back
}

// MARK: - Requests

/// Notification interruption level (maps to UNNotificationInterruptionLevel)
public enum NotificationPriority: String, Codable, Sendable {
    case passive // silent, no wake
    case active // default
    case timeSensitive // breaks through Focus modes
}

/// Notification delivery mechanism.
public enum NotificationDelivery: String, Codable, Sendable {
    /// Use macOS notification center (UNUserNotificationCenter).
    case system
    /// Use an in-app overlay/toast (no Notification Center history).
    case overlay
    /// Prefer system; fall back to overlay when system isn't available.
    case auto
}

// MARK: - Canvas geometry

/// Optional placement hints for the Canvas panel.
/// Values are in screen coordinates (same as `NSWindow` frame).
public struct CanvasPlacement: Codable, Sendable {
    public var x: Double?
    public var y: Double?
    public var width: Double?
    public var height: Double?

    public init(x: Double? = nil, y: Double? = nil, width: Double? = nil, height: Double? = nil) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

// MARK: - Canvas show result

public enum CanvasShowStatus: String, Codable, Sendable {
    /// Panel was shown, but no navigation occurred (no target passed and session already existed).
    case shown
    /// Target was a direct URL (http(s) or file).
    case web
    /// Local canvas target resolved to an existing file.
    case ok
    /// Local canvas target did not resolve to a file (404 page).
    case notFound
    /// Local scaffold fallback (e.g., no index.html present).
    case welcome
}

public struct CanvasShowResult: Codable, Sendable {
    /// Session directory on disk (e.g. `~/Library/Application Support/Moltbot/canvas/<session>/`).
    public var directory: String
    /// Target as provided by the caller (may be nil/empty).
    public var target: String?
    /// Target actually navigated to (nil when no navigation occurred; defaults to "/" for a newly created session).
    public var effectiveTarget: String?
    public var status: CanvasShowStatus
    /// URL that was loaded (nil when no navigation occurred).
    public var url: String?

    public init(
        directory: String,
        target: String?,
        effectiveTarget: String?,
        status: CanvasShowStatus,
        url: String?)
    {
        self.directory = directory
        self.target = target
        self.effectiveTarget = effectiveTarget
        self.status = status
        self.url = url
    }
}

// MARK: - Canvas A2UI

public enum CanvasA2UICommand: String, Codable, Sendable {
    case pushJSONL
    case reset
}

public enum Request: Sendable {
    case notify(
        title: String,
        body: String,
        sound: String?,
        priority: NotificationPriority?,
        delivery: NotificationDelivery?)
    case ensurePermissions([Capability], interactive: Bool)
    case runShell(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeoutSec: Double?,
        needsScreenRecording: Bool)
    case status
    case agent(message: String, thinking: String?, session: String?, deliver: Bool, to: String?)
    case rpcStatus
    case canvasPresent(session: String, path: String?, placement: CanvasPlacement?)
    case canvasHide(session: String)
    case canvasEval(session: String, javaScript: String)
    case canvasSnapshot(session: String, outPath: String?)
    case canvasA2UI(session: String, command: CanvasA2UICommand, jsonl: String?)
    case nodeList
    case nodeDescribe(nodeId: String)
    case nodeInvoke(nodeId: String, command: String, paramsJSON: String?)
    case cameraSnap(facing: CameraFacing?, maxWidth: Int?, quality: Double?, outPath: String?)
    case cameraClip(facing: CameraFacing?, durationMs: Int?, includeAudio: Bool, outPath: String?)
    case screenRecord(screenIndex: Int?, durationMs: Int?, fps: Double?, includeAudio: Bool, outPath: String?)
}

// MARK: - Responses

public struct Response: Codable, Sendable {
    public var ok: Bool
    public var message: String?
    /// Optional payload (PNG bytes, stdout text, etc.).
    public var payload: Data?

    public init(ok: Bool, message: String? = nil, payload: Data? = nil) {
        self.ok = ok
        self.message = message
        self.payload = payload
    }
}

// MARK: - Codable conformance for Request

extension Request: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        case title, body, sound, priority, delivery
        case caps, interactive
        case command, cwd, env, timeoutSec, needsScreenRecording
        case message, thinking, session, deliver, to
        case rpcStatus
        case path
        case javaScript
        case outPath
        case screenIndex
        case fps
        case canvasA2UICommand
        case jsonl
        case facing
        case maxWidth
        case quality
        case durationMs
        case includeAudio
        case placement
        case nodeId
        case nodeCommand
        case paramsJSON
    }

    private enum Kind: String, Codable {
        case notify
        case ensurePermissions
        case runShell
        case status
        case agent
        case rpcStatus
        case canvasPresent
        case canvasHide
        case canvasEval
        case canvasSnapshot
        case canvasA2UI
        case nodeList
        case nodeDescribe
        case nodeInvoke
        case cameraSnap
        case cameraClip
        case screenRecord
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .notify(title, body, sound, priority, delivery):
            try container.encode(Kind.notify, forKey: .type)
            try container.encode(title, forKey: .title)
            try container.encode(body, forKey: .body)
            try container.encodeIfPresent(sound, forKey: .sound)
            try container.encodeIfPresent(priority, forKey: .priority)
            try container.encodeIfPresent(delivery, forKey: .delivery)

        case let .ensurePermissions(caps, interactive):
            try container.encode(Kind.ensurePermissions, forKey: .type)
            try container.encode(caps, forKey: .caps)
            try container.encode(interactive, forKey: .interactive)

        case let .runShell(command, cwd, env, timeoutSec, needsSR):
            try container.encode(Kind.runShell, forKey: .type)
            try container.encode(command, forKey: .command)
            try container.encodeIfPresent(cwd, forKey: .cwd)
            try container.encodeIfPresent(env, forKey: .env)
            try container.encodeIfPresent(timeoutSec, forKey: .timeoutSec)
            try container.encode(needsSR, forKey: .needsScreenRecording)

        case .status:
            try container.encode(Kind.status, forKey: .type)

        case let .agent(message, thinking, session, deliver, to):
            try container.encode(Kind.agent, forKey: .type)
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(thinking, forKey: .thinking)
            try container.encodeIfPresent(session, forKey: .session)
            try container.encode(deliver, forKey: .deliver)
            try container.encodeIfPresent(to, forKey: .to)

        case .rpcStatus:
            try container.encode(Kind.rpcStatus, forKey: .type)

        case let .canvasPresent(session, path, placement):
            try container.encode(Kind.canvasPresent, forKey: .type)
            try container.encode(session, forKey: .session)
            try container.encodeIfPresent(path, forKey: .path)
            try container.encodeIfPresent(placement, forKey: .placement)

        case let .canvasHide(session):
            try container.encode(Kind.canvasHide, forKey: .type)
            try container.encode(session, forKey: .session)

        case let .canvasEval(session, javaScript):
            try container.encode(Kind.canvasEval, forKey: .type)
            try container.encode(session, forKey: .session)
            try container.encode(javaScript, forKey: .javaScript)

        case let .canvasSnapshot(session, outPath):
            try container.encode(Kind.canvasSnapshot, forKey: .type)
            try container.encode(session, forKey: .session)
            try container.encodeIfPresent(outPath, forKey: .outPath)

        case let .canvasA2UI(session, command, jsonl):
            try container.encode(Kind.canvasA2UI, forKey: .type)
            try container.encode(session, forKey: .session)
            try container.encode(command, forKey: .canvasA2UICommand)
            try container.encodeIfPresent(jsonl, forKey: .jsonl)

        case .nodeList:
            try container.encode(Kind.nodeList, forKey: .type)

        case let .nodeDescribe(nodeId):
            try container.encode(Kind.nodeDescribe, forKey: .type)
            try container.encode(nodeId, forKey: .nodeId)

        case let .nodeInvoke(nodeId, command, paramsJSON):
            try container.encode(Kind.nodeInvoke, forKey: .type)
            try container.encode(nodeId, forKey: .nodeId)
            try container.encode(command, forKey: .nodeCommand)
            try container.encodeIfPresent(paramsJSON, forKey: .paramsJSON)

        case let .cameraSnap(facing, maxWidth, quality, outPath):
            try container.encode(Kind.cameraSnap, forKey: .type)
            try container.encodeIfPresent(facing, forKey: .facing)
            try container.encodeIfPresent(maxWidth, forKey: .maxWidth)
            try container.encodeIfPresent(quality, forKey: .quality)
            try container.encodeIfPresent(outPath, forKey: .outPath)

        case let .cameraClip(facing, durationMs, includeAudio, outPath):
            try container.encode(Kind.cameraClip, forKey: .type)
            try container.encodeIfPresent(facing, forKey: .facing)
            try container.encodeIfPresent(durationMs, forKey: .durationMs)
            try container.encode(includeAudio, forKey: .includeAudio)
            try container.encodeIfPresent(outPath, forKey: .outPath)

        case let .screenRecord(screenIndex, durationMs, fps, includeAudio, outPath):
            try container.encode(Kind.screenRecord, forKey: .type)
            try container.encodeIfPresent(screenIndex, forKey: .screenIndex)
            try container.encodeIfPresent(durationMs, forKey: .durationMs)
            try container.encodeIfPresent(fps, forKey: .fps)
            try container.encode(includeAudio, forKey: .includeAudio)
            try container.encodeIfPresent(outPath, forKey: .outPath)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .type)
        switch kind {
        case .notify:
            let title = try container.decode(String.self, forKey: .title)
            let body = try container.decode(String.self, forKey: .body)
            let sound = try container.decodeIfPresent(String.self, forKey: .sound)
            let priority = try container.decodeIfPresent(NotificationPriority.self, forKey: .priority)
            let delivery = try container.decodeIfPresent(NotificationDelivery.self, forKey: .delivery)
            self = .notify(title: title, body: body, sound: sound, priority: priority, delivery: delivery)

        case .ensurePermissions:
            let caps = try container.decode([Capability].self, forKey: .caps)
            let interactive = try container.decode(Bool.self, forKey: .interactive)
            self = .ensurePermissions(caps, interactive: interactive)

        case .runShell:
            let command = try container.decode([String].self, forKey: .command)
            let cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
            let env = try container.decodeIfPresent([String: String].self, forKey: .env)
            let timeout = try container.decodeIfPresent(Double.self, forKey: .timeoutSec)
            let needsSR = try container.decode(Bool.self, forKey: .needsScreenRecording)
            self = .runShell(command: command, cwd: cwd, env: env, timeoutSec: timeout, needsScreenRecording: needsSR)

        case .status:
            self = .status

        case .agent:
            let message = try container.decode(String.self, forKey: .message)
            let thinking = try container.decodeIfPresent(String.self, forKey: .thinking)
            let session = try container.decodeIfPresent(String.self, forKey: .session)
            let deliver = try container.decode(Bool.self, forKey: .deliver)
            let to = try container.decodeIfPresent(String.self, forKey: .to)
            self = .agent(message: message, thinking: thinking, session: session, deliver: deliver, to: to)

        case .rpcStatus:
            self = .rpcStatus

        case .canvasPresent:
            let session = try container.decode(String.self, forKey: .session)
            let path = try container.decodeIfPresent(String.self, forKey: .path)
            let placement = try container.decodeIfPresent(CanvasPlacement.self, forKey: .placement)
            self = .canvasPresent(session: session, path: path, placement: placement)

        case .canvasHide:
            let session = try container.decode(String.self, forKey: .session)
            self = .canvasHide(session: session)

        case .canvasEval:
            let session = try container.decode(String.self, forKey: .session)
            let javaScript = try container.decode(String.self, forKey: .javaScript)
            self = .canvasEval(session: session, javaScript: javaScript)

        case .canvasSnapshot:
            let session = try container.decode(String.self, forKey: .session)
            let outPath = try container.decodeIfPresent(String.self, forKey: .outPath)
            self = .canvasSnapshot(session: session, outPath: outPath)

        case .canvasA2UI:
            let session = try container.decode(String.self, forKey: .session)
            let command = try container.decode(CanvasA2UICommand.self, forKey: .canvasA2UICommand)
            let jsonl = try container.decodeIfPresent(String.self, forKey: .jsonl)
            self = .canvasA2UI(session: session, command: command, jsonl: jsonl)

        case .nodeList:
            self = .nodeList

        case .nodeDescribe:
            let nodeId = try container.decode(String.self, forKey: .nodeId)
            self = .nodeDescribe(nodeId: nodeId)

        case .nodeInvoke:
            let nodeId = try container.decode(String.self, forKey: .nodeId)
            let command = try container.decode(String.self, forKey: .nodeCommand)
            let paramsJSON = try container.decodeIfPresent(String.self, forKey: .paramsJSON)
            self = .nodeInvoke(nodeId: nodeId, command: command, paramsJSON: paramsJSON)

        case .cameraSnap:
            let facing = try container.decodeIfPresent(CameraFacing.self, forKey: .facing)
            let maxWidth = try container.decodeIfPresent(Int.self, forKey: .maxWidth)
            let quality = try container.decodeIfPresent(Double.self, forKey: .quality)
            let outPath = try container.decodeIfPresent(String.self, forKey: .outPath)
            self = .cameraSnap(facing: facing, maxWidth: maxWidth, quality: quality, outPath: outPath)

        case .cameraClip:
            let facing = try container.decodeIfPresent(CameraFacing.self, forKey: .facing)
            let durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
            let includeAudio = (try? container.decode(Bool.self, forKey: .includeAudio)) ?? true
            let outPath = try container.decodeIfPresent(String.self, forKey: .outPath)
            self = .cameraClip(facing: facing, durationMs: durationMs, includeAudio: includeAudio, outPath: outPath)

        case .screenRecord:
            let screenIndex = try container.decodeIfPresent(Int.self, forKey: .screenIndex)
            let durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
            let fps = try container.decodeIfPresent(Double.self, forKey: .fps)
            let includeAudio = (try? container.decode(Bool.self, forKey: .includeAudio)) ?? true
            let outPath = try container.decodeIfPresent(String.self, forKey: .outPath)
            self = .screenRecord(
                screenIndex: screenIndex,
                durationMs: durationMs,
                fps: fps,
                includeAudio: includeAudio,
                outPath: outPath)
        }
    }
}

// Shared transport settings
public let controlSocketPath = FileManager()
    .homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/moltbot/control.sock")
    .path
