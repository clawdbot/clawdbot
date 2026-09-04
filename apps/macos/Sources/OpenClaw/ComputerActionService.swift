import ApplicationServices
import CoreGraphics
import Foundation
import OpenClawKit
import PeekabooAutomationKit

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

    var isActive: Bool {
        self.lock.withLock { self.phase == .active }
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

/// One native admission owner, created before lazy desktop services initialize.
/// It serializes effects and retains closed IDs for the lifetime of their route.
@MainActor
final class ComputerActionExecutionQueue {
    typealias CancellationHop = @Sendable (
        @escaping @MainActor @Sendable () -> Void) -> Void

    private final class Execution {
        let id: UUID
        let route: GatewayNodeInvocationRoute
        var closed = false
        var cleanup: Task<Void, Error>?

        init(id: UUID, route: GatewayNodeInvocationRoute) {
            self.id = id
            self.route = route
        }
    }

    private typealias Completion = @MainActor () async -> Void

    private struct QueuedAction {
        let id: UUID
        let lifecycleGeneration: UInt64
        let execution: Execution
        let operation: @MainActor () async -> Completion
        let reject: @MainActor (Error) -> Void
        let cancellationState: ComputerActionCancellationState
        let checkAuthority: @MainActor () throws -> Void
    }

    private var onLifecycleRelease: @MainActor () -> Bool
    private var onExecutionCleanup: @MainActor () async throws -> Void = {}
    private let scheduleCancellationHop: CancellationHop
    private var lifecycleGeneration: UInt64 = 0
    private var pendingActions: [QueuedAction] = []
    private var drainTask: Task<Void, Never>?
    private var currentAction: QueuedAction?
    private var currentActionTask: Task<Void, Never>?
    private var currentOperationTask: Task<Completion, Never>?
    private var lifecycleReleasePending = false
    private var execution: Execution?
    private var route: GatewayNodeInvocationRoute?
    private var closedExecutionIDs: Set<UUID> = []

    nonisolated init(
        onLifecycleRelease: @escaping @MainActor @Sendable () -> Bool = { true },
        scheduleCancellationHop: @escaping CancellationHop = { operation in
            Task { @MainActor in operation() }
        })
    {
        self.onLifecycleRelease = onLifecycleRelease
        self.scheduleCancellationHop = scheduleCancellationHop
    }

    /// Installed by the single-flight service initializer, even when its caller
    /// was canceled. Cleanup must own effects before that operation can settle.
    func installCleanup(
        release: @escaping @MainActor () -> Bool,
        invalidate: @escaping @MainActor () async throws -> Void)
    {
        self.onLifecycleRelease = release
        self.onExecutionCleanup = invalidate
    }

    func perform<Value: Sendable>(
        executionId: UUID,
        route: GatewayNodeInvocationRoute,
        checkAuthority: @escaping @MainActor () throws -> Void,
        operation: @escaping @MainActor (UInt64) async throws -> Value) async throws -> Value
    {
        let lifecycleGeneration = self.lifecycleGeneration
        try Task.checkCancellation()
        try checkAuthority()
        // Capture admission before any suspension. Work queued before close can
        // never look up (or create) a replacement execution after the close.
        let execution = try self.admit(executionId, route: route)
        let actionID = UUID()
        let cancellationState = ComputerActionCancellationState()
        let scheduleCancellationHop = self.scheduleCancellationHop
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled, !cancellationState.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.pendingActions.append(QueuedAction(
                    id: actionID,
                    lifecycleGeneration: lifecycleGeneration,
                    execution: execution,
                    operation: {
                        let outcome: Result<Value, Error>
                        do {
                            try self.checkExecutionAllowed(lifecycleGeneration: lifecycleGeneration)
                            let value = try await operation(lifecycleGeneration)
                            try self.checkExecutionAllowed(lifecycleGeneration: lifecycleGeneration)
                            outcome = .success(value)
                        } catch {
                            outcome = .failure(error)
                        }
                        // Native operations may ignore cancellation and post after
                        // the immediate release. Drain this catch-up before close.
                        if Task.isCancelled || cancellationState.isCancelled ||
                            !self.isAllowed(execution, generation: lifecycleGeneration)
                        {
                            if self.attemptLifecycleRelease(), cancellationState.isCancelled {
                                cancellationState.recordOperationReleaseSuccess()
                            }
                        }
                        return {
                            let cancellation = cancellationState.finish()
                            if cancellation.needsRelease { self.attemptLifecycleRelease() }
                            if cancellation.wasCancelled {
                                try? await self.waitForLifecycleRelease(lifecycleGeneration: lifecycleGeneration)
                            }
                            if !self.isAllowed(execution, generation: lifecycleGeneration) {
                                continuation
                                    .resume(throwing: ComputerActionService.ComputerActionError.lifecycleChanged)
                            } else if cancellation.wasCancelled {
                                continuation.resume(throwing: CancellationError())
                            } else {
                                continuation.resume(with: outcome)
                            }
                        }
                    },
                    reject: { continuation.resume(throwing: $0) },
                    cancellationState: cancellationState,
                    checkAuthority: checkAuthority))
                self.startDrainIfNeeded()
            }
        } onCancel: {
            guard cancellationState.requestCancellation() else { return }
            scheduleCancellationHop { @MainActor [weak self] in self?.cancelAction(id: actionID) }
        }
    }

    private func admit(_ id: UUID, route: GatewayNodeInvocationRoute) throws -> Execution {
        try self.bindRoute(route)
        if let execution {
            guard !execution.closed, execution.id == id, execution.route === route else {
                throw ComputerActionService.ComputerActionError.hostBusy
            }
            return execution
        }
        guard !self.closedExecutionIDs.contains(id) else {
            throw ComputerActionService.ComputerActionError.lifecycleChanged
        }
        let execution = Execution(id: id, route: route)
        self.execution = execution
        return execution
    }

    private func bindRoute(_ route: GatewayNodeInvocationRoute) throws {
        guard route.isActive else { throw ComputerActionService.ComputerActionError.lifecycleChanged }
        if self.route !== route {
            guard self.execution == nil, self.route?.isActive != true else {
                throw ComputerActionService.ComputerActionError.lifecycleChanged
            }
            self.route = route
            self.closedExecutionIDs.removeAll()
        }
    }

    func closeExecution(
        _ id: UUID, route: GatewayNodeInvocationRoute, retireUnowned: Bool) async throws -> Bool
    {
        if let execution, execution.id == id, execution.route === route {
            try await self.retire(execution).value
            return true
        }
        if retireUnowned {
            // Gateway can close before policy dispatch. Retire that ID without
            // creating resources, so a delayed first action cannot reopen it.
            try self.bindRoute(route)
            self.closedExecutionIDs.insert(id)
        }
        return false
    }

    private func retire(_ execution: Execution) -> Task<Void, Error> {
        if let cleanup = execution.cleanup { return cleanup }
        execution.closed = true
        self.closedExecutionIDs.insert(execution.id)
        let activeTask = self.currentActionTask
        self.rejectPending { $0.execution === execution }
        self.currentOperationTask?.cancel()
        self.attemptLifecycleRelease()
        let cleanup = Task { @MainActor in
            await activeTask?.value
            // Await the existing release retry owner; a failed mouse-up must not
            // become a successful close or let a successor inherit held input.
            try await self.waitForLifecycleRelease(lifecycleGeneration: nil)
            try await self.onExecutionCleanup()
            if self.execution === execution { self.execution = nil }
        }
        execution.cleanup = cleanup
        return cleanup
    }

    func revoke(route: GatewayNodeInvocationRoute?) async {
        // A delayed callback cannot release a same-ID successor on another route.
        if let route, self.execution?.route !== route { return }
        self.lifecycleGeneration &+= 1
        if let execution { _ = await self.retire(execution).result }
    }

    func executionCheck(lifecycleGeneration: UInt64) -> @MainActor () throws -> Void {
        let actionID = self.currentAction?.id
        return {
            // A retained callback cannot borrow the queue's next action, even
            // when both actions use the same UUID or native lifecycle epoch.
            guard let actionID, self.currentAction?.id == actionID else {
                throw ComputerActionService.ComputerActionError.lifecycleChanged
            }
            try self.checkExecutionAllowed(lifecycleGeneration: lifecycleGeneration)
        }
    }

    func checkExecutionAllowed(lifecycleGeneration: UInt64) throws {
        try Task.checkCancellation()
        guard let currentAction else { throw ComputerActionService.ComputerActionError.lifecycleChanged }
        try currentAction.checkAuthority()
        guard currentAction.cancellationState.isActive else { throw CancellationError() }
        guard self.isAllowed(currentAction.execution, generation: lifecycleGeneration) else {
            throw ComputerActionService.ComputerActionError.lifecycleChanged
        }
    }

    private func isAllowed(_ execution: Execution, generation: UInt64) -> Bool {
        guard generation == self.lifecycleGeneration else { return false }
        return self.execution === execution && !execution.closed && execution.route.isActive
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
        self.drainTask = Task { @MainActor [weak self] in await self?.drain() }
    }

    private func drain() async {
        while !self.pendingActions.isEmpty {
            let queued = self.pendingActions.removeFirst()
            do {
                try await self.waitForLifecycleRelease(
                    lifecycleGeneration: queued.lifecycleGeneration,
                    cancellationState: queued.cancellationState)
                guard self.isAllowed(queued.execution, generation: queued.lifecycleGeneration) else {
                    throw ComputerActionService.ComputerActionError.lifecycleChanged
                }
                guard !queued.cancellationState.isCancelled else { throw CancellationError() }
            } catch {
                _ = queued.cancellationState.finish()
                queued.reject(error)
                continue
            }
            self.currentAction = queued
            let operationTask = Task { @MainActor in await queued.operation() }
            self.currentOperationTask = operationTask
            // Settlement/release runs outside the canceled effector task. Close
            // joins this task, including failed-release retries, before ACK.
            let settlement = Task { @MainActor in
                let complete = await operationTask.value
                await complete()
            }
            self.currentActionTask = settlement
            await settlement.value
            self.currentAction = nil
            self.currentActionTask = nil
            self.currentOperationTask = nil
        }
        self.drainTask = nil
    }

    private func rejectPending(where matches: (QueuedAction) -> Bool) {
        let stale = self.pendingActions.filter(matches)
        self.pendingActions.removeAll(where: matches)
        for queued in stale {
            _ = queued.cancellationState.finish()
            queued.reject(ComputerActionService.ComputerActionError.lifecycleChanged)
        }
    }

    private func cancelAction(id: UUID) {
        if let index = self.pendingActions.firstIndex(where: { $0.id == id }) {
            let queued = self.pendingActions.remove(at: index)
            _ = queued.cancellationState.finish()
            queued.reject(CancellationError())
            return
        }
        guard self.currentAction?.id == id else { return }
        self.attemptLifecycleRelease()
        self.currentOperationTask?.cancel()
    }

    @discardableResult
    private func attemptLifecycleRelease() -> Bool {
        let released = self.onLifecycleRelease()
        self.lifecycleReleasePending = !released
        return released
    }

    private func waitForLifecycleRelease(
        lifecycleGeneration: UInt64?,
        cancellationState: ComputerActionCancellationState? = nil) async throws
    {
        while self.lifecycleReleasePending {
            try Task.checkCancellation()
            if cancellationState?.isCancelled == true { throw CancellationError() }
            if let lifecycleGeneration, lifecycleGeneration != self.lifecycleGeneration {
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
/// executors share — owned snapshot cleanup, the input-permission probe, and
/// the error vocabulary. Both use the runtime's single admission queue.
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
        case hostBusy
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
            case .hostBusy:
                "COMPUTER_HOST_BUSY: another execution owns this computer or is closing"
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

    private let snapshotManager: InMemorySnapshotManager
    private let screenSnapshotManager: InMemorySnapshotManager
    private let screen: ComputerScreenActionExecutor
    private var window: ComputerWindowActionExecutor?
    private let executionQueue: ComputerActionExecutionQueue

    init(executionQueue: ComputerActionExecutionQueue, snapshotManager: InMemorySnapshotManager) {
        self.executionQueue = executionQueue
        self.snapshotManager = snapshotManager
        let screenSnapshots = InMemorySnapshotManager()
        self.screenSnapshotManager = screenSnapshots
        self.screen = ComputerScreenActionExecutor(snapshotManager: screenSnapshots)
    }

    func perform(
        _ params: OpenClawComputerActParams,
        lifecycleGeneration: UInt64) async throws -> OpenClawComputerActResult
    {
        let checkExecutionAllowed = self.executionQueue.executionCheck(lifecycleGeneration: lifecycleGeneration)
        try checkExecutionAllowed()
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
        if params.isWindowScopedRequest {
            let window = self.window ?? ComputerWindowActionExecutor(snapshotManager: self.snapshotManager)
            self.window = window
            return try await window.perform(
                params,
                lifecycleGeneration: lifecycleGeneration,
                checkExecutionAllowed: checkExecutionAllowed)
        }
        return try await self.screen.perform(params, checkExecutionAllowed: checkExecutionAllowed)
    }

    func releaseHeldInput() -> Bool {
        self.screen.releaseCurrentHeldButton()
    }

    func invalidateReferences() async throws {
        self.window?.clearReferences()
        // Keep coordinate and window snapshots separate, but retire both after
        // queue settlement so a suspended observation cannot republish state.
        _ = try await self.snapshotManager.cleanAllSnapshots()
        _ = try await self.screenSnapshotManager.cleanAllSnapshots()
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
}
