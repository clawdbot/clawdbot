import AppKit
import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct QuickChatControllerTests {
    @Test func `plain accepted send stays open and binds reply view model`() async throws {
        var createdRoutes: [QuickChatRoutingTarget] = []
        let model = Self.makeModel()
        let controller = QuickChatController(
            enableUI: false,
            model: model,
            monitoringEnabled: false,
            replyViewModelFactory: { route in
                createdRoutes.append(route)
                return OpenClawChatViewModel(sessionKey: route.sessionKey, transport: QuickChatTestTransport())
            })
        controller.present()
        let presentationID = try #require(model.activePresentationID)
        await model.refreshForPresentation(id: presentationID)
        model.text = "hello"

        #expect(await model.send())
        controller.handleSendAcceptedForTesting(openChat: false)

        #expect(controller.isVisible)
        #expect(createdRoutes == [QuickChatRoutingTarget(sessionKey: "agent:main:main", agentID: nil)])
        #expect(controller.replyBinding.route == createdRoutes.first)
        controller.stop()
    }

    @Test func `reply binding retains same target and rebuilds for a changed target`() throws {
        var createdRoutes: [QuickChatRoutingTarget] = []
        let binding = QuickChatReplyBinding { route in
            createdRoutes.append(route)
            return OpenClawChatViewModel(sessionKey: route.sessionKey, transport: QuickChatTestTransport())
        }
        let firstRoute = QuickChatRoutingTarget(sessionKey: "agent:main:main", agentID: nil)
        let secondRoute = QuickChatRoutingTarget(sessionKey: "global", agentID: "work")

        binding.show(route: firstRoute)
        let firstViewModel = try #require(binding.viewModel)
        binding.rebindIfActive(route: firstRoute)
        #expect(binding.viewModel === firstViewModel)

        binding.rebindIfActive(route: secondRoute)
        let secondViewModel = try #require(binding.viewModel)
        #expect(secondViewModel !== firstViewModel)
        #expect(createdRoutes == [firstRoute, secondRoute])
    }

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
            sendProvider: { _, _, _, _, _, _ in "ok" },
            permissionStatusProvider: { _ in [:] },
            permissionGrantProvider: { _ in [:] },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in .testFixture },
            modelPatchProvider: { _, _ in nil })
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
            sendProvider: { _, _, _, _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, $0 != .notifications) })
            },
            permissionGrantProvider: { capabilities in
                await latch.wait()
                return Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in .testFixture },
            modelPatchProvider: { _, _ in nil })
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

    @Test func `resign key keeps bar visible while capturing focused text`() async {
        let latch = TextCaptureLatch()
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
            sendProvider: { _, _, _, _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available },
            textContextCaptureProvider: { await latch.wait() },
            modelControlsProvider: { _ in .testFixture },
            modelPatchProvider: { _, _ in nil })
        let controller = QuickChatController(enableUI: false, model: model, monitoringEnabled: false)
        controller.present()
        guard let id = model.activePresentationID else {
            Issue.record("expected active presentation")
            return
        }
        await model.refreshForPresentation(id: id)

        model.captureFocusedAppText()
        #expect(model.isCapturingTextContext)
        controller.windowDidResignKey(Notification(name: NSWindow.didResignKeyNotification))
        #expect(controller.isVisible)

        latch.finish(.cancelled)
        while model.isCapturingTextContext {
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

    private static func makeModel() -> QuickChatModel {
        QuickChatModel(
            sessionKeyProvider: { "main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main",
                    mainkey: "main",
                    scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Main")])
            },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _, _, _, _ in "ok" },
            permissionStatusProvider: { _ in [:] },
            permissionGrantProvider: { _ in [:] },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in .testFixture },
            modelPatchProvider: { _, _ in nil })
    }
}

private struct QuickChatTestTransport: OpenClawChatTransport {
    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        let json = """
        {"sessionKey":"\(sessionKey)","sessionId":null,"messages":[],"thinkingLevel":"off"}
        """
        return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data(json.utf8))
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        let json = """
        {"runId":"\(UUID().uuidString)","status":"ok"}
        """
        return try JSONDecoder().decode(OpenClawChatSendResponse.self, from: Data(json.utf8))
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }

    func setActiveSessionKey(_: String) async throws {}
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

@MainActor
private final class TextCaptureLatch {
    private var continuation: CheckedContinuation<QuickChatTextContextCaptureOutcome, Never>?
    private var outcome: QuickChatTextContextCaptureOutcome?

    func wait() async -> QuickChatTextContextCaptureOutcome {
        if let outcome { return outcome }
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func finish(_ outcome: QuickChatTextContextCaptureOutcome) {
        self.outcome = outcome
        self.continuation?.resume(returning: outcome)
        self.continuation = nil
    }
}
