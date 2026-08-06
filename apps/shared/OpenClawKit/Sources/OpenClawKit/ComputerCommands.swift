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
public enum OpenClawComputerAction: String, Codable, Sendable {
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
}

public enum OpenClawComputerScrollDirection: String, Codable, Sendable {
    case up
    case down
    case left
    case right
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
        refWidth: Int? = nil)
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
    }
}

/// Result of a `computer.act` input action.
public struct OpenClawComputerActResult: Codable, Sendable, Equatable {
    public var ok: Bool
    public var cursorX: Double
    public var cursorY: Double

    public init(ok: Bool, cursorX: Double, cursorY: Double) {
        self.ok = ok
        self.cursorX = cursorX
        self.cursorY = cursorY
    }
}
