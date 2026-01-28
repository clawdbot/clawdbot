import AppKit
import MoltbotProtocol
import SwiftUI
import Testing

@testable import Moltbot

@Suite(.serialized)
@MainActor
struct LowCoverageViewSmokeTests {
    @Test func contextMenuCardBuildsBody() {
        let loading = ContextMenuCardView(rows: [], statusText: "Loading…", isLoading: true)
        _ = loading.body

        let empty = ContextMenuCardView(rows: [], statusText: nil, isLoading: false)
        _ = empty.body

        let withRows = ContextMenuCardView(rows: SessionRow.previewRows, statusText: nil, isLoading: false)
        _ = withRows.body
    }

    @Test func settingsToggleRowBuildsBody() {
        var flag = false
        let binding = Binding(get: { flag }, set: { flag = $0 })
        let view = SettingsToggleRow(title: "Enable", subtitle: "Detail", binding: binding)
        _ = view.body
    }

    @Test func voiceWakeTestCardBuildsBodyAcrossStates() {
        var state = VoiceWakeTestState.idle
        var isTesting = false
        let stateBinding = Binding(get: { state }, set: { state = $0 })
        let testingBinding = Binding(get: { isTesting }, set: { isTesting = $0 })

        _ = VoiceWakeTestCard(testState: stateBinding, isTesting: testingBinding, onToggle: {}).body

        state = .hearing("hello")
        _ = VoiceWakeTestCard(testState: stateBinding, isTesting: testingBinding, onToggle: {}).body

        state = .detected("command")
        isTesting = true
        _ = VoiceWakeTestCard(testState: stateBinding, isTesting: testingBinding, onToggle: {}).body

        state = .failed("No mic")
        _ = VoiceWakeTestCard(testState: stateBinding, isTesting: testingBinding, onToggle: {}).body
    }

    @Test func agentEventsWindowBuildsBodyWithEvent() {
        AgentEventStore.shared.clear()
        let sample = ControlAgentEvent(
            runId: "run-1",
            seq: 1,
            stream: "tool",
            ts: Date().timeIntervalSince1970 * 1000,
            data: ["phase": AnyCodable("start"), "name": AnyCodable("test")],
            summary: nil)
        AgentEventStore.shared.append(sample)
        _ = AgentEventsWindow().body
        AgentEventStore.shared.clear()
    }

    @Test func notifyOverlayPresentsAndDismisses() async {
        let controller = NotifyOverlayController()
        controller.present(title: "Hello", body: "World", autoDismissAfter: 0)
        controller.present(title: "Updated", body: "Again", autoDismissAfter: 0)
        controller.dismiss()
        try? await Task.sleep(nanoseconds: 250_000_000)
    }

    @Test func visualEffectViewHostsInNSHostingView() {
        let hosting = NSHostingView(rootView: VisualEffectView(material: .sidebar))
        _ = hosting.fittingSize
        hosting.rootView = VisualEffectView(material: .popover, emphasized: true)
        _ = hosting.fittingSize
    }

    @Test func menuHostedItemHostsContent() {
        let view = MenuHostedItem(width: 240, rootView: AnyView(Text("Menu")))
        let hosting = NSHostingView(rootView: view)
        _ = hosting.fittingSize
        hosting.rootView = MenuHostedItem(width: 320, rootView: AnyView(Text("Updated")))
        _ = hosting.fittingSize
    }

    @Test func dockIconManagerUpdatesVisibility() {
        _ = NSApplication.shared
        UserDefaults.standard.set(false, forKey: showDockIconKey)
        DockIconManager.shared.updateDockVisibility()
        DockIconManager.shared.temporarilyShowDock()
    }

    @Test func voiceWakeSettingsExercisesHelpers() {
        VoiceWakeSettings.exerciseForTesting()
    }

    @Test func debugSettingsExercisesHelpers() async {
        await DebugSettings.exerciseForTesting()
    }
}
