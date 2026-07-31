import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private struct MemoryImportWireRequest: Sendable {
    let id: String
    let method: String
    let agentId: String?
    let providerId: String?
    let planFingerprint: String?
    let itemIds: [String]
    let overwrite: Bool?
    let idempotencyKey: String?
}

private actor MemoryImportRequestRecorder {
    private var requests: [MemoryImportWireRequest] = []

    func record(_ request: MemoryImportWireRequest) {
        self.requests.append(request)
    }

    func snapshot() -> [MemoryImportWireRequest] {
        self.requests
    }
}

private actor MemoryImportRequestGate {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        self.started = true
        self.startWaiters.forEach { $0.resume() }
        self.startWaiters.removeAll()
        guard !self.released else { return }
        await withCheckedContinuation { self.releaseWaiters.append($0) }
    }

    func waitUntilStarted() async {
        guard !self.started else { return }
        await withCheckedContinuation { self.startWaiters.append($0) }
    }

    func release() {
        self.released = true
        self.releaseWaiters.forEach { $0.resume() }
        self.releaseWaiters.removeAll()
    }
}

private actor MemoryImportApplyCounter {
    private var counts: [String: Int] = [:]

    func next(for providerId: String) -> Int {
        let next = (self.counts[providerId] ?? 0) + 1
        self.counts[providerId] = next
        return next
    }
}

private final class MemoryImportGatewayConfig: @unchecked Sendable {
    private let lock = NSLock()
    private let url: URL
    private var token: String

    init(url: URL, token: String) {
        self.url = url
        self.token = token
    }

    func setToken(_ token: String) {
        self.lock.lock()
        self.token = token
        self.lock.unlock()
    }

    func snapshot() -> GatewayConnection.Config {
        self.lock.lock()
        defer { self.lock.unlock() }
        return (url: self.url, token: self.token, password: nil)
    }
}

private func memoryImportWireRequest(
    from message: URLSessionWebSocketTask.Message) -> MemoryImportWireRequest?
{
    let data: Data? = switch message {
    case let .data(data): data
    case let .string(string): string.data(using: .utf8)
    @unknown default: nil
    }
    guard let data,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = object["id"] as? String,
          let method = object["method"] as? String
    else { return nil }
    let params = object["params"] as? [String: Any] ?? [:]
    return MemoryImportWireRequest(
        id: id,
        method: method,
        agentId: params["agentId"] as? String,
        providerId: params["providerId"] as? String,
        planFingerprint: params["planFingerprint"] as? String,
        itemIds: params["itemIds"] as? [String] ?? [],
        overwrite: params["overwrite"] as? Bool,
        idempotencyKey: params["idempotencyKey"] as? String)
}

private func memoryImportOK(id: String, payload: String) -> Data {
    Data(#"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)
}

private func memoryImportError(id: String, message: String) -> Data {
    Data(
        #"{"type":"res","id":"\#(id)","ok":false,"error":{"code":"INVALID_REQUEST","message":"\#(message)"}}"#.utf8)
}

private let memoryImportEmptyPlanPayload = #"{"agentId":"main","workspace":"/tmp/workspace","providers":[]}"#

private let memoryImportOfferPlanPayload = #"""
{
  "agentId":"main",
  "workspace":"/tmp/workspace",
  "providers":[
    {
      "providerId":"claude",
      "label":"Claude",
      "planFingerprint":"plan-claude",
      "found":true,
      "source":"~/.claude",
      "summary":{"total":3,"planned":2,"migrated":0,"skipped":0,"conflicts":1,"errors":0,"sensitive":0},
      "items":[
        {"id":"planned-1","status":"planned"},
        {"id":"conflict-1","status":"conflict"},
        {"id":"planned-2","status":"planned"}
      ]
    },
    {
      "providerId":"codex",
      "label":"Codex",
      "planFingerprint":"plan-codex",
      "found":true,
      "source":"~/.codex",
      "summary":{"total":1,"planned":1,"migrated":0,"skipped":0,"conflicts":0,"errors":0,"sensitive":0},
      "items":[{"id":"codex-1","status":"planned"}]
    }
  ]
}
"""#

private let memoryImportProviderErrorPlanPayload = #"""
{
  "agentId":"main",
  "workspace":"/tmp/workspace",
  "providers":[
    {
      "providerId":"claude",
      "label":"Claude",
      "found":true,
      "source":"~/.claude",
      "summary":{"total":0,"planned":0,"migrated":0,"skipped":0,"conflicts":0,"errors":1,"sensitive":0},
      "items":[],
      "error":"Could not read Claude memories"
    }
  ]
}
"""#

private let memoryImportSummaryErrorPlanPayload = #"""
{
  "agentId":"main",
  "workspace":"/tmp/workspace",
  "providers":[
    {
      "providerId":"claude",
      "label":"Claude",
      "found":true,
      "summary":{"total":0,"planned":0,"migrated":0,"skipped":0,"conflicts":0,"errors":1,"sensitive":0},
      "items":[]
    }
  ]
}
"""#

private let memoryImportMissingFingerprintPlanPayload = #"""
{
  "agentId":"main",
  "workspace":"/tmp/workspace",
  "providers":[
    {
      "providerId":"claude",
      "label":"Claude",
      "found":true,
      "source":"~/.claude",
      "summary":{"total":1,"planned":1,"migrated":0,"skipped":0,"conflicts":0,"errors":0,"sensitive":0},
      "items":[{"id":"planned-1","status":"planned"}]
    }
  ]
}
"""#

private let memoryImportInconsistentProviderPlanPayload = #"""
{
  "agentId":"main",
  "workspace":"/tmp/workspace",
  "providers":[
    {
      "providerId":"claude",
      "label":"Claude",
      "planFingerprint":"plan-claude",
      "found":true,
      "summary":{"total":1,"planned":1,"migrated":0,"skipped":0,"conflicts":0,"errors":0,"sensitive":0},
      "items":[{"id":"planned-1","status":"planned"}]
    },
    {
      "providerId":"broken",
      "label":"Broken",
      "planFingerprint":"plan-broken",
      "found":false,
      "summary":{"total":1,"planned":1,"migrated":0,"skipped":0,"conflicts":0,"errors":0,"sensitive":0},
      "items":[{"id":"broken-1","status":"planned"}]
    }
  ]
}
"""#

private let memoryImportDuplicateProviderPlanPayload = #"""
{
  "agentId":"main",
  "workspace":"/tmp/workspace",
  "providers":[
    {
      "providerId":"duplicate",
      "label":"First",
      "found":false,
      "summary":{"total":0,"planned":0,"migrated":0,"skipped":0,"conflicts":0,"errors":0,"sensitive":0},
      "items":[]
    },
    {
      "providerId":"duplicate",
      "label":"Second",
      "found":false,
      "summary":{"total":0,"planned":0,"migrated":0,"skipped":0,"conflicts":0,"errors":0,"sensitive":0},
      "items":[]
    }
  ]
}
"""#

private func memoryImportApplyPayload(providerId: String, migrated: Int, errors: Int = 0) -> String {
    #"{"providerId":"\#(providerId)","source":"local","summary":{"total":\#(migrated + errors),"planned":0,"migrated":\#(migrated),"skipped":0,"conflicts":0,"errors":\#(errors),"sensitive":0},"items":[]}"#
}

private func makeMemoryImportGateway(
    configProvider: @escaping @Sendable () async throws -> GatewayConnection.Config,
    responder: @escaping @Sendable (GatewayTestWebSocketTask, MemoryImportWireRequest) async -> Void)
    -> GatewayConnection
{
    GatewayConnection(
        configProvider: configProvider,
        sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = memoryImportWireRequest(from: message) else { return }
                await responder(task, request)
            })
        })))
}

@Suite(.serialized)
@MainActor
struct OnboardingMemoryImportTests {
    private func withTemporaryStateDir<T>(_ operation: () async throws -> T) async throws -> T {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        return try await DeviceIdentityStore.withStateDirectory(tempDir) {
            try await operation()
        }
    }

    @Test func `plan maps planned and already imported memories into an offer`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                let payload = request.method == "health" ? "{}" : memoryImportOfferPlanPayload
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()

        await model.startPlanning(gateway: gateway, agentId: "main")

        #expect(model.hasOffer)
        #expect(model.providers.count == 2)
        #expect(model.providers[0].providerId == "claude")
        #expect(model.providers[0].plannedCount == 2)
        #expect(model.providers[0].alreadyImportedCount == 1)
        #expect(model.providers[0].selected)
        #expect(model.providers[1].plannedCount == 1)
    }

    @Test func `empty plan resolves without an offer`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                let payload = request.method == "health" ? "{}" : memoryImportEmptyPlanPayload
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()

        await model.startPlanning(gateway: gateway, agentId: "main")

        #expect(model.resolvedEmpty)
        #expect(!model.hasOffer)
        #expect(!model.pageEligible)
    }

    @Test func `provider planning error remains retryable instead of resolving empty`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                let payload = request.method == "migrations.memory.plan"
                    ? memoryImportProviderErrorPlanPayload
                    : "{}"
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()

        await model.startPlanning(gateway: gateway, agentId: "main")

        guard case let .failed(message) = model.phase else {
            Issue.record("Expected a retryable planning failure")
            return
        }
        #expect(message == "Claude: Could not read Claude memories")
        #expect(!model.resolvedEmpty)
        #expect(model.pageEligible)
    }

    @Test func `provider summary error remains retryable without an error string`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                let payload = request.method == "migrations.memory.plan"
                    ? memoryImportSummaryErrorPlanPayload
                    : "{}"
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()

        await model.startPlanning(gateway: gateway, agentId: "main")

        guard case let .failed(message) = model.phase else {
            Issue.record("Expected summary error to remain retryable")
            return
        }
        #expect(message.contains("could not plan 1 memory"))
        #expect(!model.resolvedEmpty)
    }

    @Test func `missing plan fingerprint remains retryable instead of offering import`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                let payload = request.method == "migrations.memory.plan"
                    ? memoryImportMissingFingerprintPlanPayload
                    : "{}"
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()

        await model.startPlanning(gateway: gateway, agentId: "main")

        guard case let .failed(message) = model.phase else {
            Issue.record("Expected a retryable missing-fingerprint failure")
            return
        }
        #expect(message.contains("usable import plan"))
        #expect(!model.hasOffer)
        #expect(model.pageEligible)
    }

    @Test func `inconsistent provider stays disabled beside a valid offer`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                let payload = request.method == "migrations.memory.plan"
                    ? memoryImportInconsistentProviderPlanPayload
                    : "{}"
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()

        await model.startPlanning(gateway: gateway, agentId: "main")

        #expect(model.hasOffer)
        let broken = try #require(model.providers.first { $0.providerId == "broken" })
        #expect(!broken.selected)
        #expect(!broken.isActionable)
        #expect(broken.requiresReplan)
        #expect(broken.inlineError?.contains("inconsistent") == true)
    }

    @Test func `foreign agent identity rejects the plan`() async throws {
        try await self.withTemporaryStateDir {
            let url = try #require(URL(string: "ws://memory.test"))
            let gateway = makeMemoryImportGateway(
                configProvider: { (url: url, token: nil, password: nil) },
                responder: { task, request in
                    let payload = request.method == "migrations.memory.plan"
                        ? #"{"agentId":"other","workspace":"/tmp/workspace","providers":[]}"#
                        : "{}"
                    task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
                })
            let model = OnboardingMemoryImportModel()

            await model.startPlanning(gateway: gateway, agentId: "main")
            guard case let .failed(message) = model.phase else {
                Issue.record("Expected foreign-agent plan failure")
                return
            }
            #expect(message.contains("different agent"))
        }
    }

    @Test func `duplicate provider identity rejects the plan`() async throws {
        try await self.withTemporaryStateDir {
            let url = try #require(URL(string: "ws://memory.test"))
            let gateway = makeMemoryImportGateway(
                configProvider: { (url: url, token: nil, password: nil) },
                responder: { task, request in
                    let payload = request.method == "migrations.memory.plan"
                        ? memoryImportDuplicateProviderPlanPayload
                        : "{}"
                    task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
                })
            let model = OnboardingMemoryImportModel()

            await model.startPlanning(gateway: gateway, agentId: "main")
            guard case let .failed(message) = model.phase else {
                Issue.record("Expected duplicate-provider plan failure")
                return
            }
            #expect(message.contains("invalid memory provider"))
        }
    }

    @Test func `default agent id feeds the plan request`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let recorder = MemoryImportRequestRecorder()
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                await recorder.record(request)
                let payload = switch request.method {
                case "agents.list": #"{"defaultId":"work"}"#
                case "migrations.memory.plan": #"{"agentId":"work","workspace":"/tmp/workspace","providers":[]}"#
                default: "{}"
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()

        await model.startPlanning(gateway: gateway)

        let plan = try #require(await recorder.snapshot().first { $0.method == "migrations.memory.plan" })
        #expect(plan.agentId == "work")
        #expect(plan.overwrite == false)
        #expect(model.resolvedEmpty)
    }

    @Test func `apply sends planned ids and continues after a provider error`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let recorder = MemoryImportRequestRecorder()
        let counter = MemoryImportApplyCounter()
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                await recorder.record(request)
                if request.method == "migrations.memory.apply",
                   request.providerId == "claude",
                   await counter.next(for: "claude") == 1
                {
                    task.emitReceiveSuccess(.data(memoryImportError(id: request.id, message: "Claude import failed")))
                    return
                }
                let payload = switch request.method {
                case "migrations.memory.plan": memoryImportOfferPlanPayload
                case "migrations.memory.apply": memoryImportApplyPayload(
                        providerId: request.providerId ?? "unknown",
                        migrated: request.providerId == "claude" ? 2 : 1)
                default: "{}"
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")

        await model.importSelected(gateway: gateway)

        #expect(model.providers.first(where: { $0.providerId == "claude" })?.inlineError != nil)
        #expect(model.providers.first(where: { $0.providerId == "codex" })?.result?.migrated == 1)
        let applyRequests = await recorder.snapshot().filter { $0.method == "migrations.memory.apply" }
        #expect(applyRequests.count == 2)
        let claude = try #require(applyRequests.first { $0.providerId == "claude" })
        #expect(claude.agentId == "main")
        #expect(claude.planFingerprint == "plan-claude")
        #expect(claude.itemIds == ["planned-1", "planned-2"])
        #expect(claude.overwrite == false)

        let keys = Set(applyRequests.compactMap(\.idempotencyKey))
        #expect(keys.count == 2)
        #expect(model.hasReplanRequired)

        await model.startPlanning(gateway: gateway, agentId: "main")
        #expect(model.hasOffer)
        #expect(!model.hasReplanRequired)
        #expect(model.providers.first { $0.providerId == "claude" }?.inlineError == nil)
        let carriedCodex = try #require(model.providers.first { $0.providerId == "codex" })
        #expect(carriedCodex.result?.migrated == 1)
        #expect(!carriedCodex.selected)
        #expect(!carriedCodex.isActionable)
    }

    @Test func `ambiguous apply response reuses its idempotency key`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let recorder = MemoryImportRequestRecorder()
        let counter = MemoryImportApplyCounter()
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                await recorder.record(request)
                let payload: String = if request.method == "migrations.memory.plan" {
                    memoryImportOfferPlanPayload
                } else if request.method == "migrations.memory.apply",
                          await counter.next(for: request.providerId ?? "unknown") == 1
                {
                    "{}"
                } else if request.method == "migrations.memory.apply" {
                    memoryImportApplyPayload(
                        providerId: request.providerId ?? "unknown",
                        migrated: 2)
                } else {
                    "{}"
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")
        model.setSelected(false, providerId: "codex")

        await model.importSelected(gateway: gateway)
        #expect(model.providers.first?.inlineError != nil)
        await model.importSelected(gateway: gateway)

        let attempts = await recorder.snapshot().filter { $0.method == "migrations.memory.apply" }
        #expect(attempts.count == 2)
        #expect(attempts[0].idempotencyKey == attempts[1].idempotencyKey)
        #expect(model.results.first?.migrated == 2)
    }

    @Test func `ambiguous retry must resolve before a deterministic failure can replan`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let recorder = MemoryImportRequestRecorder()
        let counter = MemoryImportApplyCounter()
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                await recorder.record(request)
                if request.method == "migrations.memory.apply", request.providerId == "claude" {
                    let attempt = await counter.next(for: "claude")
                    let payload = attempt == 1
                        ? "{}"
                        : memoryImportApplyPayload(providerId: "claude", migrated: 2)
                    task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
                    return
                }
                if request.method == "migrations.memory.apply" {
                    task.emitReceiveSuccess(.data(memoryImportError(id: request.id, message: "refresh required")))
                    return
                }
                let payload = request.method == "migrations.memory.plan" ? memoryImportOfferPlanPayload : "{}"
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")

        await model.importSelected(gateway: gateway)

        #expect(model.hasReplanRequired)
        #expect(!model.canReplan)
        model.setSelected(false, providerId: "claude")
        model.setSelected(true, providerId: "claude")
        #expect(!model.canReplan)
        let firstClaudeKey = try #require(await recorder.snapshot().first {
            $0.method == "migrations.memory.apply" && $0.providerId == "claude"
        }?.idempotencyKey)
        await model.startPlanning(gateway: gateway, agentId: "main")
        #expect(await recorder.snapshot().count { $0.method == "migrations.memory.plan" } == 1)

        await model.importSelected(gateway: gateway)

        let claudeKeys = await recorder.snapshot().filter {
            $0.method == "migrations.memory.apply" && $0.providerId == "claude"
        }.compactMap(\.idempotencyKey)
        #expect(claudeKeys == [firstClaudeKey, firstClaudeKey])
        #expect(model.canReplan)
    }

    @Test func `apply response for another provider is rejected without consuming retry identity`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let recorder = MemoryImportRequestRecorder()
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                await recorder.record(request)
                let payload = switch request.method {
                case "migrations.memory.plan": memoryImportOfferPlanPayload
                case "migrations.memory.apply": memoryImportApplyPayload(providerId: "codex", migrated: 2)
                default: "{}"
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")
        model.setSelected(false, providerId: "codex")

        await model.importSelected(gateway: gateway)
        await model.importSelected(gateway: gateway)

        let claude = try #require(model.providers.first { $0.providerId == "claude" })
        #expect(claude.result == nil)
        #expect(claude.inlineError?.contains("different memory provider") == true)
        let keys = await recorder.snapshot().filter {
            $0.method == "migrations.memory.apply"
        }.compactMap(\.idempotencyKey)
        #expect(keys.count == 2)
        #expect(keys[0] == keys[1])
    }

    @Test func `fresh replan keeps completed totals while offering newly planned items`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let counter = MemoryImportApplyCounter()
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                let payload: String
                if request.method == "migrations.memory.plan" {
                    let attempt = await counter.next(for: "plan")
                    payload = attempt == 1
                        ? memoryImportOfferPlanPayload
                        : memoryImportOfferPlanPayload
                        .replacingOccurrences(of: "plan-codex", with: "plan-codex-new")
                        .replacingOccurrences(of: "codex-1", with: "codex-new")
                } else if request.method == "migrations.memory.apply", request.providerId == "claude" {
                    task.emitReceiveSuccess(.data(memoryImportError(id: request.id, message: "refresh required")))
                    return
                } else if request.method == "migrations.memory.apply" {
                    payload = memoryImportApplyPayload(providerId: "codex", migrated: 1)
                } else {
                    payload = "{}"
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")
        await model.importSelected(gateway: gateway)

        await model.startPlanning(gateway: gateway, agentId: "main")

        let codex = try #require(model.providers.first { $0.providerId == "codex" })
        #expect(codex.result?.migrated == 1)
        #expect(codex.plannedItemIds == ["codex-new"])
        #expect(codex.selected)
        #expect(codex.isActionable)
    }

    @Test func `reset invalidates an in flight batch before the next provider`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let recorder = MemoryImportRequestRecorder()
        let gate = MemoryImportRequestGate()
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                await recorder.record(request)
                if request.method == "migrations.memory.apply" {
                    await gate.wait()
                    task.emitReceiveSuccess(.data(memoryImportOK(
                        id: request.id,
                        payload: memoryImportApplyPayload(
                            providerId: request.providerId ?? "unknown",
                            migrated: 1))))
                    return
                }
                let payload = request.method == "migrations.memory.plan" ? memoryImportOfferPlanPayload : "{}"
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")
        let applying = Task { await model.importSelected(gateway: gateway) }
        await gate.waitUntilStarted()

        model.reset()
        await gate.release()
        await applying.value

        #expect(model.phase == .idle)
        #expect(await recorder.snapshot().count { $0.method == "migrations.memory.apply" } == 1)
    }

    @Test func `replan for another agent discards completed-provider carryover`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                if request.method == "migrations.memory.apply", request.providerId == "claude" {
                    task.emitReceiveSuccess(.data(memoryImportError(id: request.id, message: "refresh required")))
                    return
                }
                let payload = switch request.method {
                case "migrations.memory.plan": request.agentId == "other"
                    ? memoryImportOfferPlanPayload.replacingOccurrences(
                        of: #""agentId":"main""#,
                        with: #""agentId":"other""#)
                    : memoryImportOfferPlanPayload
                case "migrations.memory.apply": memoryImportApplyPayload(providerId: "codex", migrated: 1)
                default: "{}"
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")
        await model.importSelected(gateway: gateway)
        #expect(model.providers.first { $0.providerId == "codex" }?.result?.migrated == 1)

        await model.startPlanning(gateway: gateway, agentId: "other")

        #expect(model.providers.first { $0.providerId == "codex" }?.result == nil)
        #expect(model.providers.first { $0.providerId == "codex" }?.selected == true)
    }

    @Test func `failed refresh preserves fresh errors and completed carryover for retry`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let counter = MemoryImportApplyCounter()
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                if request.method == "migrations.memory.apply", request.providerId == "codex" {
                    task.emitReceiveSuccess(.data(memoryImportError(id: request.id, message: "refresh required")))
                    return
                }
                let payload: String
                if request.method == "migrations.memory.plan" {
                    let attempt = await counter.next(for: "plan")
                    payload = attempt == 2 ? memoryImportProviderErrorPlanPayload : memoryImportOfferPlanPayload
                } else if request.method == "migrations.memory.apply" {
                    payload = memoryImportApplyPayload(providerId: "claude", migrated: 2)
                } else {
                    payload = "{}"
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")
        await model.importSelected(gateway: gateway)
        #expect(model.providers.first { $0.providerId == "claude" }?.result?.migrated == 2)

        await model.startPlanning(gateway: gateway, agentId: "main")
        guard case let .failed(message) = model.phase else {
            Issue.record("Expected the fresh provider error to fail refresh")
            return
        }
        #expect(message.contains("Could not read Claude memories"))

        await model.startPlanning(gateway: gateway, agentId: "main")

        let claude = try #require(model.providers.first { $0.providerId == "claude" })
        #expect(claude.result?.migrated == 2)
        #expect(!claude.selected)
    }

    @Test func `apply rejects an offer from a replaced server lease`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let config = MemoryImportGatewayConfig(url: url, token: "first")
        let recorder = MemoryImportRequestRecorder()
        let gateway = makeMemoryImportGateway(
            configProvider: { config.snapshot() },
            responder: { task, request in
                await recorder.record(request)
                let payload = request.method == "migrations.memory.plan" ? memoryImportOfferPlanPayload : "{}"
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")

        config.setToken("replacement")
        await model.importSelected(gateway: gateway)

        #expect(model.isFailed)
        #expect(await recorder.snapshot().allSatisfy { $0.method != "migrations.memory.apply" })
    }

    @Test func `stale lease plan response is ignored`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let config = MemoryImportGatewayConfig(url: url, token: "first")
        let gate = MemoryImportRequestGate()
        let gateway = makeMemoryImportGateway(
            configProvider: { config.snapshot() },
            responder: { task, request in
                if request.method == "migrations.memory.plan" {
                    await gate.wait()
                    task.emitReceiveSuccess(.data(memoryImportOK(
                        id: request.id,
                        payload: memoryImportOfferPlanPayload)))
                    return
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: "{}")))
            })
        let model = OnboardingMemoryImportModel()
        let planning = Task { await model.startPlanning(gateway: gateway, agentId: "main") }
        await gate.waitUntilStarted()

        config.setToken("replacement")
        await gate.release()
        await planning.value

        guard case .failed = model.phase else {
            Issue.record("Expected a retryable failure after the stale plan response")
            return
        }
        #expect(!model.hasOffer)
        #expect(model.pageEligible)
    }

    @Test func `active empty page requests auto advance before becoming ineligible`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                let payload = request.method == "health" ? "{}" : memoryImportEmptyPlanPayload
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        model.setPageActive(true)

        await model.startPlanning(gateway: gateway, agentId: "main")

        #expect(model.resolvedEmpty)
        #expect(model.autoAdvanceRequested)
        #expect(model.pageEligible)
        model.consumeAutoAdvanceRequest()
        #expect(!model.autoAdvanceRequested)
        #expect(!model.pageEligible)
    }

    @Test func `dismissed planning failure stays ineligible for automatic retry`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                if request.method == "migrations.memory.plan" {
                    task.emitReceiveSuccess(.data(memoryImportError(id: request.id, message: "planning failed")))
                    return
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: "{}")))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")
        #expect(model.isFailed)

        model.dismissFailure()

        #expect(!model.pageEligible)
        #expect(!model.shouldStartAutomatically)
    }

    @Test func `partial apply result stays in offer with an inline error`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let gateway = makeMemoryImportGateway(
            configProvider: { (url: url, token: nil, password: nil) },
            responder: { task, request in
                let payload = switch request.method {
                case "migrations.memory.plan": memoryImportOfferPlanPayload
                case "migrations.memory.apply": memoryImportApplyPayload(
                        providerId: request.providerId ?? "unknown",
                        migrated: 1,
                        errors: request.providerId == "claude" ? 1 : 0)
                default: "{}"
                }
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")
        model.setSelected(false, providerId: "codex")

        await model.importSelected(gateway: gateway)

        let claude = try #require(model.providers.first { $0.providerId == "claude" })
        #expect(claude.result?.migrated == 1)
        #expect(claude.result?.errors == 1)
        #expect(claude.inlineError == "1 memory could not be imported.")
        #expect(!claude.selected)
        #expect(claude.requiresReplan)

        model.setSelected(true, providerId: "codex")
        await model.importSelected(gateway: gateway)

        let retainedClaude = try #require(model.providers.first { $0.providerId == "claude" })
        let codex = try #require(model.providers.first { $0.providerId == "codex" })
        #expect(retainedClaude.inlineError == "1 memory could not be imported.")
        #expect(codex.result?.migrated == 1)
        #expect(model.hasReplanRequired)

        await model.startPlanning(gateway: gateway, agentId: "main")

        let refreshedClaude = try #require(model.providers.first { $0.providerId == "claude" })
        let refreshedCodex = try #require(model.providers.first { $0.providerId == "codex" })
        #expect(refreshedClaude.result?.migrated == 1)
        #expect(refreshedClaude.selected)
        #expect(refreshedCodex.result?.migrated == 1)
        #expect(!refreshedCodex.selected)

        model.setSelected(false, providerId: "claude")
        #expect(model.providers.first { $0.providerId == "claude" }?.selected == false)
    }

    @Test func `stale lease apply response exits applying without accepting results`() async throws {
        let url = try #require(URL(string: "ws://memory.test"))
        let config = MemoryImportGatewayConfig(url: url, token: "first")
        let gate = MemoryImportRequestGate()
        let gateway = makeMemoryImportGateway(
            configProvider: { config.snapshot() },
            responder: { task, request in
                if request.method == "migrations.memory.apply" {
                    await gate.wait()
                    task.emitReceiveSuccess(.data(memoryImportOK(
                        id: request.id,
                        payload: memoryImportApplyPayload(providerId: request.providerId ?? "unknown", migrated: 1))))
                    return
                }
                let payload = request.method == "migrations.memory.plan" ? memoryImportOfferPlanPayload : "{}"
                task.emitReceiveSuccess(.data(memoryImportOK(id: request.id, payload: payload)))
            })
        let model = OnboardingMemoryImportModel()
        await model.startPlanning(gateway: gateway, agentId: "main")
        let applying = Task { await model.importSelected(gateway: gateway) }
        await gate.waitUntilStarted()

        config.setToken("replacement")
        await gate.release()
        await applying.value

        #expect(model.isFailed)
        #expect(!model.isApplying)
        #expect(model.results.isEmpty)
    }
}
