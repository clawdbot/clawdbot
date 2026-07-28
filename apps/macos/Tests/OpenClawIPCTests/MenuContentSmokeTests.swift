import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MenuContentSmokeTests {
    @Test func `signal failsafe leaves time after bounded cleanup`() {
        #expect(AppTerminationTiming.cleanupDeadlineSeconds < AppTerminationTiming.signalExitFailsafeSeconds)
    }

    @Test func `menu content builds body local mode`() {
        let state = AppState(preview: true)
        state.connectionMode = .local
        let view = MenuContent(state: state, updater: nil)
        _ = view.body
    }

    @Test func `menu content builds body remote mode`() {
        let state = AppState(preview: true)
        state.connectionMode = .remote
        let view = MenuContent(state: state, updater: nil)
        _ = view.body
    }

    @Test func `menu content builds body unconfigured mode`() {
        let state = AppState(preview: true)
        state.connectionMode = .unconfigured
        let view = MenuContent(state: state, updater: nil)
        _ = view.body
    }

    @Test func `menu content builds body with debug and canvas`() {
        let state = AppState(preview: true)
        state.connectionMode = .local
        state.debugPaneEnabled = true
        state.canvasEnabled = true
        state.canvasPanelVisible = true
        state.swabbleEnabled = true
        state.voicePushToTalkEnabled = true
        state.heartbeatsEnabled = true
        let view = MenuContent(state: state, updater: nil)
        _ = view.body
    }

    @Test func `dock menu exposes primary shortcuts`() throws {
        let delegate = AppDelegate()
        let menu = try #require(delegate.applicationDockMenu(NSApplication.shared))
        let titles = menu.items.map(\.title)

        #expect(titles.contains("Open Dashboard"))
        #expect(titles.contains("Open Chat"))
        #expect(titles.contains("Open Canvas") || titles.contains("Close Canvas"))
        #expect(titles.contains("Settings…"))
    }

    @Test func `dock reopen opens dashboard and suppresses default handling`() {
        let delegate = AppDelegate()
        var didOpenDashboard = false
        delegate.openDashboardAction = {
            didOpenDashboard = true
        }

        let shouldUseDefaultHandling = delegate.applicationShouldHandleReopen(
            NSApplication.shared,
            hasVisibleWindows: false)

        #expect(shouldUseDefaultHandling == false)
        #expect(didOpenDashboard)
    }

    @Test func `dock reopen keeps default handling when windows are visible`() {
        let delegate = AppDelegate()
        var didOpenDashboard = false
        delegate.openDashboardAction = {
            didOpenDashboard = true
        }

        let shouldUseDefaultHandling = delegate.applicationShouldHandleReopen(
            NSApplication.shared,
            hasVisibleWindows: true)

        #expect(shouldUseDefaultHandling)
        #expect(!didOpenDashboard)
    }

    @Test func `application termination waits for node input cleanup`() async {
        let delegate = AppDelegate()
        let cleanupStarted = AsyncStream<Void>.makeStream()
        let cleanupRelease = AsyncStream<Void>.makeStream()
        let deadlineRelease = AsyncStream<Void>.makeStream()
        var startedIterator = cleanupStarted.stream.makeAsyncIterator()
        var replies: [Bool] = []
        delegate.nodeTerminationCleanup = {
            cleanupStarted.continuation.yield()
            for await _ in cleanupRelease.stream {
                return
            }
        }
        delegate.waitForTerminationCleanupDeadline = {
            for await _ in deadlineRelease.stream {
                return
            }
        }
        delegate.applicationTerminationReply = { _, allow in
            replies.append(allow)
        }

        let initialReply = delegate.applicationShouldTerminate(NSApplication.shared)
        #expect(initialReply == .terminateLater)
        _ = await startedIterator.next()
        #expect(replies.isEmpty)

        cleanupRelease.continuation.yield()
        cleanupRelease.continuation.finish()
        while replies.isEmpty {
            await Task.yield()
        }
        #expect(replies == [true])
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
    }

    @Test func `application termination deadline does not await stalled cleanup`() async {
        let delegate = AppDelegate()
        let cleanup = CancellationIgnoringTerminationCleanup()
        let deadlineRelease = AsyncStream<Void>.makeStream()
        var replies: [Bool] = []
        delegate.nodeTerminationCleanup = {
            await cleanup.run()
        }
        delegate.waitForTerminationCleanupDeadline = {
            for await _ in deadlineRelease.stream {
                return
            }
        }
        delegate.applicationTerminationReply = { _, allow in
            replies.append(allow)
        }

        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        await cleanup.waitUntilStarted()
        deadlineRelease.continuation.yield()
        deadlineRelease.continuation.finish()
        while replies.isEmpty {
            await Task.yield()
        }

        #expect(replies == [true])
        #expect(await !cleanup.finished())
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
        await cleanup.release()
        while await !cleanup.finished() {
            await Task.yield()
        }
        #expect(replies == [true])
    }

    @Test func `connected configured gateway with inference opens dashboard instead of onboarding`() {
        for mode in [AppState.ConnectionMode.local, .remote] {
            let shouldOpen = AppDelegate.shouldOpenDashboardInsteadOfOnboarding(
                connectionMode: mode,
                onboardingSeen: false,
                systemAgentResumePending: false,
                gatewayConnected: true,
                configuredInferenceModel: " openai/gpt-5.5 ")

            #expect(shouldOpen)
        }
    }

    @Test func `connected configured gateway without inference keeps onboarding`() {
        for model in [String?.none, "", "   "] {
            let shouldOpen = AppDelegate.shouldOpenDashboardInsteadOfOnboarding(
                connectionMode: .remote,
                onboardingSeen: false,
                systemAgentResumePending: false,
                gatewayConnected: true,
                configuredInferenceModel: model)

            #expect(!shouldOpen)
        }
    }

    @Test func `disconnected configured gateway keeps onboarding recovery`() {
        let shouldOpen = AppDelegate.shouldOpenDashboardInsteadOfOnboarding(
            connectionMode: .remote,
            onboardingSeen: false,
            systemAgentResumePending: false,
            gatewayConnected: false,
            configuredInferenceModel: "openai/gpt-5.5")

        #expect(!shouldOpen)
    }

    @Test func `stored connection mode without a pending handoff still opens dashboard`() {
        let shouldOpen = AppDelegate.shouldOpenDashboardInsteadOfOnboarding(
            connectionMode: .local,
            onboardingSeen: false,
            systemAgentResumePending: false,
            gatewayConnected: true,
            configuredInferenceModel: "openai/gpt-5.5")

        #expect(shouldOpen)
    }

    @Test func `pending OpenClaw handoff survives relaunch and keeps onboarding`() {
        let shouldOpen = AppDelegate.shouldOpenDashboardInsteadOfOnboarding(
            connectionMode: .local,
            onboardingSeen: false,
            systemAgentResumePending: true,
            gatewayConnected: true,
            configuredInferenceModel: "openai/gpt-5.5")

        #expect(!shouldOpen)
    }

    @Test func `first run inference result rejects selected gateway drift`() {
        #expect(!AppDelegate.isCurrentFirstRunInferenceProbe(
            expectedConnectionMode: .remote,
            currentConnectionMode: .remote,
            expectedRouteIdentity: "remote:id:gateway-a",
            currentRouteIdentity: "remote:id:gateway-b",
            gatewayRouteIsCurrent: true))
    }

    @Test func `first run inference result accepts matching selected gateway and route`() {
        #expect(AppDelegate.isCurrentFirstRunInferenceProbe(
            expectedConnectionMode: .remote,
            currentConnectionMode: .remote,
            expectedRouteIdentity: "remote:id:gateway-a",
            currentRouteIdentity: "remote:id:gateway-a",
            gatewayRouteIsCurrent: true))
    }

    @Test func `delayed first run presentation is cancelled by later completion`() {
        #expect(!AppDelegate.shouldPresentScheduledFirstRunOnboarding(
            expectedConnectionMode: .remote,
            currentConnectionMode: .remote,
            expectedRouteIdentity: "remote:id:gateway-a",
            currentRouteIdentity: "remote:id:gateway-a",
            onboardingSeen: true))
    }
}

private actor CancellationIgnoringTerminationCleanup {
    private var didStart = false
    private var didFinish = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    func run() async {
        self.didStart = true
        self.startWaiters.forEach { $0.resume() }
        self.startWaiters.removeAll()
        await withCheckedContinuation { continuation in
            self.releaseContinuation = continuation
        }
        self.didFinish = true
    }

    func waitUntilStarted() async {
        guard !self.didStart else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func release() {
        self.releaseContinuation?.resume()
        self.releaseContinuation = nil
    }

    func finished() -> Bool {
        self.didFinish
    }
}
