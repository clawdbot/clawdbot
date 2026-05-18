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
}
