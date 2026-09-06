import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized, .timeLimit(.minutes(1)))
@MainActor
struct QuickChatCatalogBoundaryTests {
    @Test(arguments: QuickChatCatalogGatewayServer.CatalogFailure.allCases)
    func `real catalog failures retain choices and recover without losing the draft`(
        failure: QuickChatCatalogGatewayServer.CatalogFailure) async throws
    {
        try await self.withFixture(sessionScoped: false) { fixture in
            let controller = fixture.makeController()
            let model = controller.model
            controller.present()
            try await self.waitForReady(model)
            let presentationID = try #require(model.activePresentationID)
            #expect(model.modelChoices.map(\.selectionID) == ["fixture/choice-a", "fixture/choice-b"])
            model.text = "Keep this unsent draft"

            await fixture.server.setFailure(failure)
            await model.refreshForPresentation(id: presentationID)

            #expect(controller.isVisible)
            #expect(model.modelChoices.map(\.selectionID) == ["fixture/choice-a", "fixture/choice-b"])
            #expect(model.modelControlStatusMessage == "Couldn't load model settings.")
            #expect(model.text == "Keep this unsent draft")

            await fixture.server.setFailure(nil)
            await fixture.server.setModels(["choice-b", "choice-c"])
            await model.refreshForPresentation(id: presentationID)

            #expect(model.modelChoices.map(\.selectionID) == ["fixture/choice-b", "fixture/choice-c"])
            #expect(model.modelControlStatusMessage == nil)
            #expect(model.activePresentationID == presentationID)
            #expect(model.text == "Keep this unsent draft")
        }
    }

    @Test(arguments: [false, true, nil] as [Bool?])
    func `catalog transport negotiates session metadata and preserves old server scope`(
        sessionScoped: Bool?) async throws
    {
        try await self.withFixture(sessionScoped: sessionScoped) { fixture in
            await fixture.server.setScopedModels(["saved-a"], sessionKey: "agent:a:saved", agentID: "a")
            _ = try await fixture.gateway.request(method: "health", params: nil)
            let transport = MacGatewayChatTransport(connection: fixture.gateway, defaultGlobalAgentID: "b")
            let catalog = try await transport.loadModelCatalog(sessionKey: "agent:a:saved", agentID: nil)

            if sessionScoped == true {
                #expect(catalog.availabilityIsSessionScoped)
                #expect(catalog.choices.map(\.selectionID) == ["fixture/saved-a"])
                let request = try #require(await fixture.server.requestSnapshot().last)
                #expect(request.method == "chat.metadata")
                #expect(request.params?.sessionKey == "agent:a:saved")
                #expect(request.params?.agentId == "a")
            } else {
                #expect(!catalog.availabilityIsSessionScoped)
                #expect(catalog.choices.map(\.selectionID) == ["fixture/choice-a", "fixture/choice-b"])
                let request = try #require(await fixture.server.requestSnapshot().last)
                #expect(request.method == "models.list")
                #expect(request.params?.sessionKey == nil)
            }
            await fixture.server.setScopedModels([], sessionKey: "agent:a:saved", agentID: "a")
            await fixture.server.setModels([])
            let empty = try await transport.loadModelCatalog(sessionKey: "agent:a:saved", agentID: nil)
            #expect(empty.choices.isEmpty)
        }
    }

    @Test func `catalog requests distinguish canonical agent and bare global ownership`() async throws {
        try await self.withFixture { fixture in
            await fixture.server.setScopedModels(["scoped-a"], sessionKey: "agent:a:main", agentID: "a")
            await fixture.server.setScopedModels(["scoped-b"], sessionKey: "agent:b:main", agentID: "b")
            await fixture.server.setScopedModels(["scoped-b"], sessionKey: "global", agentID: "b")
            _ = try await fixture.gateway.request(method: "health", params: nil)
            let transport = MacGatewayChatTransport(connection: fixture.gateway, defaultGlobalAgentID: "a")
            let first = try await transport.loadModelCatalog(sessionKey: "agent:a:main", agentID: nil)
            let second = try await transport.loadModelCatalog(sessionKey: "agent:b:main", agentID: nil)
            let global = try await transport.loadModelCatalog(sessionKey: "global", agentID: "b")

            #expect(first.choices.map(\.selectionID) == ["fixture/scoped-a"])
            #expect(second.choices.map(\.selectionID) == ["fixture/scoped-b"])
            #expect(global.choices.map(\.selectionID) == ["fixture/scoped-b"])
            let request = try #require(await fixture.server.requestSnapshot().last)
            #expect(request.params?.sessionKey == "global")
            #expect(request.params?.agentId == "b")
        }
    }

    @Test(arguments: ["chat.metadata.changed", "config.changed"])
    func `open controller consumes repeated wire publications without losing the draft`(event: String) async throws {
        try await self.withFixture { fixture in
            let controller = fixture.makeController()
            let model = controller.model
            controller.present()
            try await self.waitForReady(model)
            let presentationID = try #require(model.activePresentationID)
            model.text = "Keep the open presentation draft"

            await fixture.server.setModels(["choice-b", "choice-c"])
            try await fixture.publish(event: event, sequence: 1)
            try await QuickChatCatalogGatewayFixture.waitForModel {
                model.modelChoices.map(\.selectionID) == ["fixture/choice-b", "fixture/choice-c"]
            }
            await fixture.server.setModels(["choice-c", "choice-d"])
            try await fixture.publish(event: event, sequence: 2)
            try await QuickChatCatalogGatewayFixture.waitForModel {
                model.modelChoices.map(\.selectionID) == ["fixture/choice-c", "fixture/choice-d"]
            }
            await fixture.server.setModels([])
            try await fixture.publish(event: event, sequence: 3)
            try await QuickChatCatalogGatewayFixture.waitForModel {
                model.modelChoices.isEmpty && !model.isLoadingModelControls
            }

            #expect(controller.isVisible)
            #expect(model.activePresentationID == presentationID)
            #expect(model.text == "Keep the open presentation draft")
            #expect(model.modelControlStatusMessage == nil)
        }
    }

    @Test(arguments: QuickChatCatalogGatewayServer.CatalogFailure.allCases)
    func `publication errors retain choices until the current wire catalog recovers`(
        failure: QuickChatCatalogGatewayServer.CatalogFailure) async throws
    {
        try await self.withFixture { fixture in
            let controller = fixture.makeController()
            let model = controller.model
            controller.present()
            try await self.waitForReady(model)
            model.text = "Keep the recovery draft"
            await fixture.server.setFailure(failure, method: "chat.metadata")
            try await fixture.publish(event: "chat.metadata.changed", sequence: 1)
            try await QuickChatCatalogGatewayFixture.waitForModel { model.modelControlStatusMessage != nil }

            #expect(model.modelChoices.map(\.selectionID) == ["fixture/choice-a", "fixture/choice-b"])
            #expect(model.modelControlStatusMessage == "Couldn't load model settings.")
            await fixture.server.setFailure(nil)
            await fixture.server.setModels(["choice-b", "choice-c"])
            try await fixture.publish(event: "chat.metadata.changed", sequence: 2)
            try await QuickChatCatalogGatewayFixture.waitForModel {
                model.modelChoices.map(\.selectionID) == ["fixture/choice-b", "fixture/choice-c"] &&
                    model.modelControlStatusMessage == nil
            }

            #expect(controller.isVisible)
            #expect(model.text == "Keep the recovery draft")
            #expect(await fixture.server.requestSnapshot().allSatisfy { $0.method != "models.list" })
        }
    }

    @Test(arguments: ["chat.metadata", "sessions.list", "agents.list"], [false, true])
    func `retired aggregate outcomes cannot overwrite reconnect publication`(
        method: String, fails: Bool) async throws
    {
        try await self.withFixture { fixture in
            let controller = fixture.makeController()
            let model = controller.model
            controller.present()
            try await self.waitForReady(model)
            model.text = "Keep the reconnect draft"
            let started = AsyncTestGate()
            await fixture.server.setModels(["choice-b", "choice-c"])
            if fails { await fixture.server.setFailure(.rpc, method: method) }
            await fixture.server.holdNext(
                method: method,
                target: method == "agents.list" ? nil : "agent:a:main",
                started: started)
            try await fixture.publish(event: "chat.metadata.changed", sequence: 1)
            await started.wait()

            await fixture.gateway.shutdown()
            try await QuickChatCatalogGatewayFixture.waitForModel { !model.isLoadingModelControls }
            #expect(model.modelChoices.map(\.selectionID) == ["fixture/choice-a", "fixture/choice-b"])
            #expect(model.modelControlStatusMessage == nil)
            await fixture.server.setFailure(nil)
            await fixture.server.setModels(["choice-d"])
            _ = try await fixture.gateway.request(method: "health", params: nil)
            try await QuickChatCatalogGatewayFixture.waitForModel {
                model.modelChoices.map(\.selectionID) == ["fixture/choice-d"]
            }
            await fixture.server.releaseHeldResponse()
            _ = try await fixture.gateway.request(method: "health", params: nil)

            #expect(model.modelChoices.map(\.selectionID) == ["fixture/choice-d"])
            #expect(model.modelControlStatusMessage == nil)
            #expect(model.text == "Keep the reconnect draft")
        }
    }

    @Test(arguments: QuickChatCatalogGatewayServer.CatalogFailure.allCases)
    func `failed target catalog cannot offer choices from the previous agent`(
        failure: QuickChatCatalogGatewayServer.CatalogFailure) async throws
    {
        try await self.withFixture { fixture in
            await fixture.server.setScopedModels(["only-a"], sessionKey: "agent:a:main", agentID: "a")
            await fixture.server.setScopedModels(["only-b"], sessionKey: "agent:b:main", agentID: "b")
            let controller = fixture.makeController()
            let model = controller.model
            controller.present()
            try await self.waitForReady(model)
            #expect(model.modelChoices.map(\.selectionID) == ["fixture/only-a"])
            model.text = "Keep the target-change draft"
            await fixture.server.setFailure(failure, method: "chat.metadata")

            model.selectAgent("b")
            try await QuickChatCatalogGatewayFixture.waitForModel { !model.isLoadingModelControls }

            #expect(model.modelChoices.isEmpty)
            #expect(model.modelControlStatusMessage == "Couldn't load model settings.")
            model.selectModel("fixture/only-a")
            #expect(model.selectedModelSelectionID == nil)
            #expect(!model.isUpdatingModel)
            #expect(await fixture.server.requestSnapshot().allSatisfy { $0.method != "sessions.patch" })
            #expect(await fixture.server.model(for: "b") == "choice-b")

            await fixture.server.setFailure(nil)
            let presentationID = try #require(model.activePresentationID)
            await model.refreshForPresentation(id: presentationID)
            try await self.waitForReady(model)

            #expect(model.routingTarget == QuickChatRoutingTarget(sessionKey: "agent:b:main", agentID: nil))
            #expect(model.modelChoices.map(\.selectionID) == ["fixture/only-b"])
            #expect(model.modelControlStatusMessage == nil)
            #expect(model.text == "Keep the target-change draft")
        }
    }

    @Test func `late agent read cannot overwrite the selected target`() async throws {
        try await self.withFixture { fixture in
            let controller = fixture.makeController()
            let model = controller.model
            controller.present()
            try await self.waitForReady(model)
            model.text = "Draft for the selected agent"
            let started = AsyncTestGate()
            await fixture.server.holdNext(method: "sessions.list", target: "agent:a:main", started: started)
            model.selectSessionOverride(nil)
            await started.wait()

            model.selectAgent("b")
            try await self.waitForReady(model)
            #expect(model.currentSessionModelSelectionID == "fixture/choice-b")
            await fixture.server.releaseHeldResponse()
            _ = try await fixture.gateway.request(method: "health", params: nil)

            #expect(model.routingTarget == QuickChatRoutingTarget(sessionKey: "agent:b:main", agentID: nil))
            #expect(model.currentSessionModelSelectionID == "fixture/choice-b")
            #expect(model.text == "Draft for the selected agent")
        }
    }

    @Test func `accepted wire patch settles after hide and same target reopen without resend`() async throws {
        try await self.withFixture { fixture in
            let controller = fixture.makeController()
            let model = controller.model
            controller.present()
            try await self.waitForReady(model)
            model.text = "Draft survives the accepted selection"
            let started = AsyncTestGate()
            await fixture.server.holdNext(method: "sessions.patch", started: started)
            model.selectModel("fixture/choice-b")
            await started.wait()
            await fixture.server.setModels(["choice-b", "choice-c"])
            try await fixture.publish(event: "chat.metadata.changed", sequence: 1)

            controller.dismiss()
            controller.present()
            await fixture.server.releaseHeldResponse()
            try await self.waitForReady(model)

            #expect(controller.isVisible)
            #expect(model.currentSessionModelSelectionID == "fixture/choice-b")
            #expect(model.modelChoices.map(\.selectionID) == ["fixture/choice-b", "fixture/choice-c"])
            #expect(model.text == "Draft survives the accepted selection")
            #expect(await fixture.server.model(for: "a") == "choice-b")
            #expect(await fixture.server.requestSnapshot().filter { $0.method == "sessions.patch" }.count == 1)
        }
    }

    @Test func `another target initializes while an accepted wire patch remains held`() async throws {
        try await self.withFixture { fixture in
            let controller = fixture.makeController()
            let model = controller.model
            controller.present()
            try await self.waitForReady(model)
            let started = AsyncTestGate()
            await fixture.server.holdNext(method: "sessions.patch", started: started)
            model.selectModel("fixture/choice-b")
            await started.wait()
            controller.dismiss()
            await fixture.server.setAgents(["b"])
            controller.present()
            try await self.waitForReady(model)

            #expect(model.routingTarget == QuickChatRoutingTarget(sessionKey: "agent:b:main", agentID: nil))
            #expect(await fixture.server.model(for: "a") == "choice-a")
            await fixture.server.releaseHeldResponse()
            _ = try await fixture.gateway.request(method: "health", params: nil)
            #expect(model.currentSessionModelSelectionID == "fixture/choice-b")
            #expect(await fixture.server.model(for: "a") == "choice-b")
            #expect(await fixture.server.requestSnapshot().filter { $0.method == "sessions.patch" }.count == 1)
        }
    }

    @Test func `publication deliveries carry live server ownership across reconnect and gaps`() async throws {
        try await self.withFixture { fixture in
            _ = try await fixture.gateway.request(method: "health", params: nil)
            var deliveries = await fixture.gateway.subscribe().makeAsyncIterator()
            let snapshot = try #require(await deliveries.next())
            #expect(snapshot.isCurrent)
            try await fixture.publish(event: "chat.metadata.changed", sequence: 1)
            let publication = try #require(await deliveries.next())
            #expect(publication.isCurrent)
            guard let publicationPush = publication.push, case let .event(event) = publicationPush else {
                Issue.record("Expected the actual catalog publication frame")
                return
            }
            #expect(event.event == "chat.metadata.changed")

            await fixture.gateway.shutdown()
            #expect(!publication.isCurrent)
            _ = try await fixture.gateway.request(method: "health", params: nil)
            let replacement = try #require(await fixture.gateway.captureServerLease())
            #expect(replacement != publication.serverLease)
            #expect(!publication.isCurrent)

            var current = await fixture.gateway.subscribe().makeAsyncIterator()
            let currentSnapshot = try #require(await current.next())
            #expect(currentSnapshot.isCurrent)
            try await fixture.publish(event: "config.changed", sequence: 1)
            _ = try #require(await current.next())
            try await fixture.publish(event: "chat.metadata.changed", sequence: 3)
            let gap = try #require(await current.next())
            guard let gapPush = gap.push, case .seqGap(expected: 2, received: 3) = gapPush else {
                Issue.record("Expected the actual wire sequence gap")
                return
            }
            #expect(gap.isCurrent)
        }
    }

    @Test func `bare global controller targets retain the selected agent on reads and writes`() async throws {
        try await self.withFixture(scope: "global") { fixture in
            let controller = fixture.makeController()
            let model = controller.model
            controller.present()
            try await self.waitForReady(model)
            model.selectAgent("b")
            try await self.waitForReady(model)
            #expect(model.routingTarget == QuickChatRoutingTarget(sessionKey: "global", agentID: "b"))
            #expect(model.currentSessionModelSelectionID == "fixture/choice-b")

            model.selectModel("fixture/choice-a")
            try await self.waitForReady(model)
            let requests = await fixture.server.requestSnapshot()
            let patch = try #require(requests.last { $0.method == "sessions.patch" })
            #expect(patch.params?.key == "global")
            #expect(patch.params?.agentId == "b")
            #expect(await fixture.server.model(for: "b") == "choice-a")
        }
    }

    @Test func `retired transport write lease cannot mutate the replacement server`() async throws {
        try await self.withFixture { fixture in
            _ = try await fixture.gateway.request(method: "health", params: nil)
            let transport = MacGatewayChatTransport(connection: fixture.gateway, defaultGlobalAgentID: "a")
            let lease = try #require(await transport.acquireSessionSettingsRouteLease())
            await fixture.gateway.shutdown()
            _ = try await fixture.gateway.request(method: "health", params: nil)
            do {
                _ = try await lease.patchSessionSettings(
                    sessionKey: "agent:a:main",
                    agentID: nil,
                    patch: OpenClawChatSessionSettingsPatch(model: .some("fixture/choice-b")))
                Issue.record("A retired write lease must not dispatch to the replacement server")
            } catch OpenClawChatTransportSendError.notDispatched {
            }
            #expect(await fixture.server.model(for: "a") == "choice-a")
            #expect(await fixture.server.requestSnapshot().filter { $0.method == "sessions.patch" }.isEmpty)
        }
    }

    private func waitForReady(_ model: QuickChatModel) async throws {
        try await QuickChatCatalogGatewayFixture.waitForModel {
            model.routingTarget != nil && !model.isLoadingModelControls && !model.isUpdatingModel
        }
    }

    private func withFixture(
        sessionScoped: Bool? = true,
        scope: String = "per-agent",
        _ body: (QuickChatCatalogGatewayFixture) async throws -> Void) async throws
    {
        let fixture = QuickChatCatalogGatewayFixture(sessionScoped: sessionScoped, scope: scope)
        do {
            try await body(fixture)
            await fixture.close()
        } catch {
            await fixture.close()
            throw error
        }
    }
}
