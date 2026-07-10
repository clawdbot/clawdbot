import CoreGraphics
import Foundation
import OpenClawKit
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

        func perform(
            _ params: OpenClawComputerActParams,
            lifecycleGeneration: UInt64) async throws -> OpenClawComputerActResult
        {
            _ = lifecycleGeneration
            let actionID = Int(params.x ?? -1)
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
            return OpenClawComputerActResult(ok: true, cursorX: Double(actionID), cursorY: 0)
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

    @Test func `coordinate input requires the current display frame identity`() throws {
        let currentFrameId = "display-frame:v1:current"
        let missing = OpenClawComputerActParams(
            action: .leftClick,
            x: 1,
            y: 2,
            refWidth: 1280)
        let missingError = self.validationError {
            try ComputerActionService.validateDisplayFrame(missing, currentFrameId: currentFrameId)
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
            try ComputerActionService.validateDisplayFrame(stale, currentFrameId: currentFrameId)
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
        try ComputerActionService.validateDisplayFrame(current, currentFrameId: currentFrameId)

        let missingScale = OpenClawComputerActParams(
            action: .leftClick,
            displayFrameId: currentFrameId,
            x: 1,
            y: 2)
        let missingScaleError = self.validationError {
            try ComputerActionService.validateDisplayFrame(
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
            try ComputerActionService.validateDisplayFrame(
                mismatchedScale,
                currentFrameId: mismatchedScaleFrameId)
        }
        if case .some(.displayFrameChanged) = mismatchedScaleError {} else {
            Issue.record("expected displayFrameChanged for mismatched refWidth")
        }

        // Cursor-relative/keyboard actions do not consume screenshot coordinates.
        let keyboard = OpenClawComputerActParams(action: .type, text: "hello")
        try ComputerActionService.validateDisplayFrame(keyboard, currentFrameId: currentFrameId)
    }

    @Test func `cursor-relative input stays inside the selected display`() throws {
        let display = OpenClawComputerDisplayGeometry(
            originX: 100,
            originY: -50,
            widthPoints: 800,
            heightPoints: 600)
        #expect(try ComputerActionService.validatedCurrentCursorPoint(
            CGPoint(x: 100, y: -50),
            display: display) == CGPoint(x: 100, y: -50))
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerActionService.validatedCurrentCursorPoint(
                CGPoint(x: 99, y: 0),
                display: display)
        }
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerActionService.validatedCurrentCursorPoint(nil, display: display)
        }
    }

    @Test func `integrated drag and duplicate down are rejected during a split hold`() throws {
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerActionService.validateHeldButtonTransition(
                action: .leftClickDrag,
                leftButtonDown: true)
        }
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerActionService.validateHeldButtonTransition(
                action: .leftMouseDown,
                leftButtonDown: true)
        }
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerActionService.validateHeldButtonTransition(
                action: .doubleClick,
                leftButtonDown: true)
        }
        try ComputerActionService.validateHeldButtonTransition(
            action: .leftMouseUp,
            leftButtonDown: true)
    }

    @Test func `left mouse up requires a service owned split hold`() throws {
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try ComputerActionService.validateHeldButtonTransition(
                action: .leftMouseUp,
                leftButtonDown: false)
        }
        try ComputerActionService.validateHeldButtonTransition(
            action: .leftMouseDown,
            leftButtonDown: false)
        try ComputerActionService.validateHeldButtonTransition(
            action: .leftMouseUp,
            leftButtonDown: true)
    }

    @Test func `lifecycle release retries event creation failure before returning`() async {
        let flags: CGEventFlags = [.maskCommand, .maskShift]
        var attempts = 0
        var postedFlags: [CGEventFlags] = []
        let service = ComputerActionService { down, _, eventFlags in
            #expect(!down)
            attempts += 1
            postedFlags.append(eventFlags)
            if attempts == 1 {
                throw ComputerActionService.ComputerActionError.eventCreationFailed
            }
        }
        service.holdLeftButtonForTesting(flags: flags)

        await service.releaseHeldInput(lifecycleGeneration: 1)

        #expect(!service.isLeftButtonDownForTesting)
        #expect(service.heldButtonFlagsForTesting.isEmpty)
        #expect(!service.buttonWatchdogArmedForTesting)
        #expect(attempts == 2)
        #expect(postedFlags == [flags, flags])
    }

    @Test func `watchdog release retains ownership and rearms after post failure`() {
        let flags: CGEventFlags = [.maskAlternate]
        var attempts = 0
        let service = ComputerActionService { down, _, eventFlags in
            #expect(!down)
            #expect(eventFlags == flags)
            attempts += 1
            if attempts == 1 {
                throw SyntheticPostError.failed
            }
        }
        service.holdLeftButtonForTesting(flags: flags)

        service.fireButtonWatchdogForTesting()

        #expect(service.isLeftButtonDownForTesting)
        #expect(service.heldButtonFlagsForTesting == flags)
        #expect(service.buttonWatchdogArmedForTesting)

        service.fireButtonWatchdogForTesting()

        #expect(!service.isLeftButtonDownForTesting)
        #expect(service.heldButtonFlagsForTesting.isEmpty)
        #expect(!service.buttonWatchdogArmedForTesting)
        #expect(attempts == 2)
    }

    @Test func `failed explicit release retains added modifiers for watchdog retry`() {
        let heldFlags: CGEventFlags = [.maskAlternate]
        let releaseFlags: CGEventFlags = [.maskShift]
        let expectedFlags = heldFlags.union(releaseFlags)
        var attempts = 0
        var postedFlags: [CGEventFlags] = []
        let service = ComputerActionService { down, _, eventFlags in
            #expect(!down)
            attempts += 1
            postedFlags.append(eventFlags)
            if attempts == 1 {
                throw SyntheticPostError.failed
            }
        }
        service.holdLeftButtonForTesting(flags: heldFlags)

        #expect(throws: SyntheticPostError.self) {
            try service.releaseHeldButtonForTesting(additionalFlags: releaseFlags)
        }

        #expect(service.isLeftButtonDownForTesting)
        #expect(service.heldButtonFlagsForTesting == expectedFlags)
        #expect(service.buttonWatchdogArmedForTesting)

        service.fireButtonWatchdogForTesting()

        #expect(!service.isLeftButtonDownForTesting)
        #expect(service.heldButtonFlagsForTesting.isEmpty)
        #expect(!service.buttonWatchdogArmedForTesting)
        #expect(attempts == 2)
        #expect(postedFlags == [expectedFlags, expectedFlags])
    }

    @Test func `computer actions execute in FIFO order without overlap`() async throws {
        let probe = ActionProbe()
        let queue = ComputerActionExecutionQueue(onLifecycleRelease: { true })
        let firstParams = OpenClawComputerActParams(action: .leftClick, x: 1, y: 0, refWidth: 1280)
        let secondParams = OpenClawComputerActParams(action: .leftClick, x: 2, y: 0, refWidth: 1280)

        let first = Task { @MainActor in
            try await queue.perform(firstParams, lifecycleGeneration: 0, operation: probe.perform)
        }
        await probe.firstStarted.wait()
        let second = Task { @MainActor in
            try await queue.perform(secondParams, lifecycleGeneration: 0, operation: probe.perform)
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

    @Test func `cancelled queued action never executes`() async throws {
        let probe = ActionProbe()
        let queue = ComputerActionExecutionQueue(onLifecycleRelease: { true })
        let firstParams = OpenClawComputerActParams(action: .leftClick, x: 1, y: 0, refWidth: 1280)
        let cancelledParams = OpenClawComputerActParams(action: .leftClick, x: 2, y: 0, refWidth: 1280)

        let first = Task { @MainActor in
            try await queue.perform(firstParams, lifecycleGeneration: 0, operation: probe.perform)
        }
        await probe.firstStarted.wait()
        let cancelled = Task { @MainActor in
            try await queue.perform(cancelledParams, lifecycleGeneration: 0, operation: probe.perform)
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

    @Test func `cancelled active action releases held input before it settles`() async {
        let probe = ActionProbe()
        let releaseProbe = LifecycleReleaseProbe(allowed: true)
        let queue = ComputerActionExecutionQueue(onLifecycleRelease: releaseProbe.attempt)
        let params = OpenClawComputerActParams(action: .leftMouseDown, x: 1, y: 0, refWidth: 1280)
        let action = Task { @MainActor in
            try await queue.perform(params, lifecycleGeneration: 0, operation: probe.perform)
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

    @Test func `cancellation retries failed release before its main actor hop`() async {
        let cancellationHop = CancellationHopProbe()
        var releaseAttempts = 0
        let queue = ComputerActionExecutionQueue(
            onLifecycleRelease: {
                releaseAttempts += 1
                return releaseAttempts >= 2
            },
            scheduleCancellationHop: cancellationHop.schedule)
        let taskBox = ActionTaskBox()
        let params = OpenClawComputerActParams(
            action: .leftMouseDown,
            x: 1,
            y: 0,
            refWidth: 1280)
        let action = Task { @MainActor in
            try await queue.perform(params, lifecycleGeneration: 0) { _, _ in
                taskBox.task?.cancel()
                return OpenClawComputerActResult(ok: true, cursorX: 1, cursorY: 0)
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

    @Test func `typing posts exactly one event pair per Swift grapheme`() async throws {
        var posted: [Character] = []
        let service = ComputerActionService(textGraphemePoster: { posted.append($0) })
        let text = "A👨‍👩‍👧‍👦e\u{301}\n\t"

        _ = try await service.typeTextForTesting(text)

        #expect(posted == Array(text))
    }

    @Test func `caller cancellation stops typing before the next grapheme`() async {
        let firstPosted = AsyncSignal()
        let resumePoster = AsyncSignal()
        var posted: [Character] = []
        let service = ComputerActionService(textGraphemePoster: { grapheme in
            posted.append(grapheme)
            guard posted.count == 1 else { return }
            await firstPosted.signal()
            await resumePoster.wait()
        })
        let action = Task { @MainActor in
            try await service.typeTextForTesting("A👨‍👩‍👧‍👦B")
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

    @Test func `lifecycle replacement stops typing before the next grapheme`() async {
        let firstPosted = AsyncSignal()
        let resumePoster = AsyncSignal()
        var posted: [Character] = []
        let service = ComputerActionService(textGraphemePoster: { grapheme in
            posted.append(grapheme)
            guard posted.count == 1 else { return }
            await firstPosted.signal()
            await resumePoster.wait()
        })
        let action = Task { @MainActor in
            try await service.typeTextForTesting("A👨‍👩‍👧‍👦B")
        }
        await firstPosted.wait()

        let release = Task { @MainActor in
            await service.releaseHeldInput(lifecycleGeneration: 1)
        }
        while service.lifecycleGenerationForTesting != 1 {
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

    @Test func `new lifecycle generation cancels old work before fresh action`() async throws {
        let probe = ActionProbe()
        let releaseProbe = LifecycleReleaseProbe(allowed: true)
        let queue = ComputerActionExecutionQueue(onLifecycleRelease: releaseProbe.attempt)
        let oldParams = OpenClawComputerActParams(action: .leftClick, x: 1, y: 0, refWidth: 1280)
        let freshParams = OpenClawComputerActParams(action: .leftClick, x: 2, y: 0, refWidth: 1280)

        let old = Task { @MainActor in
            try await queue.perform(oldParams, lifecycleGeneration: 0, operation: probe.perform)
        }
        await probe.firstStarted.wait()
        let release = Task { @MainActor in
            await queue.releaseHeldInput(lifecycleGeneration: 1)
        }
        await Task.yield()
        #expect(releaseProbe.attempts == 1)
        await probe.releaseFirst.signal()
        await release.value
        #expect(releaseProbe.attempts == 2)

        let oldError: Error?
        do {
            _ = try await old.value
            oldError = nil
        } catch {
            oldError = error
        }
        #expect(self.isLifecycleChanged(oldError))

        _ = try await queue.perform(
            freshParams,
            lifecycleGeneration: 1,
            operation: probe.perform)
        #expect(probe.enteredActionIDs == [1, 2])

        let staleError: Error?
        do {
            _ = try await queue.perform(
                oldParams,
                lifecycleGeneration: 0,
                operation: probe.perform)
            staleError = nil
        } catch {
            staleError = error
        }
        #expect(self.isLifecycleChanged(staleError))
        #expect(probe.enteredActionIDs == [1, 2])
    }

    @Test func `failed lifecycle mouse up blocks newer generation until retry succeeds`() async throws {
        let probe = ActionProbe()
        let releaseProbe = LifecycleReleaseProbe(allowed: false)
        let queue = ComputerActionExecutionQueue(onLifecycleRelease: releaseProbe.attempt)
        let params = OpenClawComputerActParams(action: .type, x: 2, y: 0, refWidth: 1280)

        let action = Task { @MainActor in
            try await queue.perform(
                params,
                lifecycleGeneration: 1,
                operation: probe.perform)
        }
        while releaseProbe.attempts < 2 {
            await Task.yield()
        }
        #expect(probe.enteredActionIDs.isEmpty)

        releaseProbe.allowed = true
        _ = try await action.value

        #expect(releaseProbe.attempts >= 3)
        #expect(probe.enteredActionIDs == [2])
    }

    @Test func `raw click preconstructs up before posting down`() throws {
        var factoryCalls = 0
        var postCount = 0
        let service = ComputerActionService(
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
            try service.rawClickForTesting()
        }
        #expect(factoryCalls == 2)
        #expect(postCount == 0)
    }

    @Test func `raw drag posts release after a move failure`() async {
        var eventTypes: [ObjectIdentifier: CGEventType] = [:]
        var postedTypes: [CGEventType] = []
        var failedMove = false
        let service = ComputerActionService(
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
            try await service.rawDragForTesting()
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
        let service = ComputerActionService(
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
            try await service.rawDragForTesting()
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
