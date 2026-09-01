import ApplicationServices
import CoreGraphics
import Foundation
import OpenClawKit

/// Linearizes caller cancellation against action completion outside MainActor.
/// The cancellation handler must record authority loss synchronously; its actor
/// hop is only a best-effort fast path for canceling work and releasing input.
private final class ComputerActionCancellationState: @unchecked Sendable {
    private enum Phase {
        case active
        case cancelled
        case completed
    }

    private let lock = NSLock()
    private var phase: Phase = .active
    private var operationReleaseSucceeded = false

    var isCancelled: Bool {
        self.lock.withLock { self.phase == .cancelled }
    }

    func requestCancellation() -> Bool {
        self.lock.withLock {
            guard self.phase == .active else { return false }
            self.phase = .cancelled
            return true
        }
    }

    func recordOperationReleaseSuccess() {
        self.lock.withLock {
            guard self.phase == .cancelled else { return }
            self.operationReleaseSucceeded = true
        }
    }

    func finish() -> (wasCancelled: Bool, needsRelease: Bool) {
        self.lock.withLock {
            let wasCancelled = self.phase == .cancelled
            let needsRelease = wasCancelled && !self.operationReleaseSucceeded
            self.phase = .completed
            return (wasCancelled, needsRelease)
        }
    }
}

/// Serializes native computer actions and carries the runtime lifecycle epoch
/// across the actor hop. A newer epoch releases held input and invalidates every
/// older queued or suspended action before another action can start.
@MainActor
final class ComputerActionExecutionQueue {
    typealias Operation = @MainActor (OpenClawComputerActParams, UInt64) async throws
        -> OpenClawComputerActResult
    typealias CancellationHop = @Sendable (
        @escaping @MainActor @Sendable () -> Void) -> Void

    private struct QueuedAction {
        let id: UUID
        let params: OpenClawComputerActParams
        let lifecycleGeneration: UInt64
        let operation: Operation
        let continuation: CheckedContinuation<OpenClawComputerActResult, Error>
        let cancellationState: ComputerActionCancellationState
    }

    private let onLifecycleRelease: @MainActor () -> Bool
    private let scheduleCancellationHop: CancellationHop
    private var lifecycleGeneration: UInt64 = 0
    private var pendingActions: [QueuedAction] = []
    private var drainTask: Task<Void, Never>?
    private var currentActionID: UUID?
    private var currentActionGeneration: UInt64?
    private var currentActionCancellationState: ComputerActionCancellationState?
    private var currentActionTask: Task<OpenClawComputerActResult, Error>?
    private var lifecycleReleasePending = false

    init(
        onLifecycleRelease: @escaping @MainActor () -> Bool,
        scheduleCancellationHop: @escaping CancellationHop = { operation in
            Task { @MainActor in operation() }
        })
    {
        self.onLifecycleRelease = onLifecycleRelease
        self.scheduleCancellationHop = scheduleCancellationHop
    }

    func perform(
        _ params: OpenClawComputerActParams,
        lifecycleGeneration: UInt64,
        operation: @escaping Operation) async throws -> OpenClawComputerActResult
    {
        let actionID = UUID()
        let cancellationState = ComputerActionCancellationState()
        if lifecycleGeneration > self.lifecycleGeneration {
            self.advanceLifecycle(to: lifecycleGeneration)
        }
        guard lifecycleGeneration == self.lifecycleGeneration else {
            throw ComputerActionService.ComputerActionError.lifecycleChanged
        }
        try await self.waitForLifecycleRelease(lifecycleGeneration: lifecycleGeneration)
        try Task.checkCancellation()
        let scheduleCancellationHop = self.scheduleCancellationHop

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled, !cancellationState.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.pendingActions.append(QueuedAction(
                    id: actionID,
                    params: params,
                    lifecycleGeneration: lifecycleGeneration,
                    operation: operation,
                    continuation: continuation,
                    cancellationState: cancellationState))
                self.startDrainIfNeeded()
            }
        } onCancel: {
            guard cancellationState.requestCancellation() else { return }
            scheduleCancellationHop { @MainActor [weak self] in
                self?.cancelAction(id: actionID)
            }
        }
    }

    func releaseHeldInput(lifecycleGeneration: UInt64) async {
        guard lifecycleGeneration > self.lifecycleGeneration else { return }
        let activeTask = self.currentActionTask
        self.advanceLifecycle(to: lifecycleGeneration)
        if let activeTask {
            // Cancellation is cooperative. Do not let a replacement route install
            // while an old operation can still post input. The operation task's
            // lifecycle defer performs the scoped catch-up button release.
            _ = try? await activeTask.value
        }
        try? await self.waitForLifecycleRelease(lifecycleGeneration: lifecycleGeneration)
    }

    func checkExecutionAllowed(lifecycleGeneration: UInt64) throws {
        try Task.checkCancellation()
        guard self.currentActionCancellationState?.isCancelled != true else {
            throw CancellationError()
        }
        guard lifecycleGeneration == self.lifecycleGeneration else {
            throw ComputerActionService.ComputerActionError.lifecycleChanged
        }
    }

    #if DEBUG
    var pendingActionCountForTesting: Int {
        self.pendingActions.count
    }

    var lifecycleGenerationForTesting: UInt64 {
        self.lifecycleGeneration
    }
    #endif

    private func startDrainIfNeeded() {
        guard self.drainTask == nil else { return }
        self.drainTask = Task { @MainActor [weak self] in
            await self?.drain()
        }
    }

    private func drain() async {
        while !self.pendingActions.isEmpty {
            let queued = self.pendingActions.removeFirst()
            guard queued.lifecycleGeneration == self.lifecycleGeneration else {
                _ = queued.cancellationState.finish()
                queued.continuation.resume(
                    throwing: ComputerActionService.ComputerActionError.lifecycleChanged)
                continue
            }
            do {
                try await self.waitForLifecycleRelease(
                    lifecycleGeneration: queued.lifecycleGeneration,
                    cancellationState: queued.cancellationState)
            } catch {
                _ = queued.cancellationState.finish()
                queued.continuation.resume(throwing: error)
                continue
            }
            guard !queued.cancellationState.isCancelled else {
                _ = queued.cancellationState.finish()
                queued.continuation.resume(throwing: CancellationError())
                continue
            }

            self.currentActionID = queued.id
            self.currentActionGeneration = queued.lifecycleGeneration
            self.currentActionCancellationState = queued.cancellationState
            let operationTask = Task { @MainActor [weak self] in
                guard let self else { throw CancellationError() }
                defer {
                    // An operation can ignore cancellation and arm a button after
                    // advanceLifecycle's immediate release. Catch it here, before
                    // this task completes and the drain admits newer-generation work.
                    let callerCancelled = queued.cancellationState.isCancelled
                    if Task.isCancelled || callerCancelled
                        || queued.lifecycleGeneration != self.lifecycleGeneration
                    {
                        let released = self.attemptLifecycleRelease()
                        if callerCancelled, released {
                            queued.cancellationState.recordOperationReleaseSuccess()
                        }
                    }
                }
                guard !queued.cancellationState.isCancelled else { throw CancellationError() }
                try Task.checkCancellation()
                return try await queued.operation(queued.params, queued.lifecycleGeneration)
            }
            self.currentActionTask = operationTask

            let outcome: Result<OpenClawComputerActResult, Error>
            do {
                outcome = try await .success(operationTask.value)
            } catch {
                outcome = .failure(error)
            }

            let cancellation = queued.cancellationState.finish()
            if cancellation.needsRelease {
                // Cancellation can win after the operation defer but before the
                // result is committed. Release here so the actor hop cannot miss
                // a just-finished left_mouse_down.
                self.attemptLifecycleRelease()
            }
            if cancellation.wasCancelled {
                // A failed synthetic mouse-up keeps lifecycleReleasePending set.
                // Cancellation is not complete until the owned button is released
                // or a newer lifecycle takes responsibility for the retry.
                try? await self.waitForLifecycleRelease(
                    lifecycleGeneration: queued.lifecycleGeneration)
            }
            let lifecycleChanged = queued.lifecycleGeneration != self.lifecycleGeneration
            self.currentActionID = nil
            self.currentActionGeneration = nil
            self.currentActionCancellationState = nil
            self.currentActionTask = nil

            if lifecycleChanged {
                queued.continuation.resume(
                    throwing: ComputerActionService.ComputerActionError.lifecycleChanged)
            } else if cancellation.wasCancelled {
                queued.continuation.resume(throwing: CancellationError())
            } else {
                queued.continuation.resume(with: outcome)
            }
        }
        self.drainTask = nil
    }

    private func advanceLifecycle(to generation: UInt64) {
        guard generation > self.lifecycleGeneration else { return }
        self.lifecycleGeneration = generation

        if let currentActionGeneration, currentActionGeneration < generation {
            self.currentActionTask?.cancel()
        }
        self.attemptLifecycleRelease()

        let staleActions = self.pendingActions.filter { $0.lifecycleGeneration < generation }
        self.pendingActions.removeAll { $0.lifecycleGeneration < generation }
        for queued in staleActions {
            _ = queued.cancellationState.finish()
            queued.continuation.resume(
                throwing: ComputerActionService.ComputerActionError.lifecycleChanged)
        }
    }

    private func cancelAction(id: UUID) {
        if let index = pendingActions.firstIndex(where: { $0.id == id }) {
            let queued = self.pendingActions.remove(at: index)
            _ = queued.cancellationState.finish()
            queued.continuation.resume(throwing: CancellationError())
            return
        }
        guard self.currentActionID == id else { return }
        // A canceled action may already have posted left_mouse_down. Release now,
        // and let the operation-task defer catch any later cancellation-ignoring post.
        self.attemptLifecycleRelease()
        self.currentActionTask?.cancel()
    }

    @discardableResult
    private func attemptLifecycleRelease() -> Bool {
        let released = self.onLifecycleRelease()
        self.lifecycleReleasePending = !released
        return released
    }

    private func waitForLifecycleRelease(
        lifecycleGeneration: UInt64,
        cancellationState: ComputerActionCancellationState? = nil) async throws
    {
        while self.lifecycleReleasePending {
            try Task.checkCancellation()
            if cancellationState?.isCancelled == true {
                throw CancellationError()
            }
            guard lifecycleGeneration == self.lifecycleGeneration else {
                throw ComputerActionService.ComputerActionError.lifecycleChanged
            }
            self.attemptLifecycleRelease()
            guard self.lifecycleReleasePending else { return }
            try await Task.sleep(for: .milliseconds(100))
        }
    }
}

struct ComputerControlPermissionSnapshot: Equatable, Sendable {
    enum Access: Equatable, Sendable {
        case granted
        case missing
    }

    enum Bucket: Equatable, Sendable {
        case accessibility
        case postEvent
        case screenCapture

        var displayName: String {
            switch self {
            case .accessibility: "Accessibility"
            case .postEvent: "Event Posting"
            case .screenCapture: "Screen Recording"
            }
        }
    }

    enum Diagnostic: Equatable, Sendable {
        case granted
        case missing([Bucket])
        case accessibilityGrantMayBeStale

        var detailText: String {
            switch self {
            case .granted:
                "Accessibility, Event Posting, and Screen Recording are granted."
            case let .missing(buckets):
                "Missing: \(buckets.map(\.displayName).joined(separator: ", ")). "
                    + "Grant access in System Settings → Privacy & Security, then reopen OpenClaw."
            case .accessibilityGrantMayBeStale:
                Self.staleAccessibilityRemediation
            }
        }

        static let staleAccessibilityRemediation = """
        OpenClaw may already appear enabled under System Settings → Privacy & Security → Accessibility. \
        If so, the grant is pinned to an older build: select OpenClaw, remove it with −, then re-add \
        /Applications/OpenClaw.app.
        """
    }

    enum InputAccess: Equatable, Sendable {
        case granted
        case accessibilityMissing
        case accessibilityGrantMayBeStale
        case postEventMissing
    }

    let accessibility: Access
    let postEvent: Access
    let screenCapture: Access

    @MainActor
    static func probe() -> Self {
        Self(
            accessibility: AXIsProcessTrusted() ? .granted : .missing,
            postEvent: CGPreflightPostEventAccess() ? .granted : .missing,
            screenCapture: PermissionManager.screenRecordingPermissions.checkScreenRecordingPermission()
                ? .granted : .missing)
    }

    var diagnostic: Diagnostic {
        // Capture granted + AX denied is the observed stale cdhash signature after an app rebuild.
        if self.accessibility == .missing, self.screenCapture == .granted {
            return .accessibilityGrantMayBeStale
        }
        let missing = [
            (Bucket.accessibility, self.accessibility),
            (.postEvent, self.postEvent),
            (.screenCapture, self.screenCapture),
        ].compactMap { bucket, access in
            access == .missing ? bucket : nil
        }
        return missing.isEmpty ? .granted : .missing(missing)
    }

    var inputAccess: InputAccess {
        if self.accessibility == .missing {
            return self.screenCapture == .granted
                ? .accessibilityGrantMayBeStale
                : .accessibilityMissing
        }
        return self.postEvent == .granted ? .granted : .postEventMissing
    }
}

/// Routes one `computer.act` request to the executor that owns it: screen
/// coordinates go to `ComputerScreenActionExecutor`, window- and element-scoped
/// requests to `ComputerWindowActionExecutor`. This type owns everything the two
/// executors share — the serializing execution queue, the input-permission
/// probe, and the `ComputerActionError` vocabulary both of them throw.
@MainActor
final class ComputerActionService {
    enum ComputerActionError: LocalizedError {
        case accessibilityNotTrusted
        case accessibilityGrantMayBeStale
        case postEventAccessDenied
        case noDisplays
        case invalidScreenIndex(Int)
        case missingDisplayFrameId
        case displayFrameChanged
        case missingCoordinate
        case coordinateOutOfBounds
        case invalidReferenceWidth
        case missingKeys
        case emptyText
        case invalidScroll
        case invalidModifier(String)
        case buttonAlreadyHeld
        case buttonNotHeld
        case eventCreationFailed
        case lifecycleChanged
        case invalidRequest(String)
        case staleObservation
        case unsupportedAction(OpenClawComputerAction)
        case refused(String)

        var errorDescription: String? {
            switch self {
            case .accessibilityNotTrusted:
                "Accessibility permission is required for computer control"
            case .accessibilityGrantMayBeStale:
                ComputerControlPermissionSnapshot.Diagnostic.staleAccessibilityRemediation
            case .postEventAccessDenied:
                "Event Posting permission is required for computer control"
            case .noDisplays:
                "No displays available for computer control"
            case let .invalidScreenIndex(idx):
                "Invalid screen index \(idx)"
            case .missingDisplayFrameId:
                "displayFrameId is required for coordinate input"
            case .displayFrameChanged:
                "display identity, geometry, or reference scale changed since the screenshot"
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
            case .buttonAlreadyHeld:
                "left button is already held by a split drag"
            case .buttonNotHeld:
                "left button is not held by computer control"
            case .eventCreationFailed:
                "Failed to synthesize input event"
            case .lifecycleChanged:
                "COMPUTER_STALE_OBSERVATION: provider generation changed; take a fresh observation and retry"
            case let .invalidRequest(message):
                "COMPUTER_INVALID_REQUEST: \(message)"
            case .staleObservation:
                "COMPUTER_STALE_OBSERVATION: take a fresh observation and retry"
            case let .unsupportedAction(action):
                "COMPUTER_UNSUPPORTED_ACTION: \(action.rawValue)"
            case let .refused(message):
                "COMPUTER_REFUSED_action_refused: \(message)"
            }
        }
    }

    private let screen: ComputerScreenActionExecutor
    private lazy var window = ComputerWindowActionExecutor()
    private lazy var executionQueue = ComputerActionExecutionQueue { [weak self] in
        self?.screen.releaseCurrentHeldButton() ?? true
    }

    init() {
        self.screen = ComputerScreenActionExecutor()
    }

    #if DEBUG
    init(screen: ComputerScreenActionExecutor) {
        self.screen = screen
    }
    #endif

    func perform(
        _ params: OpenClawComputerActParams,
        lifecycleGeneration: UInt64) async throws -> OpenClawComputerActResult
    {
        try await self.executionQueue.perform(
            params,
            lifecycleGeneration: lifecycleGeneration)
        { [weak self] params, lifecycleGeneration in
            guard let self else { throw CancellationError() }
            return try await self.performImmediately(
                params,
                lifecycleGeneration: lifecycleGeneration)
        }
    }

    private func performImmediately(
        _ params: OpenClawComputerActParams,
        lifecycleGeneration: UInt64) async throws -> OpenClawComputerActResult
    {
        try self.executionQueue.checkExecutionAllowed(lifecycleGeneration: lifecycleGeneration)
        if params.deliveryMode == .background,
           params.windowRef == nil,
           !params.action.isWindowScopedOnly
        {
            return OpenClawComputerActResult(
                ok: false,
                effect: .suspectedNoop,
                escalation: OpenClawComputerEscalation(
                    recommended: "window-pixel",
                    reasonCode: "no_window_target"))
        }
        let checkExecutionAllowed: @MainActor () throws -> Void = { [weak self] in
            guard let self else { throw CancellationError() }
            try self.executionQueue.checkExecutionAllowed(
                lifecycleGeneration: lifecycleGeneration)
        }
        if params.isWindowScopedRequest {
            return try await self.window.perform(
                params,
                lifecycleGeneration: lifecycleGeneration,
                checkExecutionAllowed: checkExecutionAllowed)
        }
        return try await self.screen.perform(
            params,
            checkExecutionAllowed: checkExecutionAllowed)
    }

    static func validateInputPermissions(_ permissions: ComputerControlPermissionSnapshot) throws {
        switch permissions.inputAccess {
        case .granted:
            return
        case .accessibilityMissing:
            throw ComputerActionError.accessibilityNotTrusted
        case .accessibilityGrantMayBeStale:
            throw ComputerActionError.accessibilityGrantMayBeStale
        case .postEventMissing:
            throw ComputerActionError.postEventAccessDenied
        }
    }

    /// Releases any outstanding synthetic left button immediately. Called on
    /// lifecycle transitions (node disconnect, node stop, Computer Control
    /// disabled) so a stranded left_mouse_down is not held until the idle
    /// watchdog fires. Idempotent when nothing is held.
    func releaseHeldInput(lifecycleGeneration: UInt64) async {
        await self.executionQueue.releaseHeldInput(lifecycleGeneration: lifecycleGeneration)
    }

    #if DEBUG
    var lifecycleGenerationForTesting: UInt64 {
        self.executionQueue.lifecycleGenerationForTesting
    }

    func typeTextForTesting(
        _ text: String,
        lifecycleGeneration: UInt64 = 0) async throws -> OpenClawComputerActResult
    {
        let params = OpenClawComputerActParams(action: .type, text: text)
        return try await self.executionQueue.perform(
            params,
            lifecycleGeneration: lifecycleGeneration)
        { [weak self] _, generation in
            guard let self else { throw CancellationError() }
            try await self.screen.typeText(text) { [weak self] in
                guard let self else { throw CancellationError() }
                try self.executionQueue.checkExecutionAllowed(lifecycleGeneration: generation)
            }
            return OpenClawComputerActResult(ok: true, cursorX: 0, cursorY: 0)
        }
    }
    #endif
}
