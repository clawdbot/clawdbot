import CoreGraphics
import Foundation
import OpenClawKit
import PeekabooAutomationKit
import Testing
@testable import OpenClaw

@MainActor
struct ComputerActionServiceTests {
    private enum SyntheticPostError: Error {
        case failed
    }

    private actor AsyncSignal {
        private var signaled = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            guard !self.signaled else { return }
            await withCheckedContinuation { continuation in
                self.waiters.append(continuation)
            }
        }

        func signal() {
            self.signaled = true
            let waiters = self.waiters
            self.waiters.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
        }
    }

    @MainActor
    private final class ActionProbe {
        let firstStarted = AsyncSignal()
        let releaseFirst = AsyncSignal()
        private(set) var enteredActionIDs: [Int] = []
        private(set) var activeActionCount = 0
        private(set) var maximumActiveActionCount = 0

        func perform(_ actionID: Int) async throws -> OpenClawComputerActResult {
            self.enteredActionIDs.append(actionID)
            self.activeActionCount += 1
            self.maximumActiveActionCount = max(
                self.maximumActiveActionCount,
                self.activeActionCount)
            defer { self.activeActionCount -= 1 }

            if actionID == 1 {
                await self.firstStarted.signal()
                await self.releaseFirst.wait()
            }
            try Task.checkCancellation()
            return OpenClawComputerActResult(ok: true)
        }
    }

    @MainActor
    private final class LifecycleReleaseProbe {
        var allowed: Bool
        private(set) var attempts = 0

        init(allowed: Bool) {
            self.allowed = allowed
        }

        func attempt() -> Bool {
            self.attempts += 1
            return self.allowed
        }
    }

    private final class CancellationHopProbe: @unchecked Sendable {
        private let lock = NSLock()
        private var pending: [@MainActor @Sendable () -> Void] = []

        var pendingCount: Int {
            self.lock.withLock { self.pending.count }
        }

        func schedule(_ operation: @escaping @MainActor @Sendable () -> Void) {
            self.lock.withLock { self.pending.append(operation) }
        }

        @MainActor
        func runAll() {
            let operations = self.lock.withLock {
                let pending = self.pending
                self.pending.removeAll()
                return pending
            }
            for operation in operations {
                operation()
            }
        }
    }

    @MainActor
    private final class ActionTaskBox {
        var task: Task<OpenClawComputerActResult, Error>?
    }

    private func isLifecycleChanged(_ error: Error?) -> Bool {
        guard let error = error as? ComputerActionService.ComputerActionError else { return false }
        if case .lifecycleChanged = error {
            return true
        }
        return false
    }

    private func unsupportedAction(_ error: Error?) -> OpenClawComputerAction? {
        guard let error = error as? ComputerActionService.ComputerActionError else { return nil }
        if case let .unsupportedAction(action) = error {
            return action
        }
        return nil
    }

    private func validationError(
        _ operation: () throws -> Void) -> ComputerActionService.ComputerActionError?
    {
        do {
            try operation()
            return nil
        } catch let error as ComputerActionService.ComputerActionError {
            return error
        } catch {
            return nil
        }
    }

    private func typeText(
        _ text: String,
        screen: ComputerScreenActionExecutor,
        queue: ComputerActionExecutionQueue,
        route: GatewayNodeInvocationRoute) async throws
    {
        try await queue.perform(executionId: UUID(), route: route, checkAuthority: {}) { generation in
            try await screen.typeText(
                text,
                checkExecutionAllowed: queue.executionCheck(lifecycleGeneration: generation))
        }
    }

    @Test func `capture grant distinguishes a stale accessibility grant`() {
        let permissions = ComputerControlPermissionSnapshot(
            accessibility: .missing,
            postEvent: .granted,
            screenCapture: .granted)

        #expect(permissions.diagnostic == .accessibilityGrantMayBeStale)
        #expect(permissions.diagnostic.detailText == """
        OpenClaw may already appear enabled under System Settings → Privacy & Security → Accessibility. \
        If so, the grant is pinned to an older build: select OpenClaw, remove it with −, then re-add \
        /Applications/OpenClaw.app.
        """)
        #expect(permissions.inputAccess == .accessibilityGrantMayBeStale)
        let error = self.validationError {
            try ComputerActionService.validateInputPermissions(permissions)
        }
        if case .some(.accessibilityGrantMayBeStale) = error {} else {
            Issue.record("expected stale Accessibility error, got \(String(describing: error))")
        }
    }

    @Test func `missing accessibility and capture is a plain missing permission`() {
        let permissions = ComputerControlPermissionSnapshot(
            accessibility: .missing,
            postEvent: .granted,
            screenCapture: .missing)

        #expect(permissions.diagnostic == .missing([.accessibility, .screenCapture]))
        #expect(permissions.diagnostic.detailText == """
        Missing: Accessibility, Screen Recording. \
        Grant access in System Settings → Privacy & Security, then reopen OpenClaw.
        """)
        #expect(permissions.inputAccess == .accessibilityMissing)
        let error = self.validationError {
            try ComputerActionService.validateInputPermissions(permissions)
        }
        if case .some(.accessibilityNotTrusted) = error {} else {
            Issue.record("expected missing Accessibility error, got \(String(describing: error))")
        }
    }

    @Test func `post event denial remains distinct from accessibility denial`() {
        let permissions = ComputerControlPermissionSnapshot(
            accessibility: .granted,
            postEvent: .missing,
            screenCapture: .granted)

        #expect(permissions.diagnostic == .missing([.postEvent]))
        #expect(permissions.inputAccess == .postEventMissing)
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerActionService.validateInputPermissions(permissions)
        }
    }

    @Test func `coordinate input requires the current display frame identity`() throws {
        let currentFrameId = "display-frame:v1:current"
        let missing = OpenClawComputerActParams(
            action: .leftClick,
            x: 1,
            y: 2,
            refWidth: 1280)
        let missingError = self.validationError {
            try ComputerScreenActionExecutor.validateDisplayFrame(missing, currentFrameId: currentFrameId)
        }
        if case .some(.missingDisplayFrameId) = missingError {} else {
            Issue.record("expected missingDisplayFrameId")
        }

        let stale = OpenClawComputerActParams(
            action: .leftClick,
            displayFrameId: "display-frame:v1:stale",
            x: 1,
            y: 2,
            refWidth: 1280)
        let staleError = self.validationError {
            try ComputerScreenActionExecutor.validateDisplayFrame(stale, currentFrameId: currentFrameId)
        }
        if case .some(.displayFrameChanged) = staleError {} else {
            Issue.record("expected displayFrameChanged")
        }

        let current = OpenClawComputerActParams(
            action: .leftClick,
            displayFrameId: currentFrameId,
            x: 1,
            y: 2,
            refWidth: 1280)
        try ComputerScreenActionExecutor.validateDisplayFrame(current, currentFrameId: currentFrameId)

        let missingScale = OpenClawComputerActParams(
            action: .leftClick,
            displayFrameId: currentFrameId,
            x: 1,
            y: 2)
        let missingScaleError = self.validationError {
            try ComputerScreenActionExecutor.validateDisplayFrame(
                missingScale,
                currentFrameId: currentFrameId)
        }
        if case .some(.invalidReferenceWidth) = missingScaleError {} else {
            Issue.record("expected invalidReferenceWidth")
        }

        let display = OpenClawComputerDisplayGeometry(
            originX: 0,
            originY: 0,
            widthPoints: 1280,
            heightPoints: 800)
        let screenshotFrameId = OpenClawComputerInputGeometry.displayFrameId(
            displayID: 1,
            sourceWidth: 2560,
            sourceHeight: 1600,
            referenceWidth: 1280,
            display: display)
        let mismatchedScaleFrameId = OpenClawComputerInputGeometry.displayFrameId(
            displayID: 1,
            sourceWidth: 2560,
            sourceHeight: 1600,
            referenceWidth: 640,
            display: display)
        let mismatchedScale = OpenClawComputerActParams(
            action: .leftClick,
            displayFrameId: screenshotFrameId,
            x: 1,
            y: 2,
            refWidth: 640)
        let mismatchedScaleError = self.validationError {
            try ComputerScreenActionExecutor.validateDisplayFrame(
                mismatchedScale,
                currentFrameId: mismatchedScaleFrameId)
        }
        if case .some(.displayFrameChanged) = mismatchedScaleError {} else {
            Issue.record("expected displayFrameChanged for mismatched refWidth")
        }

        // Cursor-relative/keyboard actions do not consume screenshot coordinates.
        let keyboard = OpenClawComputerActParams(action: .type, text: "hello")
        try ComputerScreenActionExecutor.validateDisplayFrame(keyboard, currentFrameId: currentFrameId)
    }

    @Test func `cursor-relative input stays inside the selected display`() throws {
        let display = OpenClawComputerDisplayGeometry(
            originX: 100,
            originY: -50,
            widthPoints: 800,
            heightPoints: 600)
        #expect(try ComputerScreenActionExecutor.validatedCurrentCursorPoint(
            CGPoint(x: 100, y: -50),
            display: display) == CGPoint(x: 100, y: -50))
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerScreenActionExecutor.validatedCurrentCursorPoint(
                CGPoint(x: 99, y: 0),
                display: display)
        }
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerScreenActionExecutor.validatedCurrentCursorPoint(nil, display: display)
        }
    }

    @Test func `integrated drag and duplicate down are rejected during a split hold`() throws {
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerScreenActionExecutor.validateHeldButtonTransition(
                action: .leftClickDrag,
                leftButtonDown: true)
        }
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerScreenActionExecutor.validateHeldButtonTransition(
                action: .leftMouseDown,
                leftButtonDown: true)
        }
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerScreenActionExecutor.validateHeldButtonTransition(
                action: .doubleClick,
                leftButtonDown: true)
        }
        try ComputerScreenActionExecutor.validateHeldButtonTransition(
            action: .leftMouseUp,
            leftButtonDown: true)
    }

    @Test func `left mouse up requires a service owned split hold`() throws {
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerScreenActionExecutor.validateHeldButtonTransition(
                action: .leftMouseUp,
                leftButtonDown: false)
        }
        try ComputerScreenActionExecutor.validateHeldButtonTransition(
            action: .leftMouseDown,
            leftButtonDown: false)
        try ComputerScreenActionExecutor.validateHeldButtonTransition(
            action: .leftMouseUp,
            leftButtonDown: true)
    }

    @Test func `lifecycle release retries event creation failure before returning`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let flags: CGEventFlags = [.maskCommand, .maskShift]
            var attempts = 0
            var postedFlags: [CGEventFlags] = []
            let screen = ComputerScreenActionExecutor { down, _, eventFlags in
                #expect(!down)
                attempts += 1
                postedFlags.append(eventFlags)
                if attempts == 1 {
                    throw ComputerActionService.ComputerActionError.eventCreationFailed
                }
            }
            let queue = ComputerActionExecutionQueue(onLifecycleRelease: screen.releaseCurrentHeldButton)
            try await queue.perform(executionId: UUID(), route: route, checkAuthority: {}) { _ in () }
            screen.holdLeftButtonForTesting(flags: flags)

            await queue.revoke(route: nil)

            #expect(!screen.isLeftButtonDownForTesting)
            #expect(screen.heldButtonFlagsForTesting.isEmpty)
            #expect(!screen.buttonWatchdogArmedForTesting)
            #expect(attempts == 2)
            #expect(postedFlags == [flags, flags])
        }
    }

    @Test func `watchdog release retains ownership and rearms after post failure`() {
        let flags: CGEventFlags = [.maskAlternate]
        var attempts = 0
        let screen = ComputerScreenActionExecutor { down, _, eventFlags in
            #expect(!down)
            #expect(eventFlags == flags)
            attempts += 1
            if attempts == 1 {
                throw SyntheticPostError.failed
            }
        }
        screen.holdLeftButtonForTesting(flags: flags)

        screen.fireButtonWatchdogForTesting()

        #expect(screen.isLeftButtonDownForTesting)
        #expect(screen.heldButtonFlagsForTesting == flags)
        #expect(screen.buttonWatchdogArmedForTesting)

        screen.fireButtonWatchdogForTesting()

        #expect(!screen.isLeftButtonDownForTesting)
        #expect(screen.heldButtonFlagsForTesting.isEmpty)
        #expect(!screen.buttonWatchdogArmedForTesting)
        #expect(attempts == 2)
    }

    @Test func `failed explicit release retains added modifiers for watchdog retry`() {
        let heldFlags: CGEventFlags = [.maskAlternate]
        let releaseFlags: CGEventFlags = [.maskShift]
        let expectedFlags = heldFlags.union(releaseFlags)
        var attempts = 0
        var postedFlags: [CGEventFlags] = []
        let screen = ComputerScreenActionExecutor { down, _, eventFlags in
            #expect(!down)
            attempts += 1
            postedFlags.append(eventFlags)
            if attempts == 1 {
                throw SyntheticPostError.failed
            }
        }
        screen.holdLeftButtonForTesting(flags: heldFlags)

        #expect(throws: SyntheticPostError.self) {
            try screen.releaseHeldButtonForTesting(additionalFlags: releaseFlags)
        }

        #expect(screen.isLeftButtonDownForTesting)
        #expect(screen.heldButtonFlagsForTesting == expectedFlags)
        #expect(screen.buttonWatchdogArmedForTesting)

        screen.fireButtonWatchdogForTesting()

        #expect(!screen.isLeftButtonDownForTesting)
        #expect(screen.heldButtonFlagsForTesting.isEmpty)
        #expect(!screen.buttonWatchdogArmedForTesting)
        #expect(attempts == 2)
        #expect(postedFlags == [expectedFlags, expectedFlags])
    }

    @Test func `computer actions execute in FIFO order without overlap`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let probe = ActionProbe()
            let queue = ComputerActionExecutionQueue(onLifecycleRelease: { true })
            let executionId = UUID()
            let first = Task { @MainActor in
                try await queue.perform(executionId: executionId, route: route, checkAuthority: {}) { _ in
                    try await probe.perform(1)
                }
            }
            await probe.firstStarted.wait()
            let second = Task { @MainActor in
                try await queue.perform(executionId: executionId, route: route, checkAuthority: {}) { _ in
                    try await probe.perform(2)
                }
            }
            while queue.pendingActionCountForTesting != 1 {
                await Task.yield()
            }

            #expect(probe.enteredActionIDs == [1])
            #expect(probe.maximumActiveActionCount == 1)
            await probe.releaseFirst.signal()
            _ = try await first.value
            _ = try await second.value

            #expect(probe.enteredActionIDs == [1, 2])
            #expect(probe.maximumActiveActionCount == 1)
        }
    }

    @Test func `window authority rejects a result after lifecycle revocation`() async {
        let service = ComputerWindowActionExecutor(snapshotManager: InMemorySnapshotManager())
        var checks = 0
        let outcomeError: Error?
        do {
            _ = try await service.perform(
                OpenClawComputerActParams(action: .getCursorPosition),
                lifecycleGeneration: 0,
                checkExecutionAllowed: {
                    checks += 1
                    if checks > 1 {
                        throw ComputerActionService.ComputerActionError.lifecycleChanged
                    }
                })
            outcomeError = nil
        } catch {
            outcomeError = error
        }

        #expect(self.isLifecycleChanged(outcomeError))
        #expect(checks == 2)
    }

    @Test func `execution authority revalidates after awaited preparation`() async {
        let started = AsyncSignal()
        let resume = AsyncSignal()
        let releaseProbe = LifecycleReleaseProbe(allowed: true)
        let authority = ComputerActionExecutionAuthority {
            guard releaseProbe.allowed else {
                throw ComputerActionService.ComputerActionError.lifecycleChanged
            }
        }
        let operation = Task { @MainActor in
            try await authority.run {
                await started.signal()
                await resume.wait()
                return true
            }
        }
        await started.wait()
        releaseProbe.allowed = false
        await resume.signal()

        let outcomeError: Error?
        do {
            _ = try await operation.value
            outcomeError = nil
        } catch {
            outcomeError = error
        }
        #expect(self.isLifecycleChanged(outcomeError))
    }

    @Test func `window executor rejects foreground accessibility-only actions`() async {
        let service = ComputerWindowActionExecutor(snapshotManager: InMemorySnapshotManager())
        for action in [OpenClawComputerAction.setValue, .invokeMenu] {
            let outcomeError: Error?
            do {
                _ = try await service.perform(
                    OpenClawComputerActParams(action: action, deliveryMode: .foreground),
                    lifecycleGeneration: 0,
                    checkExecutionAllowed: {})
                outcomeError = nil
            } catch {
                outcomeError = error
            }
            #expect(self.unsupportedAction(outcomeError) == action)
        }
    }

    @Test func `cancelled queued action never executes`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let probe = ActionProbe()
            let queue = ComputerActionExecutionQueue(onLifecycleRelease: { true })
            let executionId = UUID()
            let first = Task { @MainActor in
                try await queue.perform(executionId: executionId, route: route, checkAuthority: {}) { _ in
                    try await probe.perform(1)
                }
            }
            await probe.firstStarted.wait()
            let cancelled = Task { @MainActor in
                try await queue.perform(executionId: executionId, route: route, checkAuthority: {}) { _ in
                    try await probe.perform(2)
                }
            }
            while queue.pendingActionCountForTesting != 1 {
                await Task.yield()
            }

            cancelled.cancel()
            let cancellationError: Error?
            do {
                _ = try await cancelled.value
                cancellationError = nil
            } catch {
                cancellationError = error
            }
            #expect(cancellationError is CancellationError)
            #expect(probe.enteredActionIDs == [1])

            await probe.releaseFirst.signal()
            _ = try await first.value
            #expect(probe.enteredActionIDs == [1])
        }
    }

    @Test func `cancelled active action releases held input before it settles`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let probe = ActionProbe()
            let releaseProbe = LifecycleReleaseProbe(allowed: true)
            let queue = ComputerActionExecutionQueue(onLifecycleRelease: releaseProbe.attempt)
            let action = Task { @MainActor in
                try await queue.perform(executionId: UUID(), route: route, checkAuthority: {}) { _ in
                    try await probe.perform(1)
                }
            }
            await probe.firstStarted.wait()

            action.cancel()
            while releaseProbe.attempts == 0 {
                await Task.yield()
            }
            #expect(releaseProbe.attempts == 1)
            await probe.releaseFirst.signal()
            _ = try? await action.value
            #expect(releaseProbe.attempts == 2)
        }
    }

    @Test func `cancellation retries failed release before its main actor hop`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let cancellationHop = CancellationHopProbe()
            var releaseAttempts = 0
            let queue = ComputerActionExecutionQueue(
                onLifecycleRelease: {
                    releaseAttempts += 1
                    return releaseAttempts >= 2
                },
                scheduleCancellationHop: cancellationHop.schedule)
            let taskBox = ActionTaskBox()
            let action = Task { @MainActor in
                try await queue.perform(executionId: UUID(), route: route, checkAuthority: {}) { _ in
                    taskBox.task?.cancel()
                    return OpenClawComputerActResult(ok: true)
                }
            }
            taskBox.task = action

            let cancellationError: Error?
            do {
                _ = try await action.value
                cancellationError = nil
            } catch {
                cancellationError = error
            }

            #expect(cancellationError is CancellationError)
            #expect(cancellationHop.pendingCount == 1)
            #expect(releaseAttempts == 2)
            cancellationHop.runAll()
            #expect(cancellationHop.pendingCount == 0)
            #expect(releaseAttempts == 2)
        }
    }

    @Test func `typing posts exactly one event pair per Swift grapheme`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            var posted: [Character] = []
            let screen = ComputerScreenActionExecutor(textGraphemePoster: { posted.append($0) })
            let queue = ComputerActionExecutionQueue(onLifecycleRelease: screen.releaseCurrentHeldButton)
            let text = "A👨‍👩‍👧‍👦e\u{301}\n\t"

            try await self.typeText(text, screen: screen, queue: queue, route: route)

            #expect(posted == Array(text))
        }
    }

    @Test func `caller cancellation stops typing before the next grapheme`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let firstPosted = AsyncSignal()
            let resumePoster = AsyncSignal()
            var posted: [Character] = []
            let screen = ComputerScreenActionExecutor(
                textGraphemePoster: { grapheme in
                    posted.append(grapheme)
                    guard posted.count == 1 else { return }
                    await firstPosted.signal()
                    await resumePoster.wait()
                })
            let queue = ComputerActionExecutionQueue(onLifecycleRelease: screen.releaseCurrentHeldButton)
            let action = Task { @MainActor in
                try await self.typeText("A👨‍👩‍👧‍👦B", screen: screen, queue: queue, route: route)
            }
            await firstPosted.wait()

            action.cancel()
            await resumePoster.signal()

            let cancellationError: Error?
            do {
                _ = try await action.value
                cancellationError = nil
            } catch {
                cancellationError = error
            }
            #expect(cancellationError is CancellationError)
            #expect(posted == ["A"])
        }
    }

    @Test func `lifecycle replacement stops typing before the next grapheme`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let firstPosted = AsyncSignal()
            let resumePoster = AsyncSignal()
            var posted: [Character] = []
            let screen = ComputerScreenActionExecutor(
                textGraphemePoster: { grapheme in
                    posted.append(grapheme)
                    guard posted.count == 1 else { return }
                    await firstPosted.signal()
                    await resumePoster.wait()
                })
            let queue = ComputerActionExecutionQueue(onLifecycleRelease: screen.releaseCurrentHeldButton)
            let action = Task { @MainActor in
                try await self.typeText("A👨‍👩‍👧‍👦B", screen: screen, queue: queue, route: route)
            }
            await firstPosted.wait()

            let release = Task { @MainActor in
                await queue.revoke(route: route)
            }
            while queue.lifecycleGenerationForTesting != 1 {
                await Task.yield()
            }
            await resumePoster.signal()
            await release.value

            let lifecycleError: Error?
            do {
                _ = try await action.value
                lifecycleError = nil
            } catch {
                lifecycleError = error
            }
            #expect(self.isLifecycleChanged(lifecycleError))
            #expect(posted == ["A"])
        }
    }

    @Test func `new lifecycle generation cancels old work before fresh action`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let probe = ActionProbe()
            let releaseProbe = LifecycleReleaseProbe(allowed: true)
            let queue = ComputerActionExecutionQueue(onLifecycleRelease: releaseProbe.attempt)
            let oldExecutionId = UUID()
            let old = Task { @MainActor in
                try await queue.perform(executionId: oldExecutionId, route: route, checkAuthority: {}) { _ in
                    try await probe.perform(1)
                }
            }
            await probe.firstStarted.wait()
            let release = Task { @MainActor in
                await queue.revoke(route: route)
            }
            while releaseProbe.attempts == 0 {
                await Task.yield()
            }
            let immediateReleaseAttempts = releaseProbe.attempts
            await probe.releaseFirst.signal()
            await release.value
            #expect(releaseProbe.attempts == immediateReleaseAttempts + 1)

            let oldError: Error?
            do {
                _ = try await old.value
                oldError = nil
            } catch {
                oldError = error
            }
            #expect(self.isLifecycleChanged(oldError))

            _ = try await queue.perform(
                executionId: UUID(), route: route, checkAuthority: {})
            { _ in
                try await probe.perform(2)
            }
            #expect(probe.enteredActionIDs == [1, 2])

            await queue.revoke(route: route)

            let staleError: Error?
            do {
                _ = try await queue.perform(
                    executionId: oldExecutionId, route: route, checkAuthority: {})
                { _ in
                    try await probe.perform(1)
                }
                staleError = nil
            } catch {
                staleError = error
            }
            #expect(self.isLifecycleChanged(staleError))
            #expect(probe.enteredActionIDs == [1, 2])
        }
    }

    @Test func `failed lifecycle mouse up blocks newer generation until retry succeeds`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let probe = ActionProbe()
            let releaseProbe = LifecycleReleaseProbe(allowed: false)
            let queue = ComputerActionExecutionQueue(onLifecycleRelease: releaseProbe.attempt)
            // A local stop without an admitted owner must not release successor input.
            await queue.revoke(route: nil)
            #expect(releaseProbe.attempts == 0)
            try await queue.perform(executionId: UUID(), route: route, checkAuthority: {}) { _ in () }
            defer { releaseProbe.allowed = true }
            let release = Task { @MainActor in await queue.revoke(route: nil) }
            while releaseProbe.attempts < 2 {
                await Task.yield()
            }
            let successorId = UUID()
            do {
                _ = try await queue.perform(
                    executionId: successorId, route: route, checkAuthority: {})
                { _ in
                    try await probe.perform(2)
                }
                Issue.record("successor unexpectedly entered while input release was pending")
            } catch ComputerActionService.ComputerActionError.hostBusy {
                // The closing execution retains ownership until its release succeeds.
            }
            #expect(probe.enteredActionIDs.isEmpty)

            releaseProbe.allowed = true
            await release.value
            _ = try await queue.perform(
                executionId: successorId, route: route, checkAuthority: {})
            { _ in
                try await probe.perform(2)
            }

            #expect(releaseProbe.attempts >= 3)
            #expect(probe.enteredActionIDs == [2])
        }
    }

    @Test func `raw click preconstructs up before posting down`() throws {
        var factoryCalls = 0
        var postCount = 0
        let screen = ComputerScreenActionExecutor(
            mouseEventFactory: { type, point, button, _, _ in
                factoryCalls += 1
                if factoryCalls == 2 {
                    throw SyntheticPostError.failed
                }
                guard let event = CGEvent(
                    mouseEventSource: nil,
                    mouseType: type,
                    mouseCursorPosition: point,
                    mouseButton: button)
                else { throw SyntheticPostError.failed }
                return event
            },
            mouseEventPoster: { _ in postCount += 1 })

        #expect(throws: SyntheticPostError.self) {
            try screen.rawClickForTesting()
        }
        #expect(factoryCalls == 2)
        #expect(postCount == 0)
    }

    @Test func `raw drag posts release after a move failure`() async {
        var eventTypes: [ObjectIdentifier: CGEventType] = [:]
        var postedTypes: [CGEventType] = []
        var failedMove = false
        let screen = ComputerScreenActionExecutor(
            mouseEventFactory: { type, point, button, _, _ in
                guard let event = CGEvent(
                    mouseEventSource: nil,
                    mouseType: type,
                    mouseCursorPosition: point,
                    mouseButton: button)
                else { throw SyntheticPostError.failed }
                eventTypes[ObjectIdentifier(event)] = type
                return event
            },
            mouseEventPoster: { event in
                let type = eventTypes[ObjectIdentifier(event)]
                if let type { postedTypes.append(type) }
                if type == .leftMouseDragged, !failedMove {
                    failedMove = true
                    throw SyntheticPostError.failed
                }
            })

        do {
            try await screen.rawDragForTesting()
            Issue.record("raw drag unexpectedly succeeded")
        } catch is SyntheticPostError {
            // Expected injected move failure.
        } catch {
            Issue.record("unexpected error: \(error)")
        }

        #expect(postedTypes.first == .leftMouseDown)
        #expect(postedTypes.contains(.leftMouseDragged))
        #expect(postedTypes.last == .leftMouseUp)
    }

    @Test func `raw drag posts release when cancelled between moves`() async {
        var eventTypes: [ObjectIdentifier: CGEventType] = [:]
        var postedTypes: [CGEventType] = []
        let screen = ComputerScreenActionExecutor(
            mouseEventFactory: { type, point, button, _, _ in
                guard let event = CGEvent(
                    mouseEventSource: nil,
                    mouseType: type,
                    mouseCursorPosition: point,
                    mouseButton: button)
                else { throw SyntheticPostError.failed }
                eventTypes[ObjectIdentifier(event)] = type
                return event
            },
            mouseEventPoster: { event in
                if let type = eventTypes[ObjectIdentifier(event)] {
                    postedTypes.append(type)
                }
            })

        let drag = Task { @MainActor in
            try await screen.rawDragForTesting()
        }
        while !postedTypes.contains(.leftMouseDragged) {
            await Task.yield()
        }
        drag.cancel()
        _ = try? await drag.value

        #expect(postedTypes.first == .leftMouseDown)
        #expect(postedTypes.last == .leftMouseUp)
    }
}
