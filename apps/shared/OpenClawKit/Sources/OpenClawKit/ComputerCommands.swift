import Foundation

/// Node command that mirrors the Anthropic `computer_20251124` action set. One
/// action per invoke; pointer coordinates are in reference-screenshot pixels
/// (the `screen.snapshot` frame captured at `maxWidth == refWidth`), which the
/// fulfilling node maps back to display points.
public enum OpenClawComputerCommand: String, Codable, Sendable {
    case act = "computer.act"
}

/// Discriminates the requested computer action. The macOS node maps each case
/// onto the embedded Peekaboo automation engine plus a narrow CoreGraphics
/// path for primitives Peekaboo does not express (middle/triple click,
/// separate mouse down/up, modifier-held clicks/scroll).
public enum OpenClawComputerAction: String, Codable, CaseIterable, Sendable {
    case screenshot
    case leftClick = "left_click"
    case rightClick = "right_click"
    case middleClick = "middle_click"
    case doubleClick = "double_click"
    case tripleClick = "triple_click"
    case mouseMove = "mouse_move"
    case leftClickDrag = "left_click_drag"
    case leftMouseDown = "left_mouse_down"
    case leftMouseUp = "left_mouse_up"
    case scroll
    case type
    case key
    case holdKey = "hold_key"
    case wait
    case listApps = "list_apps"
    case listWindows = "list_windows"
    case getAccessibilityTree = "get_accessibility_tree"
    case getCursorPosition = "get_cursor_position"
    case getWindowState = "get_window_state"
    case launchApp = "launch_app"
    case killApp = "kill_app"
    case bringToFront = "bring_to_front"
    case setValue = "set_value"
    case zoom
    case getBrowserState = "get_browser_state"
    case browserPrepare = "browser_prepare"
    case browserNavigate = "browser_navigate"
    case browserClick = "browser_click"
    case browserType = "browser_type"
    case browserDialog = "browser_dialog"
    case browserSetInputFiles = "browser_set_input_files"
    case browserDownload = "browser_download"
    case browserPointer = "browser_pointer"
    case escalateScope = "escalate_scope"
    case getRecordingState = "get_recording_state"
    case startRecording = "start_recording"
    case stopRecording = "stop_recording"
    case replayTrajectory = "replay_trajectory"
    case invokeMenu = "invoke_menu"

    private var isNativeWireAction: Bool {
        switch self {
        case .wait, .zoom, .getBrowserState, .browserPrepare, .browserNavigate,
             .browserClick, .browserType, .browserDialog, .browserSetInputFiles,
             .browserDownload, .browserPointer, .escalateScope, .getRecordingState,
             .startRecording, .stopRecording, .replayTrajectory:
            false
        default:
            true
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        guard let action = Self(rawValue: rawValue), action.isNativeWireAction else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported native computer action: \(rawValue)")
        }
        self = action
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(self.rawValue)
    }
}

public enum OpenClawComputerScrollDirection: String, Codable, Sendable {
    case up
    case down
    case left
    case right
}

public enum OpenClawComputerDeliveryMode: String, Codable, Sendable {
    case background
    case foreground
}

public enum OpenClawComputerEscalationReason: String, Codable, Sendable {
    case axTreePixelMismatch = "ax_tree_pixel_mismatch"
    case backgroundDeliveryFailed = "background_delivery_failed"
    case foregroundIneffective = "foreground_ineffective"
    case noWindowTarget = "no_window_target"
    case other
}

/// Wire params for `computer.act`. All coordinate fields are reference-screenshot
/// pixels at `refWidth`; `keys` is a chord for key/hold_key; `modifiers` are
/// modifier keys held during pointer actions; `scrollAmount` is wheel ticks.
public struct OpenClawComputerActParams: Codable, Sendable, Equatable {
    public var action: OpenClawComputerAction
    /// Opaque identity returned with the screenshot that supplied coordinates.
    public var displayFrameId: String?
    public var x: Double?
    public var y: Double?
    public var fromX: Double?
    public var fromY: Double?
    public var text: String?
    public var keys: String?
    public var modifiers: String?
    public var scrollDirection: OpenClawComputerScrollDirection?
    public var scrollAmount: Int?
    public var durationMs: Int?
    public var screenIndex: Int?
    public var refWidth: Int?
    public var windowRef: String?
    public var elementRef: String?
    public var observationId: String?
    public var deliveryMode: OpenClawComputerDeliveryMode?
    public var query: String?
    public var depth: Int?
    public var maxElements: Int?
    public var app: String?
    public var value: String?
    public var path: [String]?
    public var x1: Double?
    public var y1: Double?
    public var x2: Double?
    public var y2: Double?
    public var reason: OpenClawComputerEscalationReason?

    public init(
        action: OpenClawComputerAction,
        displayFrameId: String? = nil,
        x: Double? = nil,
        y: Double? = nil,
        fromX: Double? = nil,
        fromY: Double? = nil,
        text: String? = nil,
        keys: String? = nil,
        modifiers: String? = nil,
        scrollDirection: OpenClawComputerScrollDirection? = nil,
        scrollAmount: Int? = nil,
        durationMs: Int? = nil,
        screenIndex: Int? = nil,
        refWidth: Int? = nil,
        windowRef: String? = nil,
        elementRef: String? = nil,
        observationId: String? = nil,
        deliveryMode: OpenClawComputerDeliveryMode? = nil,
        query: String? = nil,
        depth: Int? = nil,
        maxElements: Int? = nil,
        app: String? = nil,
        value: String? = nil,
        path: [String]? = nil,
        x1: Double? = nil,
        y1: Double? = nil,
        x2: Double? = nil,
        y2: Double? = nil,
        reason: OpenClawComputerEscalationReason? = nil)
    {
        self.action = action
        self.displayFrameId = displayFrameId
        self.x = x
        self.y = y
        self.fromX = fromX
        self.fromY = fromY
        self.text = text
        self.keys = keys
        self.modifiers = modifiers
        self.scrollDirection = scrollDirection
        self.scrollAmount = scrollAmount
        self.durationMs = durationMs
        self.screenIndex = screenIndex
        self.refWidth = refWidth
        self.windowRef = windowRef
        self.elementRef = elementRef
        self.observationId = observationId
        self.deliveryMode = deliveryMode
        self.query = query
        self.depth = depth
        self.maxElements = maxElements
        self.app = app
        self.value = value
        self.path = path
        self.x1 = x1
        self.y1 = y1
        self.x2 = x2
        self.y2 = y2
        self.reason = reason
    }
}

public enum OpenClawComputerActionEffect: String, Codable, Sendable {
    case confirmed
    case unverifiable
    case suspectedNoop = "suspected_noop"
}

public struct OpenClawComputerBounds: Codable, Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct OpenClawComputerObservationElement: Codable, Sendable, Equatable {
    public var elementRef: String
    public var role: String
    public var label: String?
    public var value: String?
    public var bounds: OpenClawComputerBounds

    public init(
        elementRef: String,
        role: String,
        label: String? = nil,
        value: String? = nil,
        bounds: OpenClawComputerBounds)
    {
        self.elementRef = elementRef
        self.role = role
        self.label = label
        self.value = value
        self.bounds = bounds
    }
}

public struct OpenClawComputerObservation: Codable, Sendable, Equatable {
    public var kind: String
    public var base64: String?
    public var format: String?
    public var width: Int?
    public var height: Int?
    public var observationId: String?
    public var elements: [OpenClawComputerObservationElement]?

    public init(
        kind: String,
        base64: String? = nil,
        format: String? = nil,
        width: Int? = nil,
        height: Int? = nil,
        observationId: String? = nil,
        elements: [OpenClawComputerObservationElement]? = nil)
    {
        self.kind = kind
        self.base64 = base64
        self.format = format
        self.width = width
        self.height = height
        self.observationId = observationId
        self.elements = elements
    }
}

public struct OpenClawComputerEscalation: Codable, Sendable, Equatable {
    public var recommended: String
    public var reasonCode: String

    public init(recommended: String, reasonCode: String) {
        self.recommended = recommended
        self.reasonCode = reasonCode
    }
}

/// Canonical result of a `computer.act` action.
public struct OpenClawComputerActResult: Codable, Sendable, Equatable {
    public var ok: Bool
    public var effect: OpenClawComputerActionEffect?
    public var observation: OpenClawComputerObservation?
    public var escalation: OpenClawComputerEscalation?
    public var details: [String: AnyCodable]?

    public init(
        ok: Bool,
        effect: OpenClawComputerActionEffect? = nil,
        observation: OpenClawComputerObservation? = nil,
        escalation: OpenClawComputerEscalation? = nil,
        details: [String: AnyCodable]? = nil)
    {
        self.ok = ok
        self.effect = effect
        self.observation = observation
        self.escalation = escalation
        self.details = details
    }
}
