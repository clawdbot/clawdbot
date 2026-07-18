import Foundation
import OpenClawChatUI
import OpenClawIPC
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct QuickChatModelTests {
    @Test(arguments: ["started", "ok", "in_flight"])
    func `accepted send clears text`(_ status: String) async {
        let model = self.makeModel(sendStatus: status)
        await self.prepare(model)
        model.text = " hello "

        #expect(await model.send())
        #expect(model.sendState == .sent)
        #expect(model.text.isEmpty)
    }

    @Test func `new draft clears sent presentation state`() async {
        let model = self.makeModel()
        await self.prepare(model)
        model.text = "first"
        #expect(await model.send())
        #expect(model.sendState == .sent)

        model.text = "second"

        #expect(model.sendState == .idle)
    }

    @Test(arguments: ["error", "timeout"])
    func `terminal failure preserves text`(_ status: String) async {
        let model = self.makeModel(sendStatus: status)
        await self.prepare(model)
        model.text = "hello"

        #expect(await !(model.send()))
        guard case let .failed(message) = model.sendState else {
            Issue.record("expected failed send state")
            return
        }
        #expect(message.contains(status))
        #expect(model.text == "hello")
    }

    @Test func `thrown send error becomes failure`() async {
        let model = self.makeModel(sendError: FakeSendError.rejected)
        await self.prepare(model)
        model.text = "hello"

        #expect(await !(model.send()))
        #expect(model.sendState == QuickChatSendState.failed("Fake rejection"))
        #expect(model.text == "hello")
    }

    @Test func `unchanged draft reuses idempotency key after transport failure`() async {
        var keys: [String] = []
        let model = self.makeModel(sendHandler: { _, _, _, idempotencyKey, _ in
            keys.append(idempotencyKey)
            if keys.count == 1 { throw FakeSendError.rejected }
            return "started"
        })
        await self.prepare(model)
        model.text = "hello"

        #expect(await !(model.send()))
        #expect(await model.send())
        #expect(keys.count == 2)
        #expect(keys[0] == keys[1])
    }

    @Test func `edited draft gets new idempotency key`() async {
        var keys: [String] = []
        let model = self.makeModel(sendHandler: { _, _, _, idempotencyKey, _ in
            keys.append(idempotencyKey)
            throw FakeSendError.rejected
        })
        await self.prepare(model)
        model.text = "first"
        #expect(await !(model.send()))

        model.text = "second"
        #expect(await !(model.send()))

        #expect(keys.count == 2)
        #expect(keys[0] != keys[1])
    }

    @Test func `empty text does not call gateway`() async {
        var sendCount = 0
        let model = self.makeModel(sendHandler: { _, _, _, _, _ in
            sendCount += 1
            return "ok"
        })
        await self.prepare(model)
        model.text = "  \n "

        #expect(await !(model.send()))
        #expect(sendCount == 0)
        #expect(model.sendState == .idle)
    }

    @Test func `disconnected gateway disables send`() async {
        var sendCount = 0
        let model = self.makeModel(
            gate: .disconnected,
            sendHandler: { _, _, _, _, _ in
                sendCount += 1
                return "ok"
            })
        await self.prepare(model)
        model.text = "hello"

        #expect(!model.canSend)
        #expect(model.connectionStatusMessage == "Gateway disconnected")
        #expect(await !(model.send()))
        #expect(sendCount == 0)
    }

    @Test func `new presentation disables send until session key refreshes`() async {
        let model = self.makeModel()
        await self.prepare(model)
        model.text = "hello"
        #expect(model.canSend)

        model.endPresentation()
        _ = model.beginPresentation()

        #expect(model.sessionKey.isEmpty)
        #expect(!model.canSend)
    }

    @Test func `dismissal lets dispatched send settle without retry`() async {
        let latch = SendLatch()
        let model = self.makeModel(sendHandler: { _, _, _, _, _ in
            try await latch.wait()
        })
        await self.prepare(model)
        model.text = "hello"

        let send = Task { await model.send() }
        while !latch.started {
            await Task.yield()
        }
        model.endPresentation()
        latch.finish(with: "started")

        #expect(await send.value)
        #expect(latch.callCount == 1)
        #expect(model.text.isEmpty)
        #expect(model.sendState == .sent)
    }

    @Test func `cached agent display survives representation for the same session`() async {
        let model = self.makeModel()
        await self.prepare(model)
        #expect(model.agentDisplay.name == "Molty")

        model.endPresentation()
        _ = model.beginPresentation()

        #expect(model.agentDisplay.name == "Molty")
    }

    @Test func `selected agent resets to refreshed default when missing`() async {
        let results = AgentsResultsBox(results: [
            Self.agentsResult(defaultID: "one", agentIDs: ["one", "two"]),
            Self.agentsResult(defaultID: "three", agentIDs: ["three", "four"]),
        ])
        let model = self.makeModel(agentsProvider: { results.next() })
        await self.prepare(model)
        model.selectAgent("two")
        #expect(model.selectedAgentID == "two")

        model.endPresentation()
        await self.prepare(model)

        #expect(model.selectedAgentID == "three")
        #expect(model.sessionKey == "agent:three:main")
    }

    @Test func `grant refreshes permission status immediately`() async {
        let granted = GrantFlag()
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentsProvider: { Self.agentsResult(defaultID: "main", agentIDs: ["main"]) },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map {
                    ($0, granted.value || $0 != .screenRecording)
                })
            },
            permissionGrantProvider: { capabilities in
                granted.value = true
                return Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available })
        await self.prepare(model)
        #expect(model.missingPermissions == [.screenRecording])

        model.grantMissingPermissions()
        while model.isGrantingPermissions {
            await Task.yield()
        }

        #expect(model.missingPermissions.isEmpty)
        #expect(!model.shouldShowPermissionStrip)
    }

    @Test func `routing target follows scope contract`() {
        #expect(QuickChatModel.routingTarget(
            scope: "global",
            selectedAgentID: "research",
            mainKey: "main") == QuickChatRoutingTarget(sessionKey: "global", agentID: "research"))
        #expect(QuickChatModel.routingTarget(
            scope: "per-agent",
            selectedAgentID: "research",
            mainKey: "daily") == QuickChatRoutingTarget(
            sessionKey: "agent:research:daily",
            agentID: nil))
    }

    @Test func `agent display parses avatar forms and monogram`() throws {
        let imageData = Data([0x89, 0x50, 0x4E, 0x47])
        let dataSummary = AgentSummary(
            id: "molty",
            name: "Molty",
            identity: [
                "emoji": AnyCodable("🦞"),
                "avatarUrl": AnyCodable("data:image/png;base64,\(imageData.base64EncodedString())"),
            ])
        let dataDisplay = QuickChatAgentDisplay(summary: dataSummary)
        #expect(dataDisplay.emoji == "🦞")
        #expect(dataDisplay.avatar == .image(imageData))
        #expect(dataDisplay.monogram == "M")

        // Remote URLs are never fetched (SSRF surface); they fall back to emoji/monogram.
        let remoteDisplay = QuickChatAgentDisplay(summary: AgentSummary(
            id: "remote",
            identity: ["avatarUrl": AnyCodable("https://example.com/avatar.png")]))
        #expect(remoteDisplay.name == "remote")
        #expect(remoteDisplay.avatar == .none)
        #expect(remoteDisplay.monogram == "R")

        let relativeDisplay = QuickChatAgentDisplay(summary: AgentSummary(
            id: "relative",
            identity: ["avatarUrl": AnyCodable("/avatar/relative")]))
        #expect(relativeDisplay.avatar == .none)

        let oversized = String(repeating: "A", count: 8_000_004)
        let oversizedDisplay = QuickChatAgentDisplay(summary: AgentSummary(
            id: "large",
            identity: ["avatarUrl": AnyCodable("data:image/png;base64,\(oversized)")]))
        #expect(oversizedDisplay.avatar == .none)
    }

    @Test func `agent selection before refresh keeps routing empty`() async {
        let model = self.makeModel(agentsProvider: {
            Self.agentsResult(defaultID: "one", agentIDs: ["one", "two"])
        })
        await self.prepare(model)
        #expect(!model.sessionKey.isEmpty)

        model.endPresentation()
        _ = model.beginPresentation()
        model.selectAgent("two")

        #expect(model.sessionKey.isEmpty)
        model.text = "hello"
        #expect(!model.canSend)
    }

    @Test func `accepted send records its immutable route`() async {
        let model = self.makeModel()
        await self.prepare(model)
        model.text = "hello"

        #expect(await model.send())
        #expect(model.lastAcceptedRoute == QuickChatRoutingTarget(
            sessionKey: "agent:main:main",
            agentID: nil))
    }

    @Test func `edits during a screenshot send survive and keep their draft`() async throws {
        let latch = SendLatch()
        var receivedMessage: String?
        let model = self.makeModel(sendHandler: { _, _, message, _, _ in
            receivedMessage = message
            return try await latch.wait()
        })
        await self.prepare(model)
        let png =
            try #require(
                Data(
                    base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
        let pipelineID = try #require(model.beginCapturePipeline())
        let send = Task { await model.sendWindowScreenshot(
            pipelineID: pipelineID,
            data: png,
            appName: "Safari",
            title: "Docs") }
        while !latch.started {
            await Task.yield()
        }
        // The screenshot send is suspended in flight; edits made now must survive it.
        model.text = "typed while sending"
        latch.finish(with: "started")

        #expect(await send.value)
        #expect(receivedMessage == "Screenshot: Safari — Docs")
        #expect(model.text == "typed while sending")
        #expect(model.sendState == .idle)
    }

    @Test func `capture pipeline blocks concurrent sends and unwinds`() async {
        var sendCount = 0
        let model = self.makeModel(sendHandler: { _, _, _, _, _ in
            sendCount += 1
            return "ok"
        })
        await self.prepare(model)

        let pipelineID = model.beginCapturePipeline()
        #expect(pipelineID != nil)
        #expect(model.sendState == .sending)
        #expect(model.beginCapturePipeline() == nil)
        model.text = "typed during capture"
        #expect(!model.canSend)
        #expect(!model.canCaptureWindow)
        #expect(await !(model.send()))
        #expect(sendCount == 0)

        model.cancelCapturePipeline(pipelineID ?? UUID())
        #expect(model.sendState == .idle)
        #expect(model.canSend)
    }

    @Test func `stale pipeline token cannot reset a newer pipeline`() throws {
        let model = self.makeModel()
        let staleID = try #require(model.beginCapturePipeline())
        model.cancelCapturePipeline(staleID)
        #expect(model.sendState == .idle)

        let currentID = try #require(model.beginCapturePipeline())
        model.cancelCapturePipeline(staleID)
        model.failCapturePipeline(staleID)
        #expect(model.sendState == .sending)

        model.cancelCapturePipeline(currentID)
        #expect(model.sendState == .idle)
    }

    @Test func `window screenshot sends attachment and default caption`() async throws {
        var receivedMessage: String?
        var receivedAttachments: [OpenClawChatAttachmentPayload] = []
        let model = self.makeModel(sendHandler: { _, _, message, _, attachments in
            receivedMessage = message
            receivedAttachments = attachments
            return "started"
        })
        await self.prepare(model)
        let png =
            try #require(
                Data(
                    base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))

        let pipelineID = try #require(model.beginCapturePipeline())
        #expect(await model.sendWindowScreenshot(
            pipelineID: pipelineID,
            data: png,
            appName: "Safari",
            title: "Docs"))
        #expect(receivedMessage == "Screenshot: Safari — Docs")
        #expect(receivedAttachments.count == 1)
        #expect(receivedAttachments[0].type == "file")
        #expect(receivedAttachments[0].mimeType == "image/jpeg")
        #expect(receivedAttachments[0].fileName == "window-safari.jpg")
        #expect(!receivedAttachments[0].content.hasPrefix("data:"))
    }

    @Test func `permission strip tracks missing permissions and session dismissal`() async {
        let model = self.makeModel(permissionStatus: [
            .notifications: false,
            .accessibility: true,
            .screenRecording: false,
        ])
        await self.prepare(model)

        #expect(model.missingPermissions == [.notifications, .screenRecording])
        #expect(model.shouldShowPermissionStrip)
        model.dismissPermissionsForSession()
        #expect(!model.shouldShowPermissionStrip)
    }

    private func prepare(_ model: QuickChatModel) async {
        let id = model.beginPresentation()
        await model.refreshForPresentation(id: id)
    }

    private func makeModel(
        gate: QuickChatConnectionGate = .available,
        sendStatus: String = "ok",
        sendError: Error? = nil,
        permissionStatus: [Capability: Bool]? = nil,
        agentsProvider: QuickChatModel.AgentsProvider? = nil,
        sendHandler: QuickChatModel.SendProvider? = nil) -> QuickChatModel
    {
        QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: agentsProvider ?? {
                Self.agentsResult(defaultID: "main", agentIDs: ["main"], names: ["Molty"])
            },
            agentIdentityProvider: { _ in
                QuickChatAgentDisplay(id: "main", name: "Molty", emoji: "🦞")
            },
            sendProvider: sendHandler ?? { _, _, _, _, _ in
                if let sendError { throw sendError }
                return sendStatus
            },
            permissionStatusProvider: { capabilities in
                permissionStatus ?? Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { gate })
    }

    private static func agentsResult(
        defaultID: String,
        agentIDs: [String],
        names: [String] = []) -> AgentsListResult
    {
        AgentsListResult(
            defaultid: defaultID,
            mainkey: "main",
            scope: AnyCodable("per-agent"),
            agents: agentIDs.enumerated().map { index, id in
                AgentSummary(
                    id: id,
                    name: names.indices.contains(index) ? names[index] : id,
                    identity: ["emoji": AnyCodable("🦞")])
            })
    }
}

private enum FakeSendError: LocalizedError {
    case rejected

    var errorDescription: String? {
        "Fake rejection"
    }
}

@MainActor
private final class GrantFlag {
    var value = false
}

@MainActor
private final class AgentsResultsBox {
    private var results: [AgentsListResult]

    init(results: [AgentsListResult]) {
        self.results = results
    }

    func next() -> AgentsListResult {
        self.results.removeFirst()
    }
}

@MainActor
private final class SendLatch {
    private var continuation: CheckedContinuation<String, any Error>?
    private(set) var callCount = 0

    var started: Bool {
        self.continuation != nil
    }

    func wait() async throws -> String {
        self.callCount += 1
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func finish(with status: String) {
        self.continuation?.resume(returning: status)
        self.continuation = nil
    }
}
