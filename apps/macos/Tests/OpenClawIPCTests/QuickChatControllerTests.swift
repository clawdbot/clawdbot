import AppKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct QuickChatControllerTests {
    @Test func `accepted global route opens chat with its agent`() async {
        var openedRoute: QuickChatRoutingTarget?
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main",
                    mainkey: "main",
                    scope: AnyCodable("global"),
                    agents: [
                        AgentSummary(id: "main", name: "Main"),
                        AgentSummary(id: "work", name: "Work"),
                    ])
            },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _, _, _ in "ok" },
            permissionStatusProvider: { _ in [:] },
            permissionGrantProvider: { _ in [:] },
            connectionGateProvider: { .available })
        let controller = QuickChatController(
            enableUI: false,
            model: model,
            monitoringEnabled: false,
            chatOpener: { sessionKey, agentID in
                guard let sessionKey else { return }
                openedRoute = QuickChatRoutingTarget(sessionKey: sessionKey, agentID: agentID)
            })
        let presentationID = model.beginPresentation()
        await model.refreshForPresentation(id: presentationID)
        model.selectAgent("work")
        model.text = "hello"

        #expect(await model.send())
        controller.handleSendAcceptedForTesting(openChat: true)
        #expect(openedRoute == QuickChatRoutingTarget(sessionKey: "global", agentID: "work"))
        controller.stop()
    }

    @Test func `controller lifecycle cleans monitor tokens without UI`() {
        let snapshots = QuickChatController.exerciseForTesting()

        #expect(snapshots.count == 4)
        #expect(!snapshots[0].isVisible)
        #expect(snapshots[0].hotkeyRegistered)
        #expect(snapshots[0].isEnabled)
        #expect(snapshots[1].isVisible)
        #expect(snapshots[1].hasGlobalMonitor)
        #expect(snapshots[1].hasLocalMonitor)
        #expect(!snapshots[2].isVisible)
        #expect(!snapshots[2].hasGlobalMonitor)
        #expect(!snapshots[2].hasLocalMonitor)
        #expect(!snapshots[2].hotkeyRegistered)
        #expect(!snapshots[2].isEnabled)
        #expect(!snapshots[3].hotkeyRegistered)
    }

    @Test func `resign key keeps bar visible while granting permissions`() async {
        let latch = GrantLatch()
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main",
                    mainkey: "main",
                    scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Main")])
            },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, $0 != .notifications) })
            },
            permissionGrantProvider: { capabilities in
                await latch.wait()
                return Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available })
        let controller = QuickChatController(enableUI: false, model: model, monitoringEnabled: false)
        controller.present()
        guard let id = model.activePresentationID else {
            Issue.record("expected active presentation")
            return
        }
        await model.refreshForPresentation(id: id)
        #expect(model.missingPermissions == [.notifications])

        model.grantMissingPermissions()
        #expect(model.isGrantingPermissions)
        controller.windowDidResignKey(Notification(name: NSWindow.didResignKeyNotification))
        #expect(controller.isVisible)

        latch.finish()
        while model.isGrantingPermissions {
            await Task.yield()
        }
        controller.windowDidResignKey(Notification(name: NSWindow.didResignKeyNotification))
        #expect(!controller.isVisible)
        controller.stop()
    }

    @Test func `quick chat setting defaults true and hydrates false`() async {
        await TestIsolation.withUserDefaultsValues([quickChatEnabledKey: nil]) {
            #expect(AppState(preview: true).quickChatEnabled)
        }
        await TestIsolation.withUserDefaultsValues([quickChatEnabledKey: false]) {
            #expect(!AppState(preview: true).quickChatEnabled)
        }
    }
}

@MainActor
private final class GrantLatch {
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func wait() async {
        if self.finished { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func finish() {
        self.finished = true
        self.continuation?.resume()
        self.continuation = nil
    }
}
