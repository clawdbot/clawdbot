import AppKit
import CoreGraphics
import Foundation
import OpenClawKit
import PeekabooAutomationKit
import PeekabooFoundation
@preconcurrency import ScreenCaptureKit

/// Fulfills `computer.act` on this Mac by driving the embedded Peekaboo
/// automation engine in-process. Peekaboo covers single/right/double click,
/// move, drag, scroll, type, and key/hold. A narrow CoreGraphics path handles
/// the computer_20251124 primitives Peekaboo cannot express: middle click,
/// triple click, separate mouse down/up, and modifier-held clicks/scroll.
@MainActor
final class ComputerActionService {
    enum ComputerActionError: LocalizedError {
        case accessibilityNotTrusted
        case noDisplays
        case invalidScreenIndex(Int)
        case missingCoordinate
        case coordinateOutOfBounds
        case invalidReferenceWidth
        case missingKeys
        case emptyText
        case invalidScroll
        case invalidModifier(String)
        case eventCreationFailed

        var errorDescription: String? {
            switch self {
            case .accessibilityNotTrusted:
                "Accessibility permission is required for computer control"
            case .noDisplays:
                "No displays available for computer control"
            case let .invalidScreenIndex(idx):
                "Invalid screen index \(idx)"
            case .missingCoordinate:
                "coordinate is required for this action"
            case .coordinateOutOfBounds:
                "coordinate is outside the captured screen"
            case .invalidReferenceWidth:
                "refWidth must be a positive integer"
            case .missingKeys:
                "keys are required for this action"
            case .emptyText:
                "text is required for this action"
            case .invalidScroll:
                "scrollDirection is required for scroll"
            case let .invalidModifier(token):
                "unsupported modifier '\(token)'"
            case .eventCreationFailed:
                "Failed to synthesize input event"
            }
        }
    }

    private let automation: UIAutomationService
    private let permissions: PermissionsService
    /// Tracks whether a left_mouse_down is outstanding so mouse_move emits
    /// drag events (state persists across invokes on the shared instance).
    private var leftButtonDown = false
    /// Bounded watchdog that releases a stuck left button if the matching
    /// left_mouse_up never arrives (arm expiry, disconnect, or a failed turn).
    private var buttonReleaseTask: Task<Void, Never>?
    /// Modifier flags held since the outstanding left_mouse_down, reapplied to
    /// drag and release events so a modifier-held split drag keeps Cmd/Opt/Shift
    /// for the whole gesture even when later turns omit the modifier.
    private var heldButtonFlags: CGEventFlags = []
    /// Bumped on every lifecycle release request. `perform` captures this before
    /// it suspends and re-checks after dispatch: a disconnect/stop/disable release
    /// can run during an await while `leftButtonDown` is still false, see nothing
    /// held, and no-op, after which dispatch arms the button. The post-dispatch
    /// re-check releases that just-armed button so a lifecycle release can never
    /// be defeated by actor reentrancy at an await before the button is set.
    private var releaseGeneration: UInt64 = 0

    // Drag pacing: fast enough to feel responsive, slow enough that dropped
    // targets (AppKit hit-testing mid-drag) do not misfire.
    private static let dragDurationMs = 400
    private static let dragSteps = 24
    private static let clickInterEventDelay: useconds_t = 12000
    /// Cap wheel ticks at the node so a direct armed caller cannot overflow the
    /// Int32 wheel delta (line count = ticks * 5) and crash the app.
    private static let maxScrollTicks = 100
    /// Cap hold_key at the node: computer.act is directly invocable once armed,
    /// so an unbounded durationMs must not pin a key down for minutes.
    private static let maxHoldMs = 10000
    /// Allow slightly-past-edge coordinates so clicks on the last row/column of
    /// the reported frame still land instead of erroring on rounding.
    private static let coordinateBoundsEpsilon: Double = 2
    /// Idle timeout for an outstanding left button. Refreshed by each drag move,
    /// so a legitimate multi-turn drag (every turn adds a screenshot plus a model
    /// inference) is not force-released mid-gesture. Only a truly abandoned button
    /// (arm expiry, disconnect, or a failed turn with no further activity) hits
    /// this bounded cleanup.
    private static let buttonHoldIdleTimeoutNanoseconds: UInt64 = 120 * 1_000_000_000

    init() {
        self.automation = UIAutomationService()
        self.permissions = PermissionsService()
    }

    func perform(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        guard self.permissions.checkAccessibilityPermission() else {
            throw ComputerActionError.accessibilityNotTrusted
        }
        // Capture the release generation before the first suspension. If a
        // lifecycle release runs while this action is awaiting below (when
        // leftButtonDown is still false), it no-ops; the check after dispatch
        // then releases any button this action armed so the release wins.
        let releaseGenerationAtStart = self.releaseGeneration
        let display = try await self.resolveDisplay(screenIndex: params.screenIndex)
        try await self.dispatch(params, display: display)
        // Catch-up release scoped to the left_mouse_down that armed the button:
        // that branch is synchronous with no await before the check, so
        // leftButtonDown here reflects THIS action's own arm, not a concurrent
        // invoke's. Restricting to leftMouseDown keeps a stale non-arming invoke
        // (scroll/type/move) that predates a lifecycle release from releasing a
        // button a newer action legitimately holds. If the generation moved while
        // this action was suspended, a lifecycle release ran before it armed, so
        // the release must win and the just-armed button is released.
        if params.action == .leftMouseDown,
           self.leftButtonDown,
           self.releaseGeneration != releaseGenerationAtStart
        {
            self.releaseHeldInput()
        }
        let cursor = self.automation.currentMouseLocation() ?? CGPoint.zero
        return OpenClawComputerActResult(ok: true, cursorX: cursor.x, cursorY: cursor.y)
    }

    // MARK: - Dispatch

    private func dispatch(
        _ params: OpenClawComputerActParams,
        display: ResolvedDisplay) async throws
    {
        let modifiers = try ComputerModifiers.parse(params.modifiers)
        switch params.action {
        case .leftClick, .rightClick, .doubleClick:
            let point = try self.requiredPoint(params, display: display)
            let button: ComputerMouseButton = params.action == .rightClick ? .right : .left
            let count = params.action == .doubleClick ? 2 : 1
            if modifiers.isEmpty {
                try await self.peekabooClick(at: point, action: params.action)
            } else {
                try self.rawClick(at: point, button: button, count: count, flags: modifiers.flags)
            }
        case .middleClick:
            let point = try self.requiredPoint(params, display: display)
            try self.rawClick(at: point, button: .middle, count: 1, flags: modifiers.flags)
        case .tripleClick:
            let point = try self.requiredPoint(params, display: display)
            try self.rawClick(at: point, button: .left, count: 3, flags: modifiers.flags)
        case .mouseMove:
            let point = try self.requiredPoint(params, display: display)
            if self.leftButtonDown {
                // A drag is in progress; ordinary moveMouse would post
                // mouseMoved and break drag targets, so emit dragged events
                // carrying the modifiers held since left_mouse_down.
                try self.postMouseEvent(
                    .leftMouseDragged,
                    at: point,
                    button: .left,
                    clickState: 1,
                    flags: self.heldButtonFlags)
                // Refresh the release watchdog: an active drag must not be
                // auto-released mid-gesture during normal tool-loop latency.
                self.armButtonWatchdog()
            } else {
                try await self.automation.moveMouse(to: point, duration: 0, steps: 1, profile: .linear)
            }
        case .leftClickDrag:
            let to = try self.requiredPoint(params, display: display)
            let from = try self.point(params.fromX, params.fromY, params: params, display: display)
                ?? to
            try await self.automation.drag(DragOperationRequest(
                from: from,
                to: to,
                duration: Self.dragDurationMs,
                steps: Self.dragSteps,
                modifiers: modifiers.peekabooString,
                profile: .linear))
        case .leftMouseDown, .leftMouseUp:
            // Coordinate is optional: press/release at the current cursor when omitted.
            let point = try self.point(params.x, params.y, params: params, display: display)
                ?? (self.automation.currentMouseLocation() ?? CGPoint.zero)
            if params.action == .leftMouseDown {
                try self.rawMouseButton(down: true, at: point, flags: modifiers.flags)
                self.setLeftButtonDown(true, flags: modifiers.flags)
            } else {
                // Release with the modifiers held since left_mouse_down (unioned
                // with any the release turn resends) so modifier-held drops keep
                // their copy/move semantics.
                let releaseFlags = self.heldButtonFlags.union(modifiers.flags)
                try self.rawMouseButton(down: false, at: point, flags: releaseFlags)
                self.setLeftButtonDown(false)
            }
        case .scroll:
            try await self.performScroll(params, display: display, modifiers: modifiers)
        case .type:
            guard let text = params.text, !text.isEmpty else { throw ComputerActionError.emptyText }
            try await self.automation.type(
                text: text,
                target: nil,
                clearExisting: false,
                typingDelay: 0,
                snapshotId: nil)
        case .key:
            let keys = try self.requireKeys(params.keys)
            try await self.automation.hotkey(keys: keys, holdDuration: 0)
        case .holdKey:
            let keys = try self.requireKeys(params.keys)
            let holdMs = min(Self.maxHoldMs, max(0, params.durationMs ?? 1000))
            try await self.automation.hotkey(keys: keys, holdDuration: holdMs)
        }
    }

    private func peekabooClick(at point: CGPoint, action: OpenClawComputerAction) async throws {
        let clickType: ClickType = switch action {
        case .rightClick: .right
        case .doubleClick: .double
        default: .single
        }
        try await self.automation.click(target: .coordinates(point), clickType: clickType, snapshotId: nil)
    }

    private func performScroll(
        _ params: OpenClawComputerActParams,
        display: ResolvedDisplay,
        modifiers: ComputerModifiers) async throws
    {
        guard let direction = params.scrollDirection else { throw ComputerActionError.invalidScroll }
        let amount = min(Self.maxScrollTicks, max(1, params.scrollAmount ?? 3))
        // Position the pointer over the requested region first; both Peekaboo
        // and the raw wheel event scroll at the current mouse location.
        if let point = try self.point(params.x, params.y, params: params, display: display) {
            try await self.automation.moveMouse(to: point, duration: 0, steps: 1, profile: .linear)
        }
        if modifiers.isEmpty {
            try await self.automation.scroll(ScrollRequest(
                direction: Self.scrollDirection(direction),
                amount: amount))
        } else {
            try self.rawScroll(direction: direction, amount: amount, flags: modifiers.flags)
        }
    }

    // MARK: - Coordinate mapping

    /// The target display in global points plus the capture source width used to
    /// derive the captured screenshot pixel width for coordinate scaling.
    private struct ResolvedDisplay {
        var geometry: OpenClawComputerDisplayGeometry
        var sourceWidth: Double
        var sourceHeight: Double
    }

    private func requiredPoint(
        _ params: OpenClawComputerActParams,
        display: ResolvedDisplay) throws -> CGPoint
    {
        guard let point = try self.point(params.x, params.y, params: params, display: display) else {
            throw ComputerActionError.missingCoordinate
        }
        return point
    }

    private func point(
        _ x: Double?,
        _ y: Double?,
        params: OpenClawComputerActParams,
        display: ResolvedDisplay) throws -> CGPoint?
    {
        if x == nil, y == nil {
            return nil
        }
        // A partial coordinate (only x or only y) is malformed: optional-coordinate
        // actions (scroll, mouse down/up) must fail rather than silently acting at
        // the current cursor, and a partial drag origin must not fall back to the
        // destination.
        guard let x, let y else { throw ComputerActionError.missingCoordinate }
        // A malformed direct computer.act request could carry refWidth <= 0, which
        // would make capturedWidth non-positive and silently map every coordinate
        // to the display origin. Reject it as an invalid request before clicking.
        if let refWidth = params.refWidth, refWidth <= 0 {
            throw ComputerActionError.invalidReferenceWidth
        }
        let capturedWidth = OpenClawComputerInputGeometry.capturedWidth(
            refWidth: params.refWidth,
            sourceWidth: display.sourceWidth,
            sourceHeight: display.sourceHeight)
        let mapped = OpenClawComputerInputGeometry.mapReferencePointToGlobal(
            x: x,
            y: y,
            capturedWidthPixels: capturedWidth,
            display: display.geometry)
        // Reject coordinates well outside the captured display: on a multi-display
        // Mac an out-of-frame coordinate could otherwise map onto an adjacent
        // screen and click content the model never saw.
        let geometry = display.geometry
        let epsilon = Self.coordinateBoundsEpsilon
        let withinX = mapped.x >= geometry.originX - epsilon
            && mapped.x <= geometry.originX + geometry.widthPoints + epsilon
        let withinY = mapped.y >= geometry.originY - epsilon
            && mapped.y <= geometry.originY + geometry.heightPoints + epsilon
        guard withinX, withinY else { throw ComputerActionError.coordinateOutOfBounds }
        // Clamp the epsilon-tolerated rounding to strictly inside the selected
        // display so a far-edge coordinate cannot post onto an adjacent screen.
        let clamped = OpenClawComputerInputGeometry.clampToDisplay(
            x: mapped.x,
            y: mapped.y,
            display: geometry)
        return CGPoint(x: clamped.x, y: clamped.y)
    }

    // MARK: - Button-hold watchdog

    private func setLeftButtonDown(_ down: Bool, flags: CGEventFlags = []) {
        self.buttonReleaseTask?.cancel()
        self.buttonReleaseTask = nil
        self.leftButtonDown = down
        self.heldButtonFlags = down ? flags : []
        guard down else { return }
        self.armButtonWatchdog()
    }

    /// Arms or re-arms the bounded idle watchdog for an outstanding left button.
    /// Re-armed on each drag move so a live multi-turn gesture is never cut off,
    /// while an abandoned button still gets released after the idle timeout.
    private func armButtonWatchdog() {
        self.buttonReleaseTask?.cancel()
        self.buttonReleaseTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.buttonHoldIdleTimeoutNanoseconds)
            guard !Task.isCancelled else { return }
            self?.autoReleaseLeftButton()
        }
    }

    private func autoReleaseLeftButton() {
        guard self.leftButtonDown else { return }
        let point = self.automation.currentMouseLocation() ?? CGPoint.zero
        try? self.rawMouseButton(down: false, at: point, flags: self.heldButtonFlags)
        self.leftButtonDown = false
        self.heldButtonFlags = []
        self.buttonReleaseTask = nil
    }

    /// Releases any outstanding synthetic left button immediately. Called on
    /// lifecycle transitions (node disconnect, node stop, Computer Control
    /// disabled) so a stranded left_mouse_down is not held until the idle
    /// watchdog fires. Idempotent when nothing is held.
    func releaseHeldInput() {
        // Bump first so a computer.act action suspended at an await before it
        // arms the button observes the changed generation after it resumes and
        // releases itself (see perform); otherwise this no-ops for a not-yet-held
        // button and the action would leave it stuck until the idle watchdog.
        self.releaseGeneration &+= 1
        self.buttonReleaseTask?.cancel()
        self.buttonReleaseTask = nil
        guard self.leftButtonDown else { return }
        let point = self.automation.currentMouseLocation() ?? CGPoint.zero
        try? self.rawMouseButton(down: false, at: point, flags: self.heldButtonFlags)
        self.leftButtonDown = false
        self.heldButtonFlags = []
    }

    private func resolveDisplay(screenIndex: Int?) async throws -> ResolvedDisplay {
        // Match ScreenSnapshotService display ordering so a computer.act
        // screenIndex targets the same display the model saw in screen.snapshot.
        let content = try await SCShareableContent.current
        let displays = content.displays.sorted { $0.displayID < $1.displayID }
        guard !displays.isEmpty else { throw ComputerActionError.noDisplays }
        let idx = screenIndex ?? 0
        guard idx >= 0, idx < displays.count else { throw ComputerActionError.invalidScreenIndex(idx) }
        // CGDisplayBounds is the global top-left point space CGEvent uses;
        // SCDisplay.width/height is the capture source size ScreenSnapshotService
        // caps to refWidth, so together they recover the captured pixel scale and
        // the source aspect ratio needed for portrait longest-edge scaling.
        let bounds = CGDisplayBounds(displays[idx].displayID)
        return ResolvedDisplay(
            geometry: OpenClawComputerDisplayGeometry(
                originX: bounds.origin.x,
                originY: bounds.origin.y,
                widthPoints: bounds.width,
                heightPoints: bounds.height),
            sourceWidth: Double(displays[idx].width),
            sourceHeight: Double(displays[idx].height))
    }

    private func requireKeys(_ keys: String?) throws -> String {
        guard let keys, !keys.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ComputerActionError.missingKeys
        }
        return keys
    }

    private static func scrollDirection(
        _ direction: OpenClawComputerScrollDirection) -> PeekabooFoundation.ScrollDirection
    {
        switch direction {
        case .up: .up
        case .down: .down
        case .left: .left
        case .right: .right
        }
    }

    // MARK: - Raw CoreGraphics primitives

    private func rawClick(at point: CGPoint, button: ComputerMouseButton, count: Int, flags: CGEventFlags) throws {
        for click in 1...max(1, count) {
            try self.postMouseEvent(
                button.downType,
                at: point,
                button: button.cgButton,
                clickState: click,
                flags: flags)
            try self.postMouseEvent(button.upType, at: point, button: button.cgButton, clickState: click, flags: flags)
            usleep(Self.clickInterEventDelay)
        }
    }

    private func rawMouseButton(down: Bool, at point: CGPoint, flags: CGEventFlags) throws {
        let type: CGEventType = down ? .leftMouseDown : .leftMouseUp
        try self.postMouseEvent(type, at: point, button: .left, clickState: 1, flags: flags)
    }

    private func postMouseEvent(
        _ type: CGEventType,
        at point: CGPoint,
        button: CGMouseButton,
        clickState: Int,
        flags: CGEventFlags) throws
    {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: button)
        else {
            throw ComputerActionError.eventCreationFailed
        }
        if clickState > 1 {
            event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        }
        if !flags.isEmpty {
            event.flags = flags
        }
        event.post(tap: .cghidEventTap)
    }

    private func rawScroll(direction: OpenClawComputerScrollDirection, amount: Int, flags: CGEventFlags) throws {
        // Line units per tick match Peekaboo's non-smooth scroll (~5 lines).
        let lines = Int32(amount * 5)
        let (wheel1, wheel2): (Int32, Int32) = switch direction {
        case .up: (lines, 0)
        case .down: (-lines, 0)
        case .left: (0, lines)
        case .right: (0, -lines)
        }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 2,
            wheel1: wheel1,
            wheel2: wheel2,
            wheel3: 0)
        else {
            throw ComputerActionError.eventCreationFailed
        }
        if !flags.isEmpty {
            event.flags = flags
        }
        event.post(tap: .cghidEventTap)
    }
}

/// Mouse button plus the CoreGraphics event types for the raw click path.
private enum ComputerMouseButton {
    case left
    case right
    case middle

    var cgButton: CGMouseButton {
        switch self {
        case .left: .left
        case .right: .right
        case .middle: .center
        }
    }

    var downType: CGEventType {
        switch self {
        case .left: .leftMouseDown
        case .right: .rightMouseDown
        case .middle: .otherMouseDown
        }
    }

    var upType: CGEventType {
        switch self {
        case .left: .leftMouseUp
        case .right: .rightMouseUp
        case .middle: .otherMouseUp
        }
    }
}

/// Parses a portable modifier string ("shift", "cmd+alt") into CGEvent flags and
/// the comma-separated form Peekaboo's drag request expects.
struct ComputerModifiers {
    var flags: CGEventFlags
    var peekabooTokens: [String]

    var isEmpty: Bool {
        self.flags.isEmpty
    }

    var peekabooString: String? {
        self.peekabooTokens.isEmpty ? nil : self.peekabooTokens.joined(separator: ",")
    }

    static func parse(_ raw: String?) throws -> ComputerModifiers {
        guard let raw, !raw.isEmpty else { return ComputerModifiers(flags: [], peekabooTokens: []) }
        var flags: CGEventFlags = []
        var tokens: [String] = []
        for piece in raw.split(whereSeparator: { $0 == "+" || $0 == "," || $0 == " " }) {
            let key = piece.lowercased()
            switch key {
            case "cmd", "command", "meta", "super", "win", "windows":
                flags.insert(.maskCommand)
                tokens.append("cmd")
            case "shift":
                flags.insert(.maskShift)
                tokens.append("shift")
            case "ctrl", "control":
                flags.insert(.maskControl)
                tokens.append("ctrl")
            case "alt", "opt", "option":
                flags.insert(.maskAlternate)
                tokens.append("alt")
            case "fn", "function":
                flags.insert(.maskSecondaryFn)
                tokens.append("fn")
            default:
                // A typo like "shfit" would otherwise silently drop the modifier
                // and perform a materially different high-risk gesture (a plain
                // click instead of a modifier-click); reject it instead.
                throw ComputerActionService.ComputerActionError.invalidModifier(key)
            }
        }
        return ComputerModifiers(flags: flags, peekabooTokens: tokens)
    }
}
