import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MenuContentSmokeTests {
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

    @Test func `connected configured gateway opens dashboard instead of onboarding`() {
        for mode in [AppState.ConnectionMode.local, .remote] {
            let shouldOpen = AppDelegate.shouldOpenDashboardInsteadOfOnboarding(
                connectionMode: mode,
                onboardingSeen: false,
                hasStoredConnectionMode: false,
                gatewayConnected: true)

            #expect(shouldOpen)
        }
    }

    @Test func `disconnected configured gateway keeps onboarding recovery`() {
        let shouldOpen = AppDelegate.shouldOpenDashboardInsteadOfOnboarding(
            connectionMode: .remote,
            onboardingSeen: false,
            hasStoredConnectionMode: false,
            gatewayConnected: false)

        #expect(!shouldOpen)
    }

    @Test func `connected gateway from interrupted onboarding keeps onboarding`() {
        let shouldOpen = AppDelegate.shouldOpenDashboardInsteadOfOnboarding(
            connectionMode: .local,
            onboardingSeen: false,
            hasStoredConnectionMode: true,
            gatewayConnected: true)

        #expect(!shouldOpen)
    }
}
