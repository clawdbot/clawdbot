import CoreGraphics
import Foundation
import OpenClawKit
import PeekabooAutomationKit
import PeekabooFoundation
@preconcurrency import ScreenCaptureKit

/// Fulfills `computer.act` on this Mac by driving the embedded Peekaboo
/// automation engine in-process. Peekaboo covers single/right/double click,
/// move, drag, scroll, and key/hold. A narrow CoreGraphics path handles
/// grapheme-atomic typing plus computer_20251124 primitives Peekaboo cannot
/// express: middle/triple click, separate mouse down/up, and modified input.
@MainActor
final class ComputerScreenActionExecutor {
    private typealias ComputerActionError = ComputerActionService.ComputerActionError

    typealias MouseButtonEventPoster = @MainActor (
        _ down: Bool,
        _ point: CGPoint,
        _ flags: CGEventFlags) throws -> Void
    typealias MouseEventFactory = @MainActor (
        _ type: CGEventType,
        _ point: CGPoint,
        _ button: CGMouseButton,
        _ clickState: Int,
        _ flags: CGEventFlags) throws -> CGEvent
    typealias MouseEventPoster = @MainActor (_ event: CGEvent) throws -> Void
    /// Posts one Swift grapheme as an atomic key-down/key-up pair. Cancellation
    /// checkpoints live between calls so authority loss cannot strand a key.
    typealias TextGraphemePoster = @MainActor (_ grapheme: Character) async throws -> Void

    private let automation: UIAutomationService
    private let mouseButtonEventPoster: MouseButtonEventPoster
    private let mouseEventFactory: MouseEventFactory
    private let mouseEventPoster: MouseEventPoster
    private let textGraphemePoster: TextGraphemePoster
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
        self.mouseButtonEventPoster = Self.postMouseButtonEvent
        self.mouseEventFactory = Self.makeMouseEvent
        self.mouseEventPoster = Self.postMouseEvent
        self.textGraphemePoster = { try Self.postTextGrapheme($0) }
    }

    #if DEBUG
    init(mouseButtonEventPoster: @escaping MouseButtonEventPoster) {
        self.automation = UIAutomationService()
        self.mouseButtonEventPoster = mouseButtonEventPoster
        self.mouseEventFactory = Self.makeMouseEvent
        self.mouseEventPoster = Self.postMouseEvent
        self.textGraphemePoster = { try Self.postTextGrapheme($0) }
    }

    init(
        mouseEventFactory: @escaping MouseEventFactory,
        mouseEventPoster: @escaping MouseEventPoster)
    {
        self.automation = UIAutomationService()
        self.mouseButtonEventPoster = Self.postMouseButtonEvent
        self.mouseEventFactory = mouseEventFactory
        self.mouseEventPoster = mouseEventPoster
        self.textGraphemePoster = { try Self.postTextGrapheme($0) }
    }

    init(textGraphemePoster: @escaping TextGraphemePoster) {
        self.automation = UIAutomationService()
        self.mouseButtonEventPoster = Self.postMouseButtonEvent
        self.mouseEventFactory = Self.makeMouseEvent
        self.mouseEventPoster = Self.postMouseEvent
        self.textGraphemePoster = textGraphemePoster
    }
    #endif

    func perform(
        _ params: OpenClawComputerActParams,
        checkExecutionAllowed: @MainActor () throws -> Void) async throws
        -> OpenClawComputerActResult
    {
        try ComputerActionService.validateInputPermissions(ComputerControlPermissionSnapshot.probe())
        let display = try await resolveDisplay(params: params)
        try checkExecutionAllowed()
        try await self.dispatch(
            params,
            display: display,
            checkExecutionAllowed: checkExecutionAllowed)
        try checkExecutionAllowed()
        return OpenClawComputerActResult(ok: true)
    }

    // MARK: - Dispatch

    private func dispatch(
        _ params: OpenClawComputerActParams,
        display: ResolvedDisplay,
        checkExecutionAllowed: @MainActor () throws -> Void) async throws
    {
        try checkExecutionAllowed()
        let modifiers = try ComputerModifiers.parse(params.modifiers)
        try Self.validateHeldButtonTransition(action: params.action, leftButtonDown: self.leftButtonDown)
        switch params.action {
        case .leftClick, .rightClick, .doubleClick:
            let point = try requiredPoint(params, display: display)
            let button: ComputerMouseButton = params.action == .rightClick ? .right : .left
            let count = params.action == .doubleClick ? 2 : 1
            if modifiers.isEmpty {
                try await self.peekabooClick(at: point, action: params.action)
            } else {
                try self.rawClick(at: point, button: button, count: count, flags: modifiers.flags)
            }
        case .middleClick:
            let point = try requiredPoint(params, display: display)
            try rawClick(at: point, button: .middle, count: 1, flags: modifiers.flags)
        case .tripleClick:
            let point = try requiredPoint(params, display: display)
            try rawClick(at: point, button: .left, count: 3, flags: modifiers.flags)
        case .mouseMove:
            let point = try requiredPoint(params, display: display)
            if self.leftButtonDown {
                // A drag is in progress; ordinary moveMouse would post
                // mouseMoved and break drag targets, so emit dragged events
                // carrying the modifiers held since left_mouse_down.
                let event = try self.mouseEventFactory(
                    .leftMouseDragged,
                    point,
                    .left,
                    1,
                    self.heldButtonFlags)
                try self.mouseEventPoster(event)
                // Refresh the release watchdog: an active drag must not be
                // auto-released mid-gesture during normal tool-loop latency.
                self.armButtonWatchdog()
            } else {
                try await self.automation.moveMouse(to: point, duration: 0, steps: 1, profile: .linear)
            }
        case .leftClickDrag:
            let to = try requiredPoint(params, display: display)
            let from = try point(params.fromX, params.fromY, params: params, display: display)
                ?? to
            try await self.rawDrag(from: from, to: to, flags: modifiers.flags)
        case .leftMouseDown, .leftMouseUp:
            // Coordinate is optional: press/release at the current cursor when omitted.
            let mappedPoint = try self.point(params.x, params.y, params: params, display: display)
            let point = if let mappedPoint {
                mappedPoint
            } else if params.action == .leftMouseDown {
                try Self.validatedCurrentCursorPoint(
                    self.automation.currentMouseLocation(),
                    display: display.geometry)
            } else {
                self.automation.currentMouseLocation() ?? CGPoint.zero
            }
            if params.action == .leftMouseDown {
                try self.rawMouseButton(down: true, at: point, flags: modifiers.flags)
                self.setLeftButtonDown(true, flags: modifiers.flags)
            } else {
                // Release with the modifiers held since left_mouse_down (unioned
                // with any the release turn resends) so modifier-held drops keep
                // their copy/move semantics.
                try self.releaseHeldButton(at: point, additionalFlags: modifiers.flags)
            }
        case .scroll:
            try await self.performScroll(
                params,
                display: display,
                modifiers: modifiers,
                checkExecutionAllowed: checkExecutionAllowed)
        case .type:
            guard let text = params.text, !text.isEmpty else { throw ComputerActionError.emptyText }
            try await self.typeText(text, checkExecutionAllowed: checkExecutionAllowed)
        case .key:
            let keys = try requireKeys(params.keys)
            try await self.automation.hotkey(keys: keys, holdDuration: 0)
        case .holdKey:
            let keys = try requireKeys(params.keys)
            let holdMs = min(Self.maxHoldMs, max(0, params.durationMs ?? 1000))
            try await self.automation.hotkey(keys: keys, holdDuration: holdMs)
        default:
            throw ComputerActionError.unsupportedAction(params.action)
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

    func typeText(
        _ text: String,
        checkExecutionAllowed: @MainActor () throws -> Void) async throws
    {
        for grapheme in text {
            // Caller cancellation is recorded synchronously by the execution
            // queue, so this check remains authoritative even before its actor
            // cancellation hop runs.
            try checkExecutionAllowed()
            try await self.textGraphemePoster(grapheme)
            // The default poster is synchronous. Yield explicitly so disconnect,
            // pause, disable, and endpoint-replacement lifecycle hops can revoke
            // authority before the next synthetic key pair.
            await Task.yield()
        }
        try checkExecutionAllowed()
    }

    private func performScroll(
        _ params: OpenClawComputerActParams,
        display: ResolvedDisplay,
        modifiers: ComputerModifiers,
        checkExecutionAllowed: @MainActor () throws -> Void) async throws
    {
        guard let direction = params.scrollDirection else { throw ComputerActionError.invalidScroll }
        let amount = min(Self.maxScrollTicks, max(1, params.scrollAmount ?? 3))
        // ComputerActionService admits global input here; background requests stay
        // window-scoped. Position the pointer for either foreground scroll path.
        if let point = try point(params.x, params.y, params: params, display: display) {
            try await self.automation.moveMouse(to: point, duration: 0, steps: 1, profile: .linear)
        } else {
            _ = try Self.validatedCurrentCursorPoint(
                self.automation.currentMouseLocation(),
                display: display.geometry)
        }
        try checkExecutionAllowed()
        if modifiers.isEmpty {
            try await self.automation.scroll(ScrollRequest(
                direction: Self.scrollDirection(direction),
                amount: amount,
                foreground: true))
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
        guard let point = try point(params.x, params.y, params: params, display: display) else {
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
        // Coordinates are meaningful only in the exact reference frame bound into
        // displayFrameId. Missing or non-positive widths must never fall back to
        // the native source width, which could turn valid screenshot pixels into a
        // deterministic misclick.
        let refWidth = try Self.requiredReferenceWidth(params)
        let capturedWidth = OpenClawComputerInputGeometry.capturedWidth(
            refWidth: refWidth,
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

    static func validatedCurrentCursorPoint(
        _ point: CGPoint?,
        display: OpenClawComputerDisplayGeometry) throws -> CGPoint
    {
        guard let point,
              point.x >= display.originX,
              point.x < display.originX + display.widthPoints,
              point.y >= display.originY,
              point.y < display.originY + display.heightPoints
        else { throw ComputerActionError.coordinateOutOfBounds }
        return point
    }

    static func validateHeldButtonTransition(
        action: OpenClawComputerAction,
        leftButtonDown: Bool) throws
    {
        if action == .leftMouseUp, !leftButtonDown {
            // Never synthesize an unmatched up: it could terminate a physical
            // user drag that this service did not start.
            throw ComputerActionError.buttonNotHeld
        }
        guard leftButtonDown else { return }
        switch action {
        case .leftClick, .doubleClick, .tripleClick, .leftClickDrag, .leftMouseDown:
            throw ComputerActionError.buttonAlreadyHeld
        default:
            return
        }
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
        // This task has fired and cannot serve as a future retry. Clear its handle
        // before attempting release; a failure must install a new watchdog below.
        self.buttonReleaseTask = nil
        self.releaseCurrentHeldButton()
    }

    /// Releases the current button without advancing the lifecycle epoch. The
    /// execution queue owns epoch changes so a reordered duplicate release cannot
    /// cancel a fresh action that already adopted the same epoch.
    @discardableResult
    func releaseCurrentHeldButton() -> Bool {
        guard self.leftButtonDown else {
            self.buttonReleaseTask?.cancel()
            self.buttonReleaseTask = nil
            return true
        }
        let point = self.automation.currentMouseLocation() ?? CGPoint.zero
        try? self.releaseHeldButton(at: point)
        return !self.leftButtonDown
    }

    /// Posts the service-owned mouse-up and commits the state transition only
    /// after synthesis succeeds. A failed explicit up carries its modifiers into
    /// watchdog/lifecycle retries so the eventual drop preserves its semantics.
    private func releaseHeldButton(
        at point: CGPoint,
        additionalFlags: CGEventFlags = []) throws
    {
        let releaseFlags = self.heldButtonFlags.union(additionalFlags)
        do {
            try self.rawMouseButton(down: false, at: point, flags: releaseFlags)
        } catch {
            // Ownership authorizes the only safe follow-up mouse-up. Keep it and
            // its modifiers until synthesis succeeds, with a live watchdog retry.
            self.heldButtonFlags = releaseFlags
            self.armButtonWatchdog()
            throw error
        }
        self.setLeftButtonDown(false)
    }

    #if DEBUG
    var isLeftButtonDownForTesting: Bool {
        self.leftButtonDown
    }

    var heldButtonFlagsForTesting: CGEventFlags {
        self.heldButtonFlags
    }

    var buttonWatchdogArmedForTesting: Bool {
        self.buttonReleaseTask != nil
    }

    func holdLeftButtonForTesting(flags: CGEventFlags) {
        self.setLeftButtonDown(true, flags: flags)
    }

    func fireButtonWatchdogForTesting() {
        self.buttonReleaseTask?.cancel()
        self.autoReleaseLeftButton()
    }

    func releaseHeldButtonForTesting(additionalFlags: CGEventFlags) throws {
        let point = self.automation.currentMouseLocation() ?? CGPoint.zero
        try self.releaseHeldButton(at: point, additionalFlags: additionalFlags)
    }
    #endif

    private func resolveDisplay(params: OpenClawComputerActParams) async throws -> ResolvedDisplay {
        // Match ScreenSnapshotService display ordering so a computer.act
        // screenIndex targets the same display the model saw in screen.snapshot.
        let content = try await SCShareableContent.current
        let displays = content.displays.sorted { $0.displayID < $1.displayID }
        guard !displays.isEmpty else { throw ComputerActionError.noDisplays }
        let idx = params.screenIndex ?? 0
        guard idx >= 0, idx < displays.count else { throw ComputerActionError.invalidScreenIndex(idx) }
        // CGDisplayBounds is the global top-left point space CGEvent uses;
        // SCDisplay.width/height is the capture source size ScreenSnapshotService
        // caps to refWidth, so together they recover the captured pixel scale and
        // the source aspect ratio needed for portrait longest-edge scaling.
        let bounds = CGDisplayBounds(displays[idx].displayID)
        let geometry = OpenClawComputerDisplayGeometry(
            originX: bounds.origin.x,
            originY: bounds.origin.y,
            widthPoints: bounds.width,
            heightPoints: bounds.height)
        let sourceWidth = Double(displays[idx].width)
        let sourceHeight = Double(displays[idx].height)
        // A display can disappear between the ScreenCaptureKit snapshot and
        // CGDisplayBounds, which returns a zero rectangle for a stale id. Reject
        // all degenerate geometry here; mapping it would collapse input to (0, 0).
        guard OpenClawComputerInputGeometry.isValidMappingGeometry(
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            display: geometry)
        else {
            throw ComputerActionError.noDisplays
        }
        if Self.usesScreenshotCoordinates(params) {
            let refWidth = try Self.requiredReferenceWidth(params)
            let currentFrameId = OpenClawComputerInputGeometry.displayFrameId(
                displayID: displays[idx].displayID,
                sourceWidth: sourceWidth,
                sourceHeight: sourceHeight,
                referenceWidth: refWidth,
                display: geometry)
            try Self.validateDisplayFrame(params, currentFrameId: currentFrameId)
        }
        return ResolvedDisplay(
            geometry: geometry,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight)
    }

    private static func usesScreenshotCoordinates(_ params: OpenClawComputerActParams) -> Bool {
        params.x != nil || params.y != nil || params.fromX != nil || params.fromY != nil
    }

    private static func requiredReferenceWidth(_ params: OpenClawComputerActParams) throws -> Int {
        guard let refWidth = params.refWidth, refWidth > 0 else {
            throw ComputerActionError.invalidReferenceWidth
        }
        return refWidth
    }

    static func validateDisplayFrame(
        _ params: OpenClawComputerActParams,
        currentFrameId: String) throws
    {
        guard self.usesScreenshotCoordinates(params) else { return }
        _ = try self.requiredReferenceWidth(params)
        guard let expectedFrameId = params.displayFrameId, !expectedFrameId.isEmpty else {
            throw ComputerActionError.missingDisplayFrameId
        }
        guard expectedFrameId == currentFrameId else {
            throw ComputerActionError.displayFrameChanged
        }
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
        // Build every down/up pair before posting the first down. Event creation
        // failure can then never strand a button between a successfully created
        // down and a missing up.
        let pairs = try (1...max(1, count)).map { click in
            let down = try self.mouseEventFactory(
                button.downType,
                point,
                button.cgButton,
                click,
                flags)
            let up = try self.mouseEventFactory(
                button.upType,
                point,
                button.cgButton,
                click,
                flags)
            return (down: down, up: up)
        }
        for pair in pairs {
            try self.mouseEventPoster(pair.down)
            try self.mouseEventPoster(pair.up)
            usleep(Self.clickInterEventDelay)
        }
    }

    private func rawDrag(from: CGPoint, to: CGPoint, flags: CGEventFlags) async throws {
        let down = try self.mouseEventFactory(.leftMouseDown, from, .left, 1, flags)
        let moves = try (1...Self.dragSteps).map { step in
            let fraction = Double(step) / Double(Self.dragSteps)
            let point = CGPoint(
                x: from.x + (to.x - from.x) * fraction,
                y: from.y + (to.y - from.y) * fraction)
            return try self.mouseEventFactory(.leftMouseDragged, point, .left, 1, flags)
        }
        let up = try self.mouseEventFactory(.leftMouseUp, to, .left, 1, flags)

        try self.mouseEventPoster(down)
        var needsRelease = true
        defer {
            if needsRelease {
                try? self.mouseEventPoster(up)
            }
        }
        let stepDelay = UInt64(Self.dragDurationMs) * 1_000_000 / UInt64(Self.dragSteps)
        for move in moves {
            try Task.checkCancellation()
            try self.mouseEventPoster(move)
            try await Task.sleep(nanoseconds: stepDelay)
        }
        try self.mouseEventPoster(up)
        needsRelease = false
    }

    private func rawMouseButton(down: Bool, at point: CGPoint, flags: CGEventFlags) throws {
        try self.mouseButtonEventPoster(down, point, flags)
    }

    private static func postMouseButtonEvent(
        _ down: Bool,
        _ point: CGPoint,
        _ flags: CGEventFlags) throws
    {
        let type: CGEventType = down ? .leftMouseDown : .leftMouseUp
        let event = try Self.makeMouseEvent(type, point, .left, 1, flags)
        try Self.postMouseEvent(event)
    }

    private static func makeMouseEvent(
        _ type: CGEventType,
        _ point: CGPoint,
        _ button: CGMouseButton,
        _ clickState: Int,
        _ flags: CGEventFlags) throws -> CGEvent
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
        return event
    }

    private static func postMouseEvent(_ event: CGEvent) throws {
        event.post(tap: .cghidEventTap)
    }

    /// Mirrors the pinned Peekaboo/AXorcist typing contract: iterate Swift
    /// graphemes, map newline/tab to their physical keys, and post Unicode for
    /// everything else. Both events are built before the first is posted.
    private static func postTextGrapheme(_ grapheme: Character) throws {
        let keyCode: CGKeyCode = switch grapheme {
        case "\n": 0x24
        case "\t": 0x30
        default: 0
        }
        guard let keyDown = CGEvent(
            keyboardEventSource: nil,
            virtualKey: keyCode,
            keyDown: true),
            let keyUp = CGEvent(
                keyboardEventSource: nil,
                virtualKey: keyCode,
                keyDown: false)
        else { throw ComputerActionError.eventCreationFailed }

        if grapheme != "\n", grapheme != "\t" {
            let utf16 = Array(String(grapheme).utf16)
            utf16.withUnsafeBufferPointer { buffer in
                guard let baseAddress = buffer.baseAddress else { return }
                keyDown.keyboardSetUnicodeString(
                    stringLength: buffer.count,
                    unicodeString: baseAddress)
                keyUp.keyboardSetUnicodeString(
                    stringLength: buffer.count,
                    unicodeString: baseAddress)
            }
        }

        keyDown.post(tap: .cghidEventTap)
        usleep(1000)
        keyUp.post(tap: .cghidEventTap)
    }

    #if DEBUG
    func rawClickForTesting(count: Int = 1) throws {
        try self.rawClick(at: .zero, button: .left, count: count, flags: [])
    }

    func rawDragForTesting() async throws {
        try await self.rawDrag(
            from: .zero,
            to: CGPoint(x: 24, y: 24),
            flags: [])
    }
    #endif

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

/// Parses a portable modifier string ("shift", "cmd+alt") into CGEvent flags.
struct ComputerModifiers {
    var flags: CGEventFlags

    var isEmpty: Bool {
        self.flags.isEmpty
    }

    static func parse(_ raw: String?) throws -> ComputerModifiers {
        guard let raw, !raw.isEmpty else { return ComputerModifiers(flags: []) }
        var flags: CGEventFlags = []
        for piece in raw.split(whereSeparator: { $0 == "+" || $0 == "," || $0 == " " }) {
            let key = piece.lowercased()
            switch key {
            case "cmd", "command", "meta", "super", "win", "windows":
                flags.insert(.maskCommand)
            case "shift":
                flags.insert(.maskShift)
            case "ctrl", "control":
                flags.insert(.maskControl)
            case "alt", "opt", "option":
                flags.insert(.maskAlternate)
            case "fn", "function":
                flags.insert(.maskSecondaryFn)
            default:
                // A typo like "shfit" would otherwise silently drop the modifier
                // and perform a materially different high-risk gesture (a plain
                // click instead of a modifier-click); reject it instead.
                throw ComputerActionService.ComputerActionError.invalidModifier(key)
            }
        }
        return ComputerModifiers(flags: flags)
    }
}
