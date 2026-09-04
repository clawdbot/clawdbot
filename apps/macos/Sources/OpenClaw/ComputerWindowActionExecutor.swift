import AppKit
import CoreGraphics
import Foundation
import OpenClawKit
import PeekabooAutomationKit
import PeekabooFoundation

extension CGRect {
    fileprivate var centerPoint: CGPoint {
        CGPoint(x: self.midX, y: self.midY)
    }
}

extension OpenClawComputerActParams {
    /// True when the request names a window, element, or observation, or asks for
    /// an action that has no screen-coordinate form. Such requests must run on
    /// `ComputerWindowActionExecutor`; everything else is screen-coordinate work.
    var isWindowScopedRequest: Bool {
        self.action.isWindowScopedOnly || self.windowRef != nil || self.elementRef != nil ||
            self.observationId != nil
    }
}

extension OpenClawComputerAction {
    /// True for actions that cannot be expressed as screen-coordinate input and
    /// therefore always need a window/element target.
    var isWindowScopedOnly: Bool {
        switch self {
        case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick, .mouseMove,
             .leftClickDrag, .leftMouseDown, .leftMouseUp, .scroll, .type, .key, .holdKey:
            false
        default:
            true
        }
    }
}

@MainActor
struct ComputerActionExecutionAuthority {
    let check: @MainActor () throws -> Void

    func run<Result>(_ operation: () async throws -> Result) async throws -> Result {
        try self.check()
        let result = try await operation()
        try self.check()
        return result
    }
}

/// Executes the window- and element-scoped half of `computer.act`: discovery,
/// app/window lifecycle, and accessibility-targeted input. Its peer
/// `ComputerScreenActionExecutor` owns the screen-coordinate half; both are
/// routed by `ComputerActionService`. All authority-bearing references are
/// process-local, execution-local, and invalidated when the native lifecycle
/// generation moves.
@MainActor
final class ComputerWindowActionExecutor {
    struct WindowTarget {
        let app: ServiceApplicationInfo
        let window: ServiceWindowInfo
    }

    struct ElementTarget {
        let id: String
        let bounds: CGRect
    }

    struct ObservationState {
        let id: String
        let windowRef: String
        let snapshotId: String
        let elements: [String: ElementTarget]
    }

    private let executionID = UUID().uuidString.lowercased()
    private let automation: UIAutomationService
    private let applications: ApplicationService
    private let windows: WindowManagementService
    private let menu: MenuService
    private let observationService: DesktopObservationService
    private let snapshotManager: InMemorySnapshotManager
    private var lifecycleGeneration: UInt64?
    private var appRefs: [String: ServiceApplicationInfo] = [:]
    private var windowRefs: [String: WindowTarget] = [:]
    private var observation: ObservationState?
    private var executionAuthority: ComputerActionExecutionAuthority?

    init() {
        let snapshotManager = InMemorySnapshotManager()
        let automation = UIAutomationService(snapshotManager: snapshotManager)
        let applications = ApplicationService()
        let menu = MenuService(applicationService: applications)
        self.automation = automation
        self.applications = applications
        self.windows = WindowManagementService(applicationService: applications)
        self.menu = menu
        self.snapshotManager = snapshotManager
        self.observationService = DesktopObservationService(
            screenCapture: ScreenCaptureService(loggingService: LoggingService()),
            automation: automation,
            applications: applications,
            menu: menu,
            snapshotManager: snapshotManager)
    }

    func perform(
        _ params: OpenClawComputerActParams,
        lifecycleGeneration: UInt64,
        checkExecutionAllowed: @escaping @MainActor () throws -> Void) async throws
        -> OpenClawComputerActResult
    {
        precondition(self.executionAuthority == nil)
        let authority = ComputerActionExecutionAuthority(check: checkExecutionAllowed)
        self.executionAuthority = authority
        defer { self.executionAuthority = nil }

        return try await authority.run {
            self.adoptLifecycleGeneration(lifecycleGeneration)
            switch params.action {
            case .listApps:
                return try await self.listApps()
            case .listWindows:
                return try await self.listWindows()
            case .getAccessibilityTree:
                return try await self.getAccessibilityTree(params)
            case .getCursorPosition:
                return self.getCursorPosition()
            case .getWindowState:
                return try await self.getWindowState(params)
            case .launchApp:
                return try await self.launchApp(params)
            case .killApp:
                return try await self.killApp(params)
            case .bringToFront:
                return try await self.bringToFront(params)
            case .setValue:
                return try await self.setValue(params)
            case .invokeMenu:
                return try await self.invokeMenu(params)
            case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick:
                return try await self.click(params)
            case .type:
                return try await self.type(params)
            case .key:
                return try await self.key(params)
            case .scroll:
                return try await self.scroll(params)
            case .mouseMove, .leftClickDrag, .leftMouseDown, .leftMouseUp, .holdKey:
                throw ComputerActionService.ComputerActionError.unsupportedAction(params.action)
            case .screenshot, .wait, .zoom, .getBrowserState, .browserPrepare, .browserNavigate,
                 .browserClick, .browserType, .browserDialog, .browserSetInputFiles, .browserDownload,
                 .browserPointer, .escalateScope, .getRecordingState, .startRecording, .stopRecording,
                 .replayTrajectory:
                throw ComputerActionService.ComputerActionError.unsupportedAction(params.action)
            }
        }
    }

    private func withExecutionAuthority<Result>(
        _ operation: () async throws -> Result) async throws -> Result
    {
        guard let executionAuthority = self.executionAuthority else {
            preconditionFailure("Computer action executed outside its queue authority")
        }
        return try await executionAuthority.run(operation)
    }

    // MARK: - Discovery and observation

    private func listApps() async throws -> OpenClawComputerActResult {
        let output = try await self.withExecutionAuthority {
            try await self.applications.listApplications()
        }
        self.appRefs.removeAll(keepingCapacity: true)
        let rows: [[String: Any]] = output.data.applications.prefix(500).map { app in
            let ref = self.issueRef("app")
            self.appRefs[ref] = app
            var row: [String: Any] = [
                "app": ref,
                "name": app.name,
                "running": true,
                "active": app.isActive,
                "pid": Int(app.processIdentifier),
            ]
            if let bundleIdentifier = app.bundleIdentifier {
                row["bundleId"] = bundleIdentifier
            }
            return row
        }
        return OpenClawComputerActResult(ok: true, details: [
            "apps": AnyCodable(rows),
            "totalApps": AnyCodable(output.data.applications.count),
            "truncatedApps": AnyCodable(max(0, output.data.applications.count - rows.count)),
        ])
    }

    private func listWindows() async throws -> OpenClawComputerActResult {
        let appOutput = try await self.withExecutionAuthority {
            try await self.applications.listApplications()
        }
        var rows: [[String: Any]] = []
        var warnings = appOutput.metadata.warnings
        outer: for app in appOutput.data.applications
            where app.windowCount > 0 || app.windowIDs?.isEmpty == false
        {
            do {
                let output = try await self.withExecutionAuthority {
                    try await self.applications.listWindows(
                        for: "PID:\(app.processIdentifier)",
                        timeout: nil)
                }
                warnings.append(contentsOf: output.metadata.warnings)
                for window in output.data.windows where window.layer == 0 {
                    rows.append([
                        "windowRef": self.issueWindowRef(app: app, window: window),
                        "appName": app.name,
                        "title": window.title,
                        "bounds": Self.boundsDictionary(window.bounds),
                        "isOnScreen": window.isOnScreen,
                        "minimized": window.isMinimized,
                    ])
                    if rows.count == 500 { break outer }
                }
            } catch {
                warnings.append("\(app.name): \(error.localizedDescription)")
            }
        }
        var details: [String: AnyCodable] = ["windows": AnyCodable(rows)]
        if !warnings.isEmpty {
            details["warnings"] = AnyCodable(Array(warnings.prefix(64)))
        }
        return OpenClawComputerActResult(ok: true, details: details)
    }

    private func getAccessibilityTree(
        _ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult
    {
        let limits = try Self.observationLimits(params)
        let context: WindowContext? = try params.windowRef.map { ref in
            let target = try self.resolveWindow(ref)
            return Self.windowContext(target, limits: limits)
        }
        let result = try await self.withExecutionAuthority {
            try await self.automation.inspectAccessibilityTree(windowContext: context)
        }
        let projected = Self.projectElements(
            result.elements.all,
            query: params.query,
            limit: limits.maxElements)
        var details: [String: AnyCodable] = [
            "elements": AnyCodable(projected.elements),
            "totalElementCount": AnyCodable(result.elements.all.count),
        ]
        if projected.truncated > 0 {
            details["truncatedElements"] = AnyCodable(projected.truncated)
        }
        if !result.metadata.warnings.isEmpty {
            details["warnings"] = AnyCodable(Array(result.metadata.warnings.prefix(64)))
        }
        return OpenClawComputerActResult(ok: true, details: details)
    }

    private func getCursorPosition() -> OpenClawComputerActResult {
        let point = self.automation.currentMouseLocation() ?? .zero
        return OpenClawComputerActResult(ok: true, details: [
            "x": AnyCodable(Double(point.x)),
            "y": AnyCodable(Double(point.y)),
        ])
    }

    private func getWindowState(
        _ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult
    {
        let windowRef = try Self.require(params.windowRef, field: "windowRef")
        let target = try self.resolveWindow(windowRef)
        let limits = try Self.observationLimits(params)
        guard let windowID = CGWindowID(exactly: target.window.windowID) else {
            throw ComputerActionService.ComputerActionError.staleObservation
        }
        let request = DesktopObservationRequest(
            target: .windowID(windowID),
            capture: DesktopCaptureOptions(focus: .background),
            detection: DesktopDetectionOptions(
                mode: .accessibility,
                traversalBudget: AXTraversalBudget(
                    maxDepth: limits.depth,
                    maxElementCount: limits.maxElements,
                    maxChildrenPerNode: AXTraversalBudget.defaultMaxChildrenPerNode)))
        let result = try await self.withExecutionAuthority {
            try await self.observationService.observe(request)
        }
        if let elements = result.elements {
            try await self.withExecutionAuthority {
                try await self.snapshotManager.storeDetectionResult(
                    snapshotId: elements.snapshotId,
                    result: elements)
            }
        }
        let observedWindow = result.capture.metadata.windowInfo ?? target.window
        guard observedWindow.windowID == target.window.windowID else {
            throw ComputerActionService.ComputerActionError.staleObservation
        }
        self.windowRefs[windowRef] = WindowTarget(app: target.app, window: observedWindow)
        let detected = result.elements?.elements.all ?? []
        let filtered = Self.filterElements(detected, query: params.query)
        let bounded = Array(filtered.prefix(limits.maxElements))
        let snapshotID = result.elements?.snapshotId ?? ""
        guard !snapshotID.isEmpty else {
            throw ComputerActionService.ComputerActionError.refused(
                "Peekaboo observation returned no snapshot receipt")
        }
        let issued = self.issueObservation(
            windowRef: windowRef,
            snapshotId: snapshotID,
            elements: bounded.map { ElementTarget(id: $0.id, bounds: $0.bounds) })
        let elements = zip(bounded, issued.elementRefs).map { element, ref in
            OpenClawComputerObservationElement(
                elementRef: ref,
                role: element.type.rawValue,
                label: element.label,
                value: element.value,
                bounds: Self.bounds(element.bounds))
        }
        var details: [String: AnyCodable] = [
            "totalElementCount": AnyCodable(detected.count),
            "coordinateSpace": AnyCodable("global-logical-points"),
        ]
        if filtered.count > bounded.count {
            details["truncatedElements"] = AnyCodable(filtered.count - bounded.count)
        }
        if !result.diagnostics.warnings.isEmpty {
            details["warnings"] = AnyCodable(Array(result.diagnostics.warnings.prefix(64)))
        }
        let size = result.capture.metadata.size
        guard size.width >= 1, size.height >= 1 else {
            throw ComputerActionService.ComputerActionError.refused(
                "Peekaboo observation returned an invalid image size")
        }
        return OpenClawComputerActResult(
            ok: true,
            observation: OpenClawComputerObservation(
                kind: "window",
                base64: result.capture.imageData.base64EncodedString(),
                format: "png",
                width: Int(size.width),
                height: Int(size.height),
                observationId: issued.id,
                elements: elements.isEmpty ? nil : elements),
            details: details)
    }

    // MARK: - Lifecycle

    private func launchApp(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        let appValue = try Self.require(params.app, field: "app")
        let target = self.appRefs[appValue]
        if appValue.hasPrefix("peekaboo:v2:app:"), target == nil {
            throw ComputerActionService.ComputerActionError.staleObservation
        }
        let launched = try await self.withExecutionAuthority {
            try await self.applications.launchApplication(request: ApplicationLaunchRequest(
                applicationIdentifier: target?.bundleIdentifier ?? target?.name ?? appValue,
                activates: true,
                waitUntilReady: true,
                waitForWindow: true))
        }
        return OpenClawComputerActResult(ok: true, effect: .confirmed, details: [
            "name": AnyCodable(launched.name),
            "pid": AnyCodable(Int(launched.processIdentifier)),
        ])
    }

    private func killApp(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        let appRef = try Self.require(params.app, field: "app")
        guard let app = self.appRefs[appRef], let identity = app.processIdentity else {
            throw ComputerActionService.ComputerActionError.invalidRequest(
                "kill_app requires a running app reference from list_apps")
        }
        let quit = try await self.withExecutionAuthority {
            try await self.applications.quitApplication(request: ApplicationQuitRequest(
                identifier: "PID:\(app.processIdentifier)",
                force: false,
                expectedIdentity: identity))
        }
        return OpenClawComputerActResult(
            ok: quit,
            effect: quit ? .confirmed : .suspectedNoop,
            details: ["app": AnyCodable(appRef)])
    }

    private func bringToFront(
        _ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult
    {
        let target = try self.requiredWindow(params)
        try await self.focus(target)
        let focused = try await self.withExecutionAuthority {
            try await self.windows.getFocusedWindow()
        }
        let confirmed = focused?.windowID == target.window.windowID
        return OpenClawComputerActResult(
            ok: confirmed,
            effect: confirmed ? .confirmed : .suspectedNoop,
            escalation: confirmed ? nil : OpenClawComputerEscalation(
                recommended: "desktop",
                reasonCode: "foreground_ineffective"))
    }

    // MARK: - Input

    private func click(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        let target = try self.requiredWindow(params)
        let resolved = try self.clickTarget(params, windowRef: Self.require(params.windowRef, field: "windowRef"))
        let mode = params.deliveryMode ?? .background
        if mode == .foreground {
            try await self.focus(target)
            guard target.window.bounds.contains(resolved.point) else {
                throw ComputerActionService.ComputerActionError.invalidRequest(
                    "foreground click target is outside the selected window")
            }
            try Self.postForegroundClick(
                at: resolved.point,
                action: params.action,
                modifiers: params.modifiers)
            return OpenClawComputerActResult(ok: true, effect: .unverifiable, details: [
                "deliveryMode": AnyCodable("foreground"),
                "route": AnyCodable("global_events"),
            ])
        }
        guard params.action != .middleClick, params.action != .tripleClick else {
            return Self.backgroundEscalation(reason: "background_click_variant_unavailable")
        }
        guard let identity = target.window.mutationIdentity else {
            throw ComputerActionService.ComputerActionError.staleObservation
        }
        let clickType: ClickType = switch params.action {
        case .rightClick: .right
        case .doubleClick: .double
        default: .single
        }
        do {
            let result = try await self.withExecutionAuthority {
                try await self.automation.clickWithOutcome(
                    target: resolved.target,
                    clickType: clickType,
                    snapshotId: resolved.snapshotId,
                    expectedWindowIdentity: identity,
                    expectedWindowBounds: target.window.bounds)
            }
            return Self.result(from: result.outcome, background: true)
        } catch let failure as DesktopActionFailure {
            return Self.failureResult(failure, background: true)
        }
    }

    private func type(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        let text = try Self.require(params.text, field: "text", allowEmpty: false)
        let target = try self.requiredWindow(params)
        let mode = params.deliveryMode ?? .background
        if let elementRef = params.elementRef {
            let focusResult = try await self.focusElement(
                elementRef,
                params: params,
                target: target,
                foreground: mode == .foreground)
            if !focusResult.ok { return focusResult }
        }
        do {
            let result: UIAutomationActionResult<TypeResult>
            if mode == .foreground {
                try await self.focus(target)
                result = try await self.withExecutionAuthority {
                    try await self.automation.typeActionsWithOutcome(
                        [.text(text)], cadence: .fixed(milliseconds: 0), snapshotId: nil)
                }
            } else {
                guard let identity = target.window.mutationIdentity else {
                    throw ComputerActionService.ComputerActionError.staleObservation
                }
                result = try await self.withExecutionAuthority {
                    try await self.automation.typeActionsWithOutcome(
                        [.text(text)],
                        cadence: .fixed(milliseconds: 0),
                        snapshotId: params.elementRef == nil ? nil : self.observation?.snapshotId,
                        expectedWindowIdentity: identity,
                        expectedWindowBounds: target.window.bounds)
                }
            }
            return Self.result(from: result.outcome, background: mode == .background)
        } catch let failure as DesktopActionFailure {
            return Self.failureResult(failure, background: mode == .background)
        }
    }

    private func key(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        let keys = try Self.require(params.keys, field: "keys", allowEmpty: false)
        let target = try self.requiredWindow(params)
        let mode = params.deliveryMode ?? .background
        if let elementRef = params.elementRef {
            let focusResult = try await self.focusElement(
                elementRef,
                params: params,
                target: target,
                foreground: mode == .foreground)
            if !focusResult.ok { return focusResult }
        }
        do {
            let result: UIAutomationActionResult<Void>
            if mode == .foreground {
                try await self.focus(target)
                result = try await self.withExecutionAuthority {
                    try await self.automation.hotkeyWithOutcome(keys: keys, holdDuration: 0)
                }
            } else {
                guard let identity = target.window.mutationIdentity else {
                    throw ComputerActionService.ComputerActionError.staleObservation
                }
                result = try await self.withExecutionAuthority {
                    try await self.automation.hotkeyWithOutcome(
                        keys: keys,
                        holdDuration: 0,
                        expectedWindowIdentity: identity,
                        expectedWindowBounds: target.window.bounds)
                }
            }
            return Self.result(from: result.outcome, background: mode == .background)
        } catch let failure as DesktopActionFailure {
            return Self.failureResult(failure, background: mode == .background)
        }
    }

    private func setValue(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        guard params.deliveryMode != .foreground else {
            throw ComputerActionService.ComputerActionError.unsupportedAction(params.action)
        }
        let windowRef = try Self.require(params.windowRef, field: "windowRef")
        _ = try self.resolveWindow(windowRef)
        let element = try self.requiredElement(params, windowRef: windowRef)
        let value = try Self.require(params.value, field: "value", allowEmpty: true)
        do {
            let result = try await self.withExecutionAuthority {
                try await self.automation.setValueWithOutcome(
                    target: element.id,
                    value: .string(value),
                    snapshotId: self.observation?.snapshotId)
            }
            return Self.result(from: result.outcome, background: true)
        } catch let failure as DesktopActionFailure {
            return Self.failureResult(failure, background: true)
        }
    }

    private func invokeMenu(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        guard params.deliveryMode != .foreground else {
            throw ComputerActionService.ComputerActionError.unsupportedAction(params.action)
        }
        let target = try self.requiredWindow(params)
        guard let path = params.path, !path.isEmpty, path.count <= 16,
              path.allSatisfy({ !$0.isEmpty && $0.count <= 200 })
        else {
            throw ComputerActionService.ComputerActionError.invalidRequest(
                "path must contain 1 to 16 non-empty menu components")
        }
        try await self.withExecutionAuthority {
            try await self.menu.clickMenuItem(
                app: "PID:\(target.app.processIdentifier)",
                itemPath: path.joined(separator: " > "))
        }
        return OpenClawComputerActResult(ok: true, effect: .unverifiable, details: [
            "deliveryMode": AnyCodable("background"),
            "route": AnyCodable("accessibility_action"),
        ])
    }

    private func scroll(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        let windowRef = try Self.require(params.windowRef, field: "windowRef")
        let target = try self.resolveWindow(windowRef)
        guard let direction = params.scrollDirection else {
            throw ComputerActionService.ComputerActionError.invalidRequest(
                "scrollDirection is required for scroll")
        }
        let mode = params.deliveryMode ?? .background
        let element = try params.elementRef.map { _ in try self.requiredElement(params, windowRef: windowRef) }
        if mode == .background, element == nil {
            return Self.backgroundEscalation(reason: "background_scroll_requires_element")
        }
        if mode == .foreground {
            try await self.focus(target)
            if let point = try self.optionalPoint(params, windowRef: windowRef) {
                try await self.withExecutionAuthority {
                    try await self.automation.moveMouse(to: point, duration: 0, steps: 1, profile: .linear)
                }
            }
        }
        let result = try await self.withExecutionAuthority {
            try await self.automation.scrollWithOutcome(ScrollRequest(
                direction: Self.scrollDirection(direction),
                amount: min(100, max(1, params.scrollAmount ?? 3)),
                target: element?.id,
                snapshotId: element == nil ? nil : self.observation?.snapshotId,
                foreground: mode == .foreground))
        }
        return Self.result(from: result.outcome, background: mode == .background)
    }

    // MARK: - Reference and target helpers

    func adoptLifecycleGeneration(_ generation: UInt64) {
        guard self.lifecycleGeneration != generation else { return }
        self.lifecycleGeneration = generation
        self.appRefs.removeAll()
        self.windowRefs.removeAll()
        self.observation = nil
    }

    /// A window ref names one live window for the whole lifecycle generation and
    /// keys on stable identity only: WindowServer id plus the owner process
    /// generation that guards pid reuse. Bounds and minimized state stay out —
    /// they belong to the per-action expected-identity check — so a window that
    /// moves, resizes, or minimizes keeps its ref and has its stored target
    /// refreshed here, and later checks compare against the live window.
    func issueWindowRef(app: ServiceApplicationInfo, window: ServiceWindowInfo) -> String {
        let ref = self.windowRefs.first { Self.sameWindow($0.value.window, window) }?.key
            ?? self.issueRef("window")
        self.windowRefs[ref] = WindowTarget(app: app, window: window)
        return ref
    }

    func resolveWindow(_ ref: String) throws -> WindowTarget {
        guard let target = self.windowRefs[ref] else {
            throw ComputerActionService.ComputerActionError.staleObservation
        }
        return target
    }

    /// Only the newest observation may authorize element work, so issuing one
    /// supersedes every element ref handed out by the previous observation.
    func issueObservation(
        windowRef: String,
        snapshotId: String,
        elements: [ElementTarget]) -> (id: String, elementRefs: [String])
    {
        let id = self.issueRef("observation")
        let elementRefs = elements.map { _ in self.issueRef("element") }
        self.observation = ObservationState(
            id: id,
            windowRef: windowRef,
            snapshotId: snapshotId,
            elements: Dictionary(uniqueKeysWithValues: zip(elementRefs, elements)))
        return (id, elementRefs)
    }

    func resolveObservation(_ id: String?, windowRef: String) throws -> ObservationState {
        guard let observation = self.observation,
              observation.id == id,
              observation.windowRef == windowRef
        else {
            throw ComputerActionService.ComputerActionError.staleObservation
        }
        return observation
    }

    func resolveElement(_ ref: String, observation: ObservationState) throws -> ElementTarget {
        guard let element = observation.elements[ref] else {
            throw ComputerActionService.ComputerActionError.staleObservation
        }
        return element
    }

    private func issueRef(_ kind: String) -> String {
        "peekaboo:v2:\(kind):\(self.executionID):\(self.lifecycleGeneration ?? 0):" +
            UUID().uuidString.lowercased()
    }

    private static func sameWindow(_ lhs: ServiceWindowInfo, _ rhs: ServiceWindowInfo) -> Bool {
        guard let left = lhs.mutationIdentity, let right = rhs.mutationIdentity else { return false }
        return left.windowID == right.windowID && left.processIdentity == right.processIdentity
    }

    private func requiredWindow(_ params: OpenClawComputerActParams) throws -> WindowTarget {
        try self.resolveWindow(Self.require(params.windowRef, field: "windowRef"))
    }

    private func requiredElement(
        _ params: OpenClawComputerActParams,
        windowRef: String) throws -> ElementTarget
    {
        let elementRef = try Self.require(params.elementRef, field: "elementRef")
        let observation = try self.resolveObservation(params.observationId, windowRef: windowRef)
        return try self.resolveElement(elementRef, observation: observation)
    }

    private func clickTarget(
        _ params: OpenClawComputerActParams,
        windowRef: String) throws -> (target: ClickTarget, point: CGPoint, snapshotId: String)
    {
        let observation = try self.resolveObservation(params.observationId, windowRef: windowRef)
        if params.elementRef != nil {
            let element = try self.requiredElement(params, windowRef: windowRef)
            return (.elementId(element.id), element.bounds.centerPoint, observation.snapshotId)
        }
        guard let x = params.x, let y = params.y else {
            throw ComputerActionService.ComputerActionError.invalidRequest(
                "coordinates or elementRef are required for \(params.action.rawValue)")
        }
        guard x >= 0, y >= 0 else {
            throw ComputerActionService.ComputerActionError.invalidRequest(
                "coordinates must be nonnegative")
        }
        let point = CGPoint(x: x, y: y)
        return (.coordinates(point), point, observation.snapshotId)
    }

    private func optionalPoint(
        _ params: OpenClawComputerActParams,
        windowRef: String) throws -> CGPoint?
    {
        if params.elementRef != nil {
            return try self.requiredElement(params, windowRef: windowRef).bounds.centerPoint
        }
        if params.x == nil, params.y == nil { return nil }
        guard let x = params.x, let y = params.y else {
            throw ComputerActionService.ComputerActionError.invalidRequest(
                "both x and y are required")
        }
        guard x >= 0, y >= 0 else {
            throw ComputerActionService.ComputerActionError.invalidRequest(
                "coordinates must be nonnegative")
        }
        _ = try self.resolveObservation(params.observationId, windowRef: windowRef)
        return CGPoint(x: x, y: y)
    }

    private func focusElement(
        _ elementRef: String,
        params: OpenClawComputerActParams,
        target: WindowTarget,
        foreground: Bool) async throws -> OpenClawComputerActResult
    {
        let windowRef = try Self.require(params.windowRef, field: "windowRef")
        let observation = try self.resolveObservation(params.observationId, windowRef: windowRef)
        let element = try self.resolveElement(elementRef, observation: observation)
        if foreground {
            try await self.focus(target)
            try Self.postForegroundClick(at: element.bounds.centerPoint, action: .leftClick, modifiers: nil)
            return OpenClawComputerActResult(ok: true, effect: .unverifiable)
        }
        guard let identity = target.window.mutationIdentity else {
            throw ComputerActionService.ComputerActionError.staleObservation
        }
        let result = try await self.withExecutionAuthority {
            try await self.automation.clickWithOutcome(
                target: .elementId(element.id),
                clickType: .single,
                snapshotId: observation.snapshotId,
                expectedWindowIdentity: identity,
                expectedWindowBounds: target.window.bounds)
        }
        return Self.result(from: result.outcome, background: true)
    }

    private func focus(_ target: WindowTarget) async throws {
        try await self.withExecutionAuthority {
            try await self.applications.activateApplication(request: ApplicationActivationRequest(
                application: target.app))
        }
        try await self.withExecutionAuthority {
            try await self.windows.focusWindow(target: .windowId(target.window.windowID))
        }
    }
}

// MARK: - Projection and outcomes

extension ComputerWindowActionExecutor {
    private static func result(
        from outcome: DesktopActionOutcome?,
        background: Bool) -> OpenClawComputerActResult
    {
        guard let outcome else {
            return OpenClawComputerActResult(ok: true, effect: .unverifiable)
        }
        if outcome.effect == .refused {
            return background
                ? self.backgroundEscalation(reason: outcome.refusalReason?.rawValue ?? "action_refused")
                : OpenClawComputerActResult(
                    ok: false,
                    effect: .suspectedNoop,
                    escalation: OpenClawComputerEscalation(
                        recommended: "desktop",
                        reasonCode: "foreground_ineffective"))
        }
        let effect: OpenClawComputerActionEffect = switch outcome.effect {
        case .confirmed: .confirmed
        case .suspectedNoop: .suspectedNoop
        case .partial, .unverifiable, .refused: .unverifiable
        }
        let escalation = background && outcome.effect == .suspectedNoop
            ? OpenClawComputerEscalation(recommended: "foreground", reasonCode: "suspected_noop")
            : nil
        var details: [String: AnyCodable] = [
            "route": AnyCodable(outcome.delivery?.mechanism.rawValue ?? "unknown"),
            "evidence": AnyCodable(outcome.evidence.rawValue),
        ]
        if let delivery = outcome.delivery {
            details["deliveryMode"] = AnyCodable(delivery.mode.rawValue)
        }
        return OpenClawComputerActResult(
            ok: outcome.effect != .suspectedNoop,
            effect: effect,
            escalation: escalation,
            details: details)
    }

    private static func failureResult(
        _ failure: DesktopActionFailure,
        background: Bool) -> OpenClawComputerActResult
    {
        let result = self.result(from: failure.outcome, background: background)
        return OpenClawComputerActResult(
            ok: false,
            effect: result.effect ?? .unverifiable,
            escalation: background
                ? OpenClawComputerEscalation(
                    recommended: "foreground",
                    reasonCode: failure.outcome.effect == .suspectedNoop
                        ? "suspected_noop"
                        : "background_delivery_failed")
                : nil,
            details: ["message": AnyCodable(failure.message)])
    }

    private static func backgroundEscalation(reason: String) -> OpenClawComputerActResult {
        OpenClawComputerActResult(
            ok: false,
            effect: .suspectedNoop,
            escalation: OpenClawComputerEscalation(
                recommended: "foreground",
                reasonCode: reason))
    }

    private static func filterElements(
        _ elements: [DetectedElement],
        query: String?) -> [DetectedElement]
    {
        guard let query = query?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !query.isEmpty
        else { return elements }
        return elements.filter { element in
            [element.id, element.type.rawValue, element.label, element.value]
                .compactMap { $0?.lowercased() }
                .contains { $0.contains(query) }
        }
    }

    private static func projectElements(
        _ elements: [DetectedElement],
        query: String?,
        limit: Int) -> (elements: [[String: Any]], truncated: Int)
    {
        let filtered = self.filterElements(elements, query: query)
        return (
            Array(filtered.prefix(limit)).map { element in
                var row: [String: Any] = [
                    "role": element.type.rawValue,
                    "bounds": self.boundsDictionary(element.bounds),
                ]
                if let label = element.label { row["label"] = label }
                if let value = element.value { row["value"] = value }
                return row
            },
            max(0, filtered.count - limit))
    }

    private static func windowContext(
        _ target: WindowTarget,
        limits: (depth: Int, maxElements: Int)) -> WindowContext
    {
        WindowContext(
            applicationName: target.app.name,
            applicationBundleId: target.app.bundleIdentifier,
            applicationProcessId: target.app.processIdentifier,
            windowTitle: target.window.title,
            windowID: target.window.windowID,
            windowBounds: target.window.bounds,
            windowMutationIdentity: target.window.mutationIdentity,
            traversalBudget: AXTraversalBudget(
                maxDepth: limits.depth,
                maxElementCount: limits.maxElements,
                maxChildrenPerNode: AXTraversalBudget.defaultMaxChildrenPerNode),
            requiresFreshAccessibilityTree: true)
    }

    private static func observationLimits(
        _ params: OpenClawComputerActParams) throws -> (depth: Int, maxElements: Int)
    {
        let depth = params.depth ?? AXTraversalBudget.defaultMaxDepth
        let maxElements = params.maxElements ?? AXTraversalBudget.defaultMaxElementCount
        guard (0...64).contains(depth), (1...2000).contains(maxElements) else {
            throw ComputerActionService.ComputerActionError.invalidRequest(
                "depth must be 0...64 and maxElements must be 1...2000")
        }
        return (depth, maxElements)
    }

    private static func require(
        _ value: String?,
        field: String,
        allowEmpty: Bool = false) throws -> String
    {
        guard let value, allowEmpty || !value.isEmpty else {
            throw ComputerActionService.ComputerActionError.invalidRequest(
                "\(field) is required")
        }
        return value
    }

    private static func bounds(_ rect: CGRect) -> OpenClawComputerBounds {
        OpenClawComputerBounds(
            x: Double(rect.origin.x),
            y: Double(rect.origin.y),
            width: max(0, Double(rect.width)),
            height: max(0, Double(rect.height)))
    }

    private static func boundsDictionary(_ rect: CGRect) -> [String: Any] {
        [
            "x": Double(rect.origin.x),
            "y": Double(rect.origin.y),
            "width": max(0, Double(rect.width)),
            "height": max(0, Double(rect.height)),
        ]
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

    private static func postForegroundClick(
        at point: CGPoint,
        action: OpenClawComputerAction,
        modifiers: String?) throws
    {
        guard CGPreflightPostEventAccess() else {
            throw ComputerActionService.ComputerActionError.postEventAccessDenied
        }
        let button: CGMouseButton = action == .middleClick ? .center : action == .rightClick ? .right : .left
        let downType: CGEventType = button == .center ? .otherMouseDown : button == .right ? .rightMouseDown :
            .leftMouseDown
        let upType: CGEventType = button == .center ? .otherMouseUp : button == .right ? .rightMouseUp : .leftMouseUp
        let count = action == .tripleClick ? 3 : action == .doubleClick ? 2 : 1
        let flags = try self.modifierFlags(modifiers)
        for index in 1...count {
            guard let down = CGEvent(
                mouseEventSource: nil,
                mouseType: downType,
                mouseCursorPosition: point,
                mouseButton: button),
                let up = CGEvent(
                    mouseEventSource: nil,
                    mouseType: upType,
                    mouseCursorPosition: point,
                    mouseButton: button)
            else {
                throw ComputerActionService.ComputerActionError.refused(
                    "failed to construct foreground click")
            }
            down.flags = flags
            up.flags = flags
            down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    private static func modifierFlags(_ raw: String?) throws -> CGEventFlags {
        var flags: CGEventFlags = []
        for token in (raw ?? "")
            .lowercased()
            .split(whereSeparator: { $0 == "," || $0 == "+" || $0.isWhitespace })
        {
            switch token {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option": flags.insert(.maskAlternate)
            case "fn", "function": flags.insert(.maskSecondaryFn)
            default:
                throw ComputerActionService.ComputerActionError.invalidRequest(
                    "unsupported modifier '\(token)'")
            }
        }
        return flags
    }
}
