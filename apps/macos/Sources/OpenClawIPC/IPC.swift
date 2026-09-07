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
    /// Session directory on disk (e.g. `~/Library/Application Support/OpenClaw/canvas/<session>/`).
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
