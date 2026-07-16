import CryptoKit
import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private actor ActivationMarkerObservation {
    private var observed = false
    private var observedDeadline: Date?

    func record(_ value: Bool) {
        observed = value
    }

    func value() -> Bool {
        observed
    }

    func record(deadline: Date?) {
        observedDeadline = deadline
    }

    func deadline() -> Date? {
        observedDeadline
    }
}

private final class ActivationOwnerObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var observedOwner: OnboardingSystemAgentResumeStore.ActivationOwner?

    func record(_ owner: OnboardingSystemAgentResumeStore.ActivationOwner?) {
        lock.lock()
        defer { self.lock.unlock() }
        observedOwner = owner
    }

    func value() -> OnboardingSystemAgentResumeStore.ActivationOwner? {
        lock.lock()
        defer { self.lock.unlock() }
        return observedOwner
    }
}

private final class AISetupSocketGeneration: @unchecked Sendable {
    private let lock = NSLock()
    private var nextGeneration = 0

    func claim() -> Int {
        lock.lock()
        defer { self.lock.unlock() }
        defer { self.nextGeneration += 1 }
        return nextGeneration
    }
}

private final class AISetupGatewayConfig: @unchecked Sendable {
    private let lock = NSLock()
    private let url: URL
    private var token: String
    private var switchTokenAfterReads: (remaining: Int, token: String)?

    init(url: URL, token: String) {
        self.url = url
        self.token = token
    }

    func setToken(_ token: String) {
        lock.lock()
        defer { self.lock.unlock() }
        self.token = token
        switchTokenAfterReads = nil
    }

    func switchToken(to token: String, afterReads: Int) {
        lock.lock()
        defer { self.lock.unlock() }
        switchTokenAfterReads = (remaining: afterReads, token: token)
    }

    func snapshot() -> GatewayConnection.Config {
        lock.lock()
        defer { self.lock.unlock() }
        if let pending = switchTokenAfterReads {
            if pending.remaining == 0 {
                token = pending.token
                switchTokenAfterReads = nil
            } else {
                switchTokenAfterReads = (
                    remaining: pending.remaining - 1,
                    token: pending.token
                )
            }
        }
        return (url: url, token: token, password: nil)
    }
}

private final class AISetupRouteIdentity: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String

    init(_ value: String) {
        self.value = value
    }

    func set(_ value: String) {
        lock.lock()
        defer { self.lock.unlock() }
        self.value = value
    }

    func snapshot() -> String {
        lock.lock()
        defer { self.lock.unlock() }
        return value
    }
}

private actor AISetupRequestRecorder {
    private var methods: [String] = []
    private var apiKeys: [String] = []

    func record(_ message: URLSessionWebSocketTask.Message) {
        guard let request = aiSetupRequest(from: message) else { return }
        methods.append(request.method)
        if let apiKey = request.params["apiKey"] as? String {
            apiKeys.append(apiKey)
        }
    }

    func snapshot() -> (methods: [String], apiKeys: [String]) {
        (methods, apiKeys)
    }
}

private actor AISetupRequestGate {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        guard !released else { return }
        await withCheckedContinuation { continuation in
            self.releaseWaiters.append(continuation)
        }
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func release() {
        released = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor AISetupConfigReadGate {
    private var blockNextRead = false
    private var blocked = false
    private var released = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func armNextRead() {
        blockNextRead = true
    }

    func snapshotToken() async -> String {
        if blockNextRead {
            blockNextRead = false
            blocked = true
            blockedWaiters.forEach { $0.resume() }
            blockedWaiters.removeAll()
            if !released {
                await withCheckedContinuation { continuation in
                    self.releaseWaiters.append(continuation)
                }
            }
        }
        return "route-a"
    }

    func waitUntilBlocked() async {
        guard !blocked else { return }
        await withCheckedContinuation { continuation in
            self.blockedWaiters.append(continuation)
        }
    }

    func release() {
        released = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private func aiSetupRequest(
    from message: URLSessionWebSocketTask.Message
) -> (id: String, method: String, params: [String: Any])? {
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
    return (id: id, method: method, params: object["params"] as? [String: Any] ?? [:])
}

private func detectedSetupResponse(
    id: String,
    kind: String = "claude-cli",
    modelRef: String = "claude-cli/claude-opus-4-8"
) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "candidates": [{
              "kind": "\(kind)",
              "label": "Test AI",
              "detail": "installed",
              "modelRef": "\(modelRef)",
              "recommended": false,
              "credentials": false
            }],
            "manualProviders": [{
              "id": "openai-api-key",
              "label": "OpenAI API key",
              "hint": null
            }],
            "workspace": "/tmp/openclaw-workspace",
            "configuredModel": null,
            "setupComplete": false
          }
        }
        """.utf8
    )
}

private func successfulEmptyResponse(id: String) -> Data {
    Data(
        """
        {"type":"res","id":"\(id)","ok":true,"payload":{}}
        """.utf8
    )
}

private func respondToAISetupHealth(
    task: GatewayTestWebSocketTask,
    request: (id: String, method: String, params: [String: Any])
) -> Bool {
    guard request.method == "health" else { return false }
    task.emitReceiveSuccess(.data(successfulEmptyResponse(id: request.id)))
    return true
}

private func respondToAISetupPreparation(
    task: GatewayTestWebSocketTask,
    request: (id: String, method: String, params: [String: Any]),
    kind: String
) -> Bool {
    if respondToAISetupHealth(task: task, request: request) {
        return true
    }
    guard request.method == "openclaw.setup.detect" else { return false }
    let modelRef = kind == "codex-cli" ? "openai/gpt-5.5" : "claude-cli/claude-opus-4-8"
    task.emitReceiveSuccess(.data(detectedSetupResponse(
        id: request.id,
        kind: kind,
        modelRef: modelRef
    )))
    return true
}

private func actionableDetectedSetupResponse(id: String) -> Data {
    let response = String(decoding: detectedSetupResponse(id: id), as: UTF8.self)
        .replacingOccurrences(of: #""credentials": false"#, with: #""credentials": true"#)
    return Data(response.utf8)
}

private func persistedDetectedSetupResponse(
    id: String,
    configuredModel: String = "openai/gpt-5.5"
) -> Data {
    let response = String(decoding: detectedSetupResponse(
        id: id,
        kind: "codex-cli",
        modelRef: "openai/gpt-5.5"
    ), as: UTF8.self)
        .replacingOccurrences(
            of: #""configuredModel": null"#,
            with: #""configuredModel": "\#(configuredModel)""#
        )
        .replacingOccurrences(of: #""setupComplete": false"#, with: #""setupComplete": true"#)
    return Data(response.utf8)
}

private func missingConfiguredModelResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "defaultId": "main",
            "mainKey": "main",
            "scope": "per-sender",
            "agents": [{ "id": "main" }]
          }
        }
        """.utf8
    )
}

private func configuredModelResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "defaultId": "main",
            "mainKey": "main",
            "scope": "per-sender",
            "agents": [{
              "id": "main",
              "model": { "primary": "openai/gpt-5.5" }
            }]
          }
        }
        """.utf8
    )
}

private func waitForAISetupRequests(
    _ recorder: AISetupRequestRecorder,
    count: Int
) async -> (methods: [String], apiKeys: [String]) {
    for _ in 0 ..< 200 {
        let snapshot = await recorder.snapshot()
        if snapshot.methods.count >= count {
            return snapshot
        }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return await recorder.snapshot()
}

private func settleQueuedAISetupTasks() async {
    try? await Task.sleep(nanoseconds: 100_000_000)
}

private func makeAISetupSession(
    recorder: AISetupRequestRecorder,
    indeterminateActivationAfterDispatch: Bool = false,
    detectedKind: String = "claude-cli"
) -> GatewayTestWebSocketSession {
    GatewayTestWebSocketSession(taskFactory: {
        GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
            guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
            if respondToAISetupHealth(task: task, request: request) {
                return
            }
            await recorder.record(message)
            switch request.method {
            case "openclaw.setup.detect":
                let modelRef = detectedKind == "codex-cli"
                    ? "openai/gpt-5.5"
                    : "claude-cli/claude-opus-4-8"
                task.emitReceiveSuccess(.data(detectedSetupResponse(
                    id: request.id,
                    kind: detectedKind,
                    modelRef: modelRef
                )))
            case "openclaw.setup.activate":
                if indeterminateActivationAfterDispatch {
                    task.emitReceiveSuccess(.data(indeterminateActivationResponse(id: request.id)))
                    return
                }
                task.emitReceiveSuccess(.data(failedActivationResponse(id: request.id)))
            default:
                break
            }
        })
    })
}

private func makeRestartingAISetupSession(
    suiteName: String,
    recorder: AISetupRequestRecorder,
    ownerObservation: ActivationOwnerObservation,
    postRestartConfiguredModel: String?
) -> GatewayTestWebSocketSession {
    let socketGeneration = AISetupSocketGeneration()
    return GatewayTestWebSocketSession(taskFactory: {
        let generation = socketGeneration.claim()
        return GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
            guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
            if respondToAISetupHealth(task: task, request: request) {
                return
            }
            await recorder.record(message)
            if generation == 0 {
                switch request.method {
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(
                        id: request.id,
                        kind: "codex-cli",
                        modelRef: "openai/gpt-5.5"
                    )))
                case "openclaw.setup.activate":
                    let owner = UserDefaults(suiteName: suiteName).flatMap {
                        OnboardingSystemAgentResumeStore.activationOwner(
                            for: "local",
                            defaults: $0
                        )
                    }
                    ownerObservation.record(owner)
                    task.emitReceiveFailure(URLError(.networkConnectionLost))
                default:
                    break
                }
                return
            }
            switch request.method {
            case "openclaw.setup.detect":
                let response = postRestartConfiguredModel.map {
                    persistedDetectedSetupResponse(id: request.id, configuredModel: $0)
                } ?? detectedSetupResponse(
                    id: request.id,
                    kind: "codex-cli",
                    modelRef: "openai/gpt-5.5"
                )
                task.emitReceiveSuccess(.data(response))
            case "openclaw.setup.verify":
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            default:
                break
            }
        })
    })
}

private func failedActivationResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": { "ok": false, "status": "auth", "error": "rejected" }
        }
        """.utf8
    )
}

private func indeterminateActivationResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": false,
          "error": {
            "code": "UNAVAILABLE",
            "message": "Setup inference activation is indeterminate"
          }
        }
        """.utf8
    )
}

private func verifiedSetupResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": { "ok": true, "modelRef": "openai/gpt-5.5", "latencyMs": 42 }
        }
        """.utf8
    )
}

private func rejectedSetupVerificationResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": { "ok": false, "status": "auth", "error": "expired login" }
        }
        """.utf8
    )
}

private func unavailableGatewayResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": false,
          "error": { "code": "UNAVAILABLE", "message": "temporary failure" }
        }
        """.utf8
    )
}

@Suite(.serialized)
@MainActor
struct OnboardingAISetupTests {
    @Test func `candidate failure keeps friendly summary and exact detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "auth",
            error: "Codex login expired (request 42)"
        )

        #expect(failure.summary == "Codex CLI is installed, but the login didn’t work. Sign in again, then retry.")
        #expect(failure.detail == "Codex login expired (request 42)")
        #expect(failure.copyText == "Codex login expired (request 42)")
    }

    @Test func `candidate failure omits empty detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "timeout",
            error: "  "
        )

        #expect(failure.summary == "Codex CLI didn’t answer in time.")
        #expect(failure.detail == nil)
        #expect(failure.copyText == failure.summary)
    }

    @Test func `transport failure preserves original detail`() {
        let failure = OnboardingAISetupModel.transportFailure(
            "Gateway request failed: connection reset"
        )

        #expect(failure.summary == "The Gateway setup request failed. Show details to inspect or copy the error.")
        #expect(failure.detail == "Gateway request failed: connection reset")
    }

    @Test func `unavailable failure keeps long detail out of the visible summary`() {
        let rawDetail = String(repeating: "installer output ", count: 200)
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "unavailable",
            error: rawDetail
        )

        #expect(failure.summary == "Codex CLI couldn’t complete the test. Show details to inspect or copy the error.")
        #expect(failure.detail == rawDetail.trimmingCharacters(in: .whitespacesAndNewlines))
        #expect(failure.copyText == failure.detail)
    }

    @Test func `Claude Code and Codex use bundled vector artwork`() {
        for kind in ["claude-cli", "codex-cli"] {
            let url = OnboardingProviderIcon.resourceURL(for: kind)
            #expect(url?.pathExtension == "svg")
            #expect(OnboardingProviderIcon.image(for: kind)?.isTemplate == true)
        }
        #expect(OnboardingProviderIcon.resourceURL(for: "gemini-cli") == nil)
    }

    @Test func `device code presentation decodes structured wizard metadata`() throws {
        let presentation = try #require(parseWizardDeviceCode([
            "code": AnyCodable("ABCD-1234"),
            "expiresInMinutes": AnyCodable(15),
            "message": AnyCodable("Enter this code in your browser."),
        ]))

        #expect(presentation.code == "ABCD-1234")
        #expect(presentation.expiresInMinutes == 15)
        #expect(presentation.message == "Enter this code in your browser.")
        #expect(parseWizardDeviceCode(["code": AnyCodable("")]) == nil)
        #expect(parseWizardDeviceCode([
            "code": AnyCodable("ABCD-1234"),
            "expiresInMinutes": AnyCodable(1e100),
        ])?.expiresInMinutes == nil)
    }

    @Test func `provider auth transport outlives device code windows`() {
        #expect(OnboardingAISetupModel.providerAuthRequestTimeoutMs > 15 * 60 * 1000)
    }

    @Test func `provider auth opens only safe external links`() {
        let safe = OnboardingProviderAuthLink.safeURL(
            "https://auth.openai.com/oauth/authorize?client_id=test"
        )
        #expect(safe?.host() == "auth.openai.com")
        #expect(OnboardingProviderAuthLink.safeURL("http://localhost:1455/callback") == nil)
        #expect(OnboardingProviderAuthLink.safeURL("file:///tmp/token") == nil)
        #expect(OnboardingProviderAuthLink.safeURL("https://user:secret@example.com") == nil)
        #expect(OnboardingProviderAuthLink.safeURL("Read https://docs.openclaw.ai/start/faq") == nil)
    }

    @Test func `terminal provider failure remains copyable and can dismiss`() {
        let model = OnboardingAISetupModel()
        let option = OnboardingAISetupModel.AuthOption(
            id: "openai:oauth",
            label: "OpenAI",
            hint: nil,
            groupLabel: "OpenAI",
            kind: "oauth",
            featured: true
        )
        model._test_setProviderAuth(option: option, sessionID: "finished-session")

        model._test_applyAuthWizardResult(
            done: true,
            status: "error",
            error: "The authorization request was denied."
        )

        #expect(model.activeAuthOption?.id == option.id)
        #expect(model.authError?.copyText == "The authorization request was denied.")
        #expect(model._test_authSessionID == nil)
        #expect(!model.authBusy)

        model.cancelProviderAuth()
        #expect(model.activeAuthOption == nil)
        #expect(model.authError == nil)
    }

    @Test func `provider auth mismatch cancels returned server session id`() {
        #expect(OnboardingAISetupModel.providerAuthCancellationSessionID(
            requested: "requested-session",
            returned: "returned-server-session"
        ) == "returned-server-session")
        #expect(OnboardingAISetupModel.providerAuthCancellationSessionID(
            requested: "matching-session",
            returned: "matching-session"
        ) == nil)
    }

    @Test func `provider auth reconciliation only trusts its own completed flow`() {
        #expect(!OnboardingAISetupModel.canAcceptProviderAuthReconciliation(
            pending: false,
            setupComplete: true,
            configuredModel: "openai/gpt-5.5"
        ))
        #expect(!OnboardingAISetupModel.canAcceptProviderAuthReconciliation(
            pending: true,
            setupComplete: false,
            configuredModel: "openai/gpt-5.5"
        ))
        #expect(OnboardingAISetupModel.canAcceptProviderAuthReconciliation(
            pending: true,
            setupComplete: true,
            configuredModel: "openai/gpt-5.5"
        ))
    }

    @Test func `codex activation covers install probe and finalization`() {
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") == 480_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "claude-cli") == 150_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") >= (305 + 90) * 1000)
    }

    @Test func `activation sends exact model only to capable gateways`() {
        let legacy = OnboardingAISetupModel.activationParams(
            kind: "codex-cli",
            modelRef: "openai/gpt-5.5",
            supportsExactModel: false
        )
        let capable = OnboardingAISetupModel.activationParams(
            kind: "codex-cli",
            modelRef: "openai/gpt-5.5",
            supportsExactModel: true
        )

        #expect(legacy["kind"]?.value as? String == "codex-cli")
        #expect(legacy["modelRef"] == nil)
        #expect(capable["kind"]?.value as? String == "codex-cli")
        #expect(capable["modelRef"]?.value as? String == "openai/gpt-5.5")
    }

    @Test func `activation decodes and retains copyable setup lines`() throws {
        let data = Data(
            #"""
            {"ok":true,"modelRef":"openai/gpt-5.5","lines":[
              "Model: openai/gpt-5.5","  Plugin registry refresh failed: offline  ",""
            ]}
            """#.utf8
        )
        let result = try JSONDecoder().decode(OnboardingAISetupModel.ActivateResult.self, from: data)
        let model = OnboardingAISetupModel()

        model._test_setConnectedSetupLines(result.lines)

        #expect(model.connectedSetupLines == [
            "Model: openai/gpt-5.5",
            "Plugin registry refresh failed: offline",
        ])
        #expect(model.connectedSetupCopyText ==
            "Model: openai/gpt-5.5\nPlugin registry refresh failed: offline")

        model.resetForGatewayChange()
        #expect(model.connectedSetupLines.isEmpty)
        #expect(model.connectedSetupCopyText.isEmpty)
    }

    @Test func `gateway hello maps exact-model setup capability`() throws {
        let data = Data(
            #"""
            {"type":"hello-ok","protocol":4,
             "server":{"version":"test","connId":"test"},
             "features":{"methods":[],"events":[],"capabilities":["openclaw-setup-model-ref"]},
             "snapshot":{"presence":[],"health":{},
                         "stateVersion":{"presence":0,"health":0},"uptimeMs":0},
             "auth":{},"policy":{}}
            """#.utf8
        )
        let hello = try JSONDecoder().decode(HelloOk.self, from: data)

        #expect(hello.supportsServerCapability(.systemAgentSetupModelRef))
    }

    @Test func `only definitive failures can clear an activation marker`() {
        let unknownMethod = GatewayResponseError(
            method: "openclaw.setup.activate",
            code: "UNKNOWN_METHOD",
            message: "unknown method",
            details: nil
        )
        let invalidParams = GatewayResponseError(
            method: "openclaw.setup.activate",
            code: "INVALID_REQUEST",
            message: "invalid openclaw.setup.activate params: kind is required",
            details: nil
        )
        let indeterminate = GatewayResponseError(
            method: "openclaw.setup.activate",
            code: "UNAVAILABLE",
            message: "Setup inference activation is indeterminate",
            details: nil
        )
        let genericInvalidRequest = GatewayResponseError(
            method: "openclaw.setup.activate",
            code: "INVALID_REQUEST",
            message: "activation failed after dispatch",
            details: nil
        )
        let timeout = NSError(
            domain: "Gateway",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "gateway request timed out"]
        )
        let decodeError = DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "invalid activation response"
        ))

        #expect(OnboardingAISetupModel.activationFailureIsDefinitive(unknownMethod))
        #expect(OnboardingAISetupModel.activationFailureIsDefinitive(invalidParams))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(indeterminate))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(genericInvalidRequest))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(decodeError))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(timeout))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(CancellationError()))
    }

    @Test func `successful activation hands off and completion clears its owned receipt`() async throws {
        let suiteName = "OnboardingCompletedActivationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupPreparation(task: task, request: request, kind: "claude-cli") {
                    return
                }
                guard request.method == "openclaw.setup.activate" else { return }
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var handedOff = false
        model.onConnected = { handedOff = true }

        await model.detectAndAutoConnect()
        await model.activate(kind: "claude-cli")

        #expect(model.connected)
        #expect(handedOff)
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .completed)

        model.clearCompletedHandoffIfOwned()

        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .none)
    }

    @Test func `adopts pending activation stored under the retired crestodian key`() throws {
        let suiteName = "OnboardingRetiredKeyMigrationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        _ = OnboardingSystemAgentResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        let payload = try #require(defaults.object(forKey: onboardingSystemAgentPendingKey))
        defaults.removeObject(forKey: onboardingSystemAgentPendingKey)
        defaults.set(payload, forKey: onboardingSystemAgentPendingRetiredKey)

        guard case .activating = OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) else {
            Issue.record("expected the retired-key activation lease to survive the rename")
            return
        }
        #expect(defaults.object(forKey: onboardingSystemAgentPendingKey) != nil)
        #expect(defaults.object(forKey: onboardingSystemAgentPendingRetiredKey) == nil)
    }

    @Test func `managed Gateway restart reconciles exact persisted activation before handoff`() async throws {
        let suiteName = "OnboardingManagedRestartReconciliationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let recorder = AISetupRequestRecorder()
        let ownerObservation = ActivationOwnerObservation()
        let session = makeRestartingAISetupSession(
            suiteName: suiteName,
            recorder: recorder,
            ownerObservation: ownerObservation,
            postRestartConfiguredModel: "openai/gpt-5.5"
        )
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: "route-token", password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var handoffCount = 0
        model.onConnected = { handoffCount += 1 }

        await model.detectAndAutoConnect()
        await model.activate(kind: "codex-cli")

        let activationOwner = try #require(ownerObservation.value())
        #expect(session.snapshotMakeCount() >= 2)
        #expect(await (recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
            "openclaw.setup.detect",
            "openclaw.setup.verify",
        ])
        #expect(model.connected)
        #expect(model.connectedModelRef == "openai/gpt-5.5")
        #expect(handoffCount == 1)
        #expect(OnboardingSystemAgentResumeStore.activationOwner(
            for: "local",
            defaults: defaults
        ) == activationOwner)
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .completed)
    }

    @Test func `managed Gateway restart rejects mismatched persisted transition`() async throws {
        let suiteName = "OnboardingManagedRestartMismatchTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let recorder = AISetupRequestRecorder()
        let ownerObservation = ActivationOwnerObservation()
        let session = makeRestartingAISetupSession(
            suiteName: suiteName,
            recorder: recorder,
            ownerObservation: ownerObservation,
            postRestartConfiguredModel: "anthropic/other-model"
        )
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: "route-token", password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var handoffCount = 0
        model.onConnected = { handoffCount += 1 }

        await model.detectAndAutoConnect()
        let activation = Task { await model.activate(kind: "codex-cli") }
        let reconciledRequests = await waitForAISetupRequests(recorder, count: 3)
        activation.cancel()
        await activation.value

        let activationOwner = try #require(ownerObservation.value())
        #expect(Array(reconciledRequests.methods.prefix(3)) == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
            "openclaw.setup.detect",
        ])
        #expect(!reconciledRequests.methods.contains("openclaw.setup.verify"))
        #expect(!model.connected)
        #expect(handoffCount == 0)
        #expect(OnboardingSystemAgentResumeStore.isOwned(
            by: activationOwner,
            for: "local",
            defaults: defaults
        ))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
    }

    @Test func `completion cannot clear a replacement activation owner`() async throws {
        let suiteName = "OnboardingCompletionReplacementOwnerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupPreparation(task: task, request: request, kind: "claude-cli") {
                    return
                }
                guard request.method == "openclaw.setup.activate" else { return }
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )

        await model.detectAndAutoConnect()
        await model.activate(kind: "claude-cli")
        let completedOwner = try #require(OnboardingSystemAgentResumeStore.activationOwner(
            for: "local",
            defaults: defaults
        ))
        let replacementOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "replacement-activation",
            routeFingerprint: completedOwner.routeFingerprint
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            activationOwner: replacementOwner,
            defaults: defaults
        )

        model.clearCompletedHandoffIfOwned()

        #expect(OnboardingSystemAgentResumeStore.isOwned(
            by: replacementOwner,
            for: "local",
            defaults: defaults
        ))
        guard case .activating = OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        )
        else {
            Issue.record("expected replacement activation to retain its lease")
            return
        }
    }

    @Test func `successful response cannot complete a replaced same route activation`() async throws {
        let suiteName = "OnboardingReplacedActivationOwnerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let replacementID = "replacement-activation"
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupPreparation(task: task, request: request, kind: "claude-cli") {
                    return
                }
                guard request.method == "openclaw.setup.activate",
                      let callbackDefaults = UserDefaults(suiteName: suiteName),
                      let originalOwner = OnboardingSystemAgentResumeStore.activationOwner(
                          for: "local",
                          defaults: callbackDefaults
                      )
                else { return }
                OnboardingSystemAgentResumeStore.markPending(
                    routeIdentity: "local",
                    activationOwner: .init(
                        id: replacementID,
                        routeFingerprint: originalOwner.routeFingerprint
                    ),
                    defaults: callbackDefaults
                )
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var handoffCount = 0
        model.onConnected = { handoffCount += 1 }

        await model.detectAndAutoConnect()
        await model.activate(kind: "claude-cli")

        #expect(!model.connected)
        #expect(handoffCount == 0)
        #expect(model.phase == .ready)
        #expect(OnboardingSystemAgentResumeStore.activationOwner(
            for: "local",
            defaults: defaults
        )?.id == replacementID)
        guard case .activating = OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        )
        else {
            Issue.record("expected replacement activation to retain its lease")
            return
        }
    }

    @Test func `reset during final route validation rejects stale activation handoff`() async throws {
        let suiteName = "OnboardingFinalRouteValidationResetTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let configGate = AISetupConfigReadGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupPreparation(task: task, request: request, kind: "codex-cli") {
                    return
                }
                guard request.method == "openclaw.setup.activate" else { return }
                await configGate.armNextRead()
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await configGate.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var handoffCount = 0
        model.onConnected = { handoffCount += 1 }

        await model.detectAndAutoConnect()
        let activation = Task { await model.activate(kind: "codex-cli") }
        await configGate.waitUntilBlocked()
        model.resetForGatewayChange(clearPendingHandoff: false)
        await configGate.release()
        await activation.value

        #expect(!model.connected)
        #expect(model.phase == .idle)
        #expect(handoffCount == 0)
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "local",
            defaults: defaults
        ))
    }

    @Test func `gateway change clears route-bound setup state`() {
        let model = OnboardingAISetupModel()
        model.manualProviderID = "openai"
        model.manualKey = "temporary-key"
        model.showManualEntry = true

        model.resetForGatewayChange()

        #expect(model.phase == .idle)
        #expect(model.connectedModelRef == nil)
        #expect(model.connectedLatencyMs == nil)
        #expect(model.manualProviderID.isEmpty)
        #expect(model.manualKey.isEmpty)
        #expect(!model.showManualEntry)
    }

    @Test func `configured gateway result is accepted only for the visible selected route`() {
        #expect(OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .remote,
            currentMode: .remote,
            systemAgentResumePending: false,
            setupOwnsInferenceTransition: false
        ))
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: false,
            expectedMode: .remote,
            currentMode: .remote,
            systemAgentResumePending: false,
            setupOwnsInferenceTransition: false
        ))
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .remote,
            currentMode: .local,
            systemAgentResumePending: false,
            setupOwnsInferenceTransition: false
        ))
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .unconfigured,
            currentMode: .unconfigured,
            systemAgentResumePending: false,
            setupOwnsInferenceTransition: false
        ))
    }

    @Test func `fresh inference transition owns the OpenClaw handoff`() {
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .local,
            currentMode: .local,
            systemAgentResumePending: false,
            setupOwnsInferenceTransition: true
        ))
    }

    @Test func `pending OpenClaw handoff cannot be mistaken for an existing install`() {
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .local,
            currentMode: .local,
            systemAgentResumePending: true,
            setupOwnsInferenceTransition: false
        ))
    }

    @Test func `configured model label stays pending until live verification`() async {
        let model = OnboardingAISetupModel()

        model.resumeConfiguredInference(modelRef: " openai/gpt-5.5 ")

        #expect(!model.connected)
        #expect(model.pendingActivationVerification)
        #expect(model.phase == .detecting)
        #expect(model.connectedModelRef == nil)

        await model.activate(kind: "codex-cli")
        #expect(model.pendingActivationVerification)
        #expect(!model.connected)

        model.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")

        #expect(model.connected)
        #expect(!model.pendingActivationVerification)
        #expect(model.connectedModelRef == "openai/gpt-5.5")
        #expect(model.selectedKind == "existing-model")
        #expect(model.statuses["existing-model"] == .connected)
    }

    @Test func `pending handoff connects only after route-bound live verification`() async throws {
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                if request.method == "openclaw.setup.verify" {
                    task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
                }
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            routeIdentityProvider: { "local" }
        )

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        await model.verifyPendingConfiguredInference()

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["openclaw.setup.verify"])
        #expect(model.connected)
        #expect(model.connectedModelRef == "openai/gpt-5.5")
        #expect(model.connectedLatencyMs == 42)
    }

    @Test func `overlapping pending verification callers share one route-bound request`() async throws {
        let recorder = AISetupRequestRecorder()
        let gate = AISetupRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                guard request.method == "openclaw.setup.verify" else { return }
                await gate.wait()
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            routeIdentityProvider: { "local" }
        )
        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")

        let first = Task { await model.verifyPendingConfiguredInference() }
        await gate.waitUntilStarted()
        let second = Task { await model.verifyPendingConfiguredInference() }
        await Task.yield()

        #expect(await (recorder.snapshot()).methods == ["openclaw.setup.verify"])
        await gate.release()
        #expect(await first.value == .connected)
        #expect(await second.value == .connected)
        #expect(await (recorder.snapshot()).methods == ["openclaw.setup.verify"])
    }

    @Test func `pending verification revalidates route after shared task completes`() async throws {
        let suiteName = "OnboardingPendingRouteRevalidationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                guard request.method == "openclaw.setup.verify" else { return }
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() }
        )
        model.onConnected = { routeIdentity.set("remote:id:gateway-b") }

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()

        #expect(outcome == .superseded)
    }

    @Test func `disappearing onboarding invalidates detection before activation`() async throws {
        let recorder = AISetupRequestRecorder()
        let gate = AISetupRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                switch request.method {
                case "openclaw.setup.detect":
                    await gate.wait()
                    task.emitReceiveSuccess(.data(actionableDetectedSetupResponse(id: request.id)))
                case "openclaw.setup.activate":
                    task.emitReceiveSuccess(.data(failedActivationResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let appState = AppState(preview: true)
        appState.connectionMode = .remote
        appState.remoteTransport = .direct
        appState.remoteUrl = "ws://example.invalid"
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            aiSetupRouteIdentityProvider: { "remote:direct:example.invalid" }
        )
        view.onboardingVisible = true

        view.aiSetup.startIfNeeded()
        await gate.waitUntilStarted()
        view.onboardingDidDisappear()
        await gate.release()
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["openclaw.setup.detect"])
        #expect(view.aiSetup.phase == .idle)
    }

    @Test func `failed pending verification keeps activation lease before deadline`() async throws {
        let suiteName = "OnboardingPendingVerificationFailureTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingSystemAgentResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                guard request.method == "openclaw.setup.verify" else { return }
                task.emitReceiveSuccess(.data(rejectedSetupVerificationResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()

        #expect(!model.connected)
        #expect(model.pendingActivationVerification)
        #expect(model.detectError?.detail == "expired login")
        #expect(outcome == .notConnected)
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `completed activation receipt survives verification transport failure`() async throws {
        let suiteName = "OnboardingCompletedVerificationRetryTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                guard request.method == "openclaw.setup.verify" else { return }
                await recorder.record(message)
                let verifyCount = await recorder.snapshot().methods.count
                let response = verifyCount == 1
                    ? unavailableGatewayResponse(id: request.id)
                    : verifiedSetupResponse(id: request.id)
                task.emitReceiveSuccess(.data(response))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: "completed-route", password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let route = try #require(await gateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "completed-before-verification",
            routeFingerprint: #require(route.activationOwnershipFingerprint)
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            activationOwner: activationOwner,
            defaults: defaults
        )
        #expect(OnboardingSystemAgentResumeStore.markCompleted(
            ifOwnedBy: "local",
            activationOwner: activationOwner,
            defaults: defaults
        ))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")

        let failedOutcome = await model.verifyPendingConfiguredInference()

        #expect(failedOutcome == .notConnected)
        #expect(model.pendingActivationVerification)
        #expect(!model.connected)
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .completed)

        let retryOutcome = await model.verifyPendingConfiguredInference()
        let requests = await waitForAISetupRequests(recorder, count: 2)

        #expect(retryOutcome == .connected)
        #expect(model.connected)
        #expect(requests.methods == ["openclaw.setup.verify", "openclaw.setup.verify"])
    }

    @Test func `pending OpenClaw marker is app local and clearable`() throws {
        let suiteName = "OnboardingSystemAgentResumeStoreTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(!OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        OnboardingSystemAgentResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        OnboardingSystemAgentResumeStore.clear(defaults: defaults)
        #expect(!OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `persisted route owner ignores tunnel URL but changes with Gateway auth`() async throws {
        let firstURL = try #require(URL(string: "ws://127.0.0.1:49152"))
        let reboundURL = try #require(URL(string: "ws://127.0.0.1:53241"))
        let first = GatewayConnection(
            configProvider: { (url: firstURL, token: "route-token", password: "route-password") },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            }))
        )
        let rebound = GatewayConnection(
            configProvider: { (url: reboundURL, token: "route-token", password: "route-password") },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            }))
        )
        let changedPassword = GatewayConnection(
            configProvider: { (url: reboundURL, token: "route-token", password: "replacement-password") },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            }))
        )
        let changedToken = GatewayConnection(
            configProvider: { (url: reboundURL, token: "replacement-token", password: "route-password") },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            }))
        )
        let firstRoute = try #require(await first.captureRoute())
        let reboundRoute = try #require(await rebound.captureRoute())
        let changedPasswordRoute = try #require(await changedPassword.captureRoute())
        let changedTokenRoute = try #require(await changedToken.captureRoute())
        let firstFingerprint = try #require(firstRoute.activationOwnershipFingerprint)
        let reboundFingerprint = try #require(reboundRoute.activationOwnershipFingerprint)
        let changedPasswordFingerprint = try #require(changedPasswordRoute.activationOwnershipFingerprint)
        let changedTokenFingerprint = try #require(changedTokenRoute.activationOwnershipFingerprint)
        let legacyValues = [firstURL.absoluteString, "route-token", "route-password"]
        let legacyFrame = legacyValues.map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
        let legacyVerifier = SHA256.hash(data: Data(legacyFrame.utf8))
            .map { String(format: "%02x", $0) }
            .joined()

        #expect(firstFingerprint != legacyVerifier)
        #expect(firstFingerprint == reboundFingerprint)
        #expect(firstFingerprint != changedPasswordFingerprint)
        #expect(firstFingerprint != changedTokenFingerprint)
        #expect(!firstFingerprint.contains("route-password"))
    }

    @Test func `unsafe v3 credential fingerprint record is scrubbed`() throws {
        let suiteName = "OnboardingUnsafeOwnerMigrationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set([
            "version": 3,
            "records": [
                "local": [
                    "phase": "completed",
                    "activationId": "legacy-activation",
                    "routeFingerprint": "password-derived-verifier",
                ],
            ],
        ], forKey: onboardingSystemAgentPendingKey)

        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .none)
        #expect(defaults.object(forKey: onboardingSystemAgentPendingKey) == nil)
    }

    @Test func `ownerless v2 completion record is scrubbed`() throws {
        let suiteName = "OnboardingOwnerlessReceiptMigrationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set([
            "version": 2,
            "records": ["local": ["phase": "completed"]],
        ], forKey: onboardingSystemAgentPendingKey)

        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .none)
        #expect(defaults.object(forKey: onboardingSystemAgentPendingKey) == nil)
    }

    @Test func `activation fails closed when Keychain binding is unavailable`() async throws {
        let suiteName = "OnboardingMissingKeychainBindingTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let recorder = AISetupRequestRecorder()
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: "route-token", password: nil) },
            activationBindingKeyProvider: { nil },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(
                recorder: recorder,
                detectedKind: "codex-cli"
            ))
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )

        await model.detectAndAutoConnect()
        await model.activate(kind: "codex-cli")

        #expect(await (recorder.snapshot()).methods == ["openclaw.setup.detect"])
        #expect(!OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        #expect(model.phase == .ready)
        guard case let .failed(failure) = model.statuses["codex-cli"] else {
            Issue.record("expected secure-storage failure")
            return
        }
        #expect(failure.detail?.contains("Secure storage") == true)
    }

    @Test func `active v3 record keeps its deadline while credential verifier is scrubbed`() throws {
        let suiteName = "OnboardingActiveUnsafeOwnerMigrationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let deadline = now.addingTimeInterval(120)
        defaults.set([
            "version": 3,
            "records": [
                "local": [
                    "phase": "activating",
                    "startedAt": now.timeIntervalSince1970,
                    "deadlineAt": deadline.timeIntervalSince1970,
                    "activationId": "legacy-activation",
                    "routeFingerprint": "password-derived-verifier",
                ],
            ],
        ], forKey: onboardingSystemAgentPendingKey)

        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now
        ) == .activating(deadline: deadline))
        let migrated = try #require(
            defaults.dictionary(forKey: onboardingSystemAgentPendingKey)
        )
        let records = try #require(migrated["records"] as? [String: Any])
        let local = try #require(records["local"] as? [String: Any])
        #expect(migrated["version"] as? Int == 4)
        #expect(local["activationId"] == nil)
        #expect(local["routeFingerprint"] == nil)
    }

    @Test func `legacy marker relaunch migrates to a full conservative lease`() throws {
        let suiteName = "OnboardingLegacySystemAgentResumeStoreTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        defaults.set("local", forKey: onboardingSystemAgentPendingKey)

        let migrated = OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now
        )
        let deadline: Date? = if case let .activating(deadline) = migrated {
            deadline
        } else {
            nil
        }
        let leaseDeadline = try #require(deadline)

        #expect(leaseDeadline == now.addingTimeInterval(
            OnboardingSystemAgentResumeStore.legacyActivationLeaseSeconds
        ))
        #expect(defaults.object(forKey: onboardingSystemAgentPendingKey) is [String: Any])
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now.addingTimeInterval(484)
        ) == .activating(deadline: leaseDeadline))
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now.addingTimeInterval(486)
        ) == .activationExpired)
    }

    @Test func `missing model cannot start a second activation before pending deadline`() async throws {
        let suiteName = "OnboardingPendingDeadlineBlockTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let routeIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity(state: appState)
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: routeIdentity,
            activationTimeoutMs: 30000,
            defaults: defaults
        )
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                if request.method == "agents.list" {
                    task.emitReceiveSuccess(.data(missingConfiguredModelResponse(id: request.id)))
                }
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { routeIdentity }
        )

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["agents.list"])
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: routeIdentity,
            defaults: defaults
        ))
        view.onboardingDidDisappear()
    }

    @Test func `expired pending activation safely permits a fresh activation`() async throws {
        let suiteName = "OnboardingExpiredPendingActivationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let routeIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity(state: appState)
        let activationOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "expired-owner",
            routeFingerprint: "selected-route"
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: routeIdentity,
            activationOwner: activationOwner,
            activationTimeoutMs: 0,
            defaults: defaults,
            now: Date(timeIntervalSinceNow: -10)
        )
        let recorder = AISetupRequestRecorder()
        let markerObservation = ActivationMarkerObservation()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                switch request.method {
                case "agents.list":
                    task.emitReceiveSuccess(.data(missingConfiguredModelResponse(id: request.id)))
                case "openclaw.setup.detect":
                    if let callbackDefaults = UserDefaults(suiteName: suiteName) {
                        await markerObservation.record(!OnboardingSystemAgentResumeStore.isPending(
                            for: routeIdentity,
                            defaults: callbackDefaults
                        ))
                    }
                    task.emitReceiveSuccess(.data(actionableDetectedSetupResponse(id: request.id)))
                case "openclaw.setup.activate":
                    task.emitReceiveSuccess(.data(failedActivationResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { routeIdentity }
        )

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        let requests = await waitForAISetupRequests(recorder, count: 3)

        #expect(requests.methods == [
            "agents.list",
            "openclaw.setup.detect",
            "openclaw.setup.activate",
        ])
        #expect(await markerObservation.value())
        #expect(!view.aiSetup.waitingForPendingActivationDeadline)
        view.onboardingDidDisappear()
    }

    @Test func `stale missing probe cannot clear a replacement expired owner`() async throws {
        let suiteName = "OnboardingExpiredReplacementOwnerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let routeIdentity = "local"
        let originalOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "expired-owner-a",
            routeFingerprint: "selected-route"
        )
        let replacementOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "expired-owner-b",
            routeFingerprint: "selected-route"
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: routeIdentity,
            activationOwner: originalOwner,
            activationTimeoutMs: 0,
            defaults: defaults,
            now: Date(timeIntervalSinceNow: -10)
        )
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                switch request.method {
                case "agents.list":
                    if let callbackDefaults = UserDefaults(suiteName: suiteName) {
                        OnboardingSystemAgentResumeStore.markPending(
                            routeIdentity: routeIdentity,
                            activationOwner: replacementOwner,
                            activationTimeoutMs: 0,
                            defaults: callbackDefaults,
                            now: Date(timeIntervalSinceNow: -10)
                        )
                    }
                    task.emitReceiveSuccess(.data(missingConfiguredModelResponse(id: request.id)))
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { routeIdentity }
        )

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["agents.list"])
        #expect(OnboardingSystemAgentResumeStore.isOwned(
            by: replacementOwner,
            for: routeIdentity,
            defaults: defaults
        ))
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: routeIdentity,
            defaults: defaults
        ) == .activationExpired)
        #expect(view.aiSetup.phase == .idle)
        view.onboardingDidDisappear()
    }

    @Test func `stale missing probe cannot reset inference connected while suspended`() async throws {
        let suiteName = "OnboardingStaleMissingConnectedTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            defaults: defaults
        )
        OnboardingSystemAgentResumeStore.markCompleted(
            ifOwnedBy: "local",
            defaults: defaults
        )
        let recorder = AISetupRequestRecorder()
        let gate = AISetupRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                switch request.method {
                case "agents.list":
                    await gate.wait()
                    task.emitReceiveSuccess(.data(missingConfiguredModelResponse(id: request.id)))
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" }
        )

        let staleProbe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true
        ))
        await gate.waitUntilStarted()
        view.aiSetup.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        view.aiSetup.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")
        #expect(view.aiSetup.connected)
        await gate.release()
        await staleProbe.value
        await settleQueuedAISetupTasks()

        #expect(view.aiSetup.connected)
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .completed)
        #expect(await (recorder.snapshot()).methods == ["agents.list"])
    }

    @Test func `unavailable configured gateway timeout does not start inference setup`() async throws {
        let suiteName = "OnboardingUnavailableGatewayTimeoutTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                guard sendIndex > 0 else { return }
                await recorder.record(message)
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" },
            configuredGatewayProbeTimeoutMs: 1
        )
        view.onboardingVisible = true
        view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

        let probe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true
        ))
        await probe.value
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["agents.list"])
        #expect(view.aiSetup.phase == .ready)
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(view.aiSetup.detectError != nil)
        #expect(!OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `configured gateway probe refuses an unpersisted endpoint selection`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                task.emitReceiveSuccess(.data(configuredModelResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let appState = AppState(preview: true)
        appState.connectionMode = .remote
        appState.remoteTransport = .direct
        appState.remoteUrl = "wss://replacement.example.test"
        var persistAttempts = 0
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            aiSetupRouteIdentityProvider: { "remote:direct:replacement.example.test" },
            gatewaySelectionPersister: {
                persistAttempts += 1
                return false
            }
        )
        view.onboardingVisible = true

        let probe = view.probeConfiguredGatewayForDashboard(knownVisible: true)
        await settleQueuedAISetupTasks()

        #expect(probe == nil)
        #expect(persistAttempts == 1)
        #expect(session.snapshotMakeCount() == 0)
        #expect(!view.aiSetup.connected)
    }

    @Test func `read only configured gateway retry does not own inference transition`() {
        let model = OnboardingAISetupModel(routeIdentityProvider: { "local" })

        model.showConfiguredGatewayProbeUnavailable()
        model.beginConfiguredGatewayProbeRetry()

        #expect(model.phase == .detecting)
        #expect(model.configuredGatewayProbeUnavailable)
        #expect(!model.ownsInferenceTransition)
    }

    @Test func `temporary remote connection check cannot start configured gateway probe`() {
        let state = AppState(preview: true)
        state.connectionMode = .unconfigured
        let view = OnboardingView(state: state, aiSetupRouteIdentityProvider: { nil })
        view.configuredGatewayProbe.beginTemporaryConnectionCheck()
        defer { view.configuredGatewayProbe.endTemporaryConnectionCheck() }
        state.connectionMode = .remote

        let probe = view.probeConfiguredGatewayForDashboard(knownVisible: true)

        #expect(probe == nil)
    }

    @Test func `unavailable gateway error preserves expired and completed markers`() async throws {
        for markerPhase in ["expired", "completed"] {
            let suiteName = "OnboardingUnavailableGatewayMarkerTests-\(markerPhase)-\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suiteName))
            defer { defaults.removePersistentDomain(forName: suiteName) }
            OnboardingSystemAgentResumeStore.markPending(
                routeIdentity: "local",
                activationTimeoutMs: markerPhase == "expired" ? 0 : 30000,
                defaults: defaults,
                now: markerPhase == "expired" ? Date(timeIntervalSinceNow: -10) : Date()
            )
            if markerPhase == "completed" {
                OnboardingSystemAgentResumeStore.markCompleted(
                    ifOwnedBy: "local",
                    defaults: defaults
                )
            }
            let recorder = AISetupRequestRecorder()
            let session = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                    guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                    if respondToAISetupHealth(task: task, request: request) {
                        return
                    }
                    await recorder.record(message)
                    task.emitReceiveSuccess(.data(unavailableGatewayResponse(id: request.id)))
                })
            })
            let url = try #require(URL(string: "ws://localhost:18789"))
            let gateway = GatewayConnection(
                configProvider: { (url: url, token: nil, password: nil) },
                sessionBox: WebSocketSessionBox(session: session)
            )
            let appState = AppState(preview: true)
            appState.connectionMode = .local
            let view = OnboardingView(
                state: appState,
                aiSetupGateway: gateway,
                systemAgentDefaults: defaults,
                aiSetupRouteIdentityProvider: { "local" }
            )
            view.onboardingVisible = true
            view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

            let probe = try #require(view.probeConfiguredGatewayForDashboard(
                startAISetupWhenMissing: true,
                knownVisible: true
            ))
            await probe.value
            await settleQueuedAISetupTasks()

            #expect(await (recorder.snapshot()).methods == ["agents.list"])
            #expect(view.aiSetup.phase == .ready)
            #expect(view.aiSetup.configuredGatewayProbeUnavailable)
            let pendingState = OnboardingSystemAgentResumeStore.pendingState(
                for: "local",
                defaults: defaults
            )
            if markerPhase == "expired" {
                #expect(pendingState == .activationExpired)
            } else {
                #expect(pendingState == .completed)
            }

            let retry = try #require(view.retryConfiguredGatewayProbe())
            await retry.value
            let retried = await recorder.snapshot()
            await settleQueuedAISetupTasks()

            #expect(retried.methods == ["agents.list", "agents.list"])
            #expect(view.aiSetup.phase == .ready)
            #expect(view.aiSetup.configuredGatewayProbeUnavailable)
            #expect(OnboardingSystemAgentResumeStore.pendingState(
                for: "local",
                defaults: defaults
            ) == pendingState)
        }
    }

    @Test func `unavailable probe resets stale ready setup before successful missing retry`() async throws {
        let suiteName = "OnboardingUnavailableReadyRetryTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                switch request.method {
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                case "agents.list":
                    let probeCount = await recorder.snapshot().methods.filter { $0 == "agents.list" }.count
                    let response = probeCount == 1
                        ? unavailableGatewayResponse(id: request.id)
                        : missingConfiguredModelResponse(id: request.id)
                    task.emitReceiveSuccess(.data(response))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" }
        )
        view.onboardingVisible = true
        view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

        await view.aiSetup.detectAndAutoConnect()
        #expect(view.aiSetup.phase == .ready)
        #expect(!view.aiSetup.candidates.isEmpty)

        let unavailableProbe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true
        ))
        await unavailableProbe.value
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(view.aiSetup.candidates.isEmpty)

        let retry = try #require(view.retryConfiguredGatewayProbe())
        await retry.value
        let requests = await waitForAISetupRequests(recorder, count: 4)
        await settleQueuedAISetupTasks()

        #expect(requests.methods == [
            "openclaw.setup.detect",
            "agents.list",
            "agents.list",
            "openclaw.setup.detect",
        ])
        #expect(view.aiSetup.phase == .ready)
        #expect(!view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(!view.aiSetup.candidates.isEmpty)
    }

    @Test func `unavailable retry cannot mutate while activation lease is active`() async throws {
        let suiteName = "OnboardingUnavailableActiveLeaseRetryTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            activationTimeoutMs: 30000,
            defaults: defaults
        )
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                let probeCount = await recorder.snapshot().methods.filter { $0 == "agents.list" }.count
                let response = probeCount == 1
                    ? unavailableGatewayResponse(id: request.id)
                    : missingConfiguredModelResponse(id: request.id)
                task.emitReceiveSuccess(.data(response))
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" }
        )

        let unavailableProbe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true
        ))
        await unavailableProbe.value
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)

        let retry = try #require(view.retryConfiguredGatewayProbe())
        await retry.value
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["agents.list", "agents.list"])
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `verified configured model stays read only until pending deadline`() async throws {
        let suiteName = "OnboardingPendingConfiguredVerificationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            activationTimeoutMs: 30000,
            defaults: defaults
        )
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                switch request.method {
                case "agents.list":
                    let agentsListCount = await recorder.snapshot().methods.filter {
                        $0 == "agents.list"
                    }.count
                    let response = agentsListCount == 1
                        ? missingConfiguredModelResponse(id: request.id)
                        : configuredModelResponse(id: request.id)
                    task.emitReceiveSuccess(.data(response))
                case "openclaw.setup.verify":
                    task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" }
        )

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        let configuredProbe = try #require(
            view.probeConfiguredGatewayForDashboard(knownVisible: true)
        )
        await configuredProbe.value
        for _ in 0 ..< 200 {
            if case .verified = OnboardingSystemAgentResumeStore.pendingState(
                for: "local",
                defaults: defaults
            ) {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        let methods = await recorder.snapshot().methods
        #expect(Array(methods.prefix(3)) == [
            "agents.list",
            "agents.list",
            "openclaw.setup.verify",
        ])
        #expect(!methods.contains("openclaw.setup.detect"))
        #expect(!methods.contains("openclaw.setup.activate"))
        #expect(!view.aiSetup.connected)
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect({
            if case .verified = OnboardingSystemAgentResumeStore.pendingState(
                for: "local",
                defaults: defaults
            ) {
                return true
            }
            return false
        }())
        view.onboardingDidDisappear()
    }

    @Test(arguments: [false, true])
    func `replacement auth waits for active or verified owner deadline`(
        wasVerified: Bool
    ) async throws {
        let suiteName = "OnboardingReplacementAuthActiveLeaseTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://127.0.0.1:49152"))
        let seedGateway = GatewayConnection(
            configProvider: { (url: url, token: "route-a", password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            }))
        )
        let seedRoute = try #require(await seedGateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "active-before-auth-replacement",
            routeFingerprint: #require(seedRoute.activationOwnershipFingerprint)
        )
        _ = try #require(OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:ssh:stable-gateway",
            activationOwner: activationOwner,
            activationTimeoutMs: 30000,
            defaults: defaults
        ))
        if wasVerified {
            OnboardingSystemAgentResumeStore.markVerified(
                ifOwnedBy: "remote:ssh:stable-gateway",
                activationOwner: activationOwner,
                defaults: defaults
            )
        }
        let expectedDeadline: Date
        switch OnboardingSystemAgentResumeStore.pendingState(
            for: "remote:ssh:stable-gateway",
            defaults: defaults
        ) {
        case let .activating(storedDeadline), let .verified(storedDeadline):
            expectedDeadline = storedDeadline
        case .activationExpired, .completed, .none:
            Issue.record("expected seeded activation lease")
            return
        }

        let recorder = AISetupRequestRecorder()
        let replacementGateway = GatewayConnection(
            configProvider: { (url: url, token: "route-b", password: nil) },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder))
        )
        let model = OnboardingAISetupModel(
            gateway: replacementGateway,
            defaults: defaults,
            routeIdentityProvider: { "remote:ssh:stable-gateway" }
        )
        var scheduledDeadlines: [Date] = []
        model.onPendingActivationDeadline = { scheduledDeadline, _ in
            scheduledDeadlines.append(scheduledDeadline)
        }

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()
        model.retryFromScratch()
        await settleQueuedAISetupTasks()

        #expect(outcome == .notConnected)
        #expect(await (recorder.snapshot()).methods.isEmpty)
        #expect(!model.connected)
        #expect(!model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(scheduledDeadlines == [expectedDeadline])
        #expect(OnboardingSystemAgentResumeStore.activationOwner(
            for: "remote:ssh:stable-gateway",
            defaults: defaults
        ) == activationOwner)
        let pendingState = OnboardingSystemAgentResumeStore.pendingState(
            for: "remote:ssh:stable-gateway",
            defaults: defaults
        )
        if wasVerified {
            guard case let .verified(storedDeadline) = pendingState else {
                Issue.record("expected verified activation lease")
                return
            }
            #expect(storedDeadline == expectedDeadline)
        } else {
            guard case let .activating(storedDeadline) = pendingState else {
                Issue.record("expected active activation lease")
                return
            }
            #expect(storedDeadline == expectedDeadline)
        }
    }

    @Test func `expired ambiguous activation cannot hand off from same model verification`() async throws {
        let suiteName = "OnboardingVerifiedExpiredActivationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                switch request.method {
                case "openclaw.setup.verify":
                    task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let route = try #require(await gateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "expired-activation",
            routeFingerprint: #require(route.activationOwnershipFingerprint)
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            activationOwner: activationOwner,
            activationTimeoutMs: 0,
            defaults: defaults,
            now: Date(timeIntervalSinceNow: -10)
        )
        OnboardingSystemAgentResumeStore.markVerified(
            ifOwnedBy: "local",
            activationOwner: activationOwner,
            defaults: defaults
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var handedOff = false
        model.onConnected = { handedOff = true }

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()
        let requests = await waitForAISetupRequests(recorder, count: 2)

        #expect(outcome == .freshSetupAllowed)
        #expect(!model.connected)
        #expect(!handedOff)
        #expect(requests.methods == ["openclaw.setup.verify", "openclaw.setup.detect"])
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .none)
    }

    @Test func `relaunch cannot reuse a completed receipt on replacement Gateway auth`() async throws {
        let suiteName = "OnboardingReplacementRouteReceiptTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let seedGateway = GatewayConnection(
            configProvider: { (url: url, token: "route-a", password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            }))
        )
        let seedRoute = try #require(await seedGateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "completed-activation",
            routeFingerprint: #require(seedRoute.activationOwnershipFingerprint)
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            activationOwner: activationOwner,
            defaults: defaults
        )
        #expect(OnboardingSystemAgentResumeStore.markCompleted(
            ifOwnedBy: "local",
            activationOwner: activationOwner,
            defaults: defaults
        ))

        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: "route-b", password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                    guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                    if respondToAISetupHealth(task: task, request: request) {
                        return
                    }
                    await recorder.record(message)
                    if request.method == "openclaw.setup.detect" {
                        task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                    }
                })
            }))
        )
        let relaunched = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )

        relaunched.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await relaunched.verifyPendingConfiguredInference()
        let requests = await waitForAISetupRequests(recorder, count: 1)

        #expect(outcome == .freshSetupAllowed)
        #expect(!relaunched.connected)
        #expect(requests.methods == ["openclaw.setup.detect"])
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .none)
    }

    @Test func `relaunch cannot reuse a completed receipt after device token rotation`() async throws {
        let suiteName = "OnboardingDeviceTokenReceiptRotationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            let deviceAuthGatewayID = "local"
            let originalToken = "receipt-device-token-a"
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: originalToken,
                gatewayID: deviceAuthGatewayID
            )
            let replacementToken = "receipt-device-token-b"
            let url = try #require(URL(string: "ws://example.invalid"))
            let activationBindingKey = SymmetricKey(size: .bits256)
            let seedSession = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                        _ = respondToAISetupHealth(task: task, request: request)
                    },
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        let id = task.snapshotConnectRequestID() ?? "connect"
                        return .data(GatewayWebSocketTestSupport.connectOkData(
                            id: id,
                            deviceToken: replacementToken
                        ))
                    }
                )
            })
            let seedGateway = GatewayConnection(
                endpointProvider: {
                    GatewayConnection.EndpointSnapshot(
                        config: (url: url, token: nil, password: nil),
                        routeAuthority: nil,
                        deviceAuthGatewayID: deviceAuthGatewayID
                    )
                },
                activationBindingKeyProvider: { activationBindingKey },
                sessionBox: WebSocketSessionBox(session: seedSession)
            )
            let seedLease = try await seedGateway.acquireServerLease()
            let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
                id: "completed-device-token-activation",
                routeFingerprint: #require(await seedGateway.activationOwnershipFingerprint(
                    ifCurrentServerLease: seedLease
                ))
            )
            #expect(await seedGateway.authSource() == .deviceToken)
            OnboardingSystemAgentResumeStore.markPending(
                routeIdentity: "local",
                activationOwner: activationOwner,
                defaults: defaults
            )
            #expect(OnboardingSystemAgentResumeStore.markCompleted(
                ifOwnedBy: "local",
                activationOwner: activationOwner,
                defaults: defaults
            ))
            let persistedReceipt = String(describing: defaults.object(forKey: onboardingSystemAgentPendingKey))
            #expect(!persistedReceipt.contains(originalToken))
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: deviceAuthGatewayID
            )?.token == replacementToken)
            await seedGateway.shutdown()

            let recorder = AISetupRequestRecorder()
            let replacementGateway = GatewayConnection(
                endpointProvider: {
                    GatewayConnection.EndpointSnapshot(
                        config: (url: url, token: nil, password: nil),
                        routeAuthority: nil,
                        deviceAuthGatewayID: deviceAuthGatewayID
                    )
                },
                activationBindingKeyProvider: { activationBindingKey },
                sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder))
            )
            let relaunched = OnboardingAISetupModel(
                gateway: replacementGateway,
                defaults: defaults,
                routeIdentityProvider: { "local" }
            )

            relaunched.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
            let outcome = await relaunched.verifyPendingConfiguredInference()
            let requests = await waitForAISetupRequests(recorder, count: 1)

            #expect(outcome == .freshSetupAllowed)
            #expect(!relaunched.connected)
            #expect(requests.methods == ["openclaw.setup.detect"])
            #expect(OnboardingSystemAgentResumeStore.pendingState(
                for: "local",
                defaults: defaults
            ) == .none)
            #expect(!String(describing: defaults.object(forKey: onboardingSystemAgentPendingKey))
                .contains(replacementToken))
            await replacementGateway.shutdown()
        }
    }

    @Test func `relaunch cannot hand off after completed receipt owner is replaced`() async throws {
        let suiteName = "OnboardingSameModelReplacementOwnerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let recorder = AISetupRequestRecorder()
        let replacementID = "replacement-after-relaunch"
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: "shared-route", password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                    guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                    if respondToAISetupHealth(task: task, request: request) {
                        return
                    }
                    await recorder.record(message)
                    switch request.method {
                    case "openclaw.setup.verify":
                        if let callbackDefaults = UserDefaults(suiteName: suiteName),
                           let originalOwner = OnboardingSystemAgentResumeStore.activationOwner(
                               for: "local",
                               defaults: callbackDefaults
                           )
                        {
                            let replacementOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
                                id: replacementID,
                                routeFingerprint: originalOwner.routeFingerprint
                            )
                            OnboardingSystemAgentResumeStore.markPending(
                                routeIdentity: "local",
                                activationOwner: replacementOwner,
                                defaults: callbackDefaults
                            )
                            OnboardingSystemAgentResumeStore.markCompleted(
                                ifOwnedBy: "local",
                                activationOwner: replacementOwner,
                                defaults: callbackDefaults
                            )
                        }
                        task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
                    default:
                        break
                    }
                })
            }))
        )
        let route = try #require(await gateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "completed-before-relaunch",
            routeFingerprint: #require(route.activationOwnershipFingerprint)
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            activationOwner: activationOwner,
            defaults: defaults
        )
        #expect(OnboardingSystemAgentResumeStore.markCompleted(
            ifOwnedBy: "local",
            activationOwner: activationOwner,
            defaults: defaults
        ))
        let relaunched = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var handoffCount = 0
        relaunched.onConnected = { handoffCount += 1 }

        relaunched.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await relaunched.verifyPendingConfiguredInference()
        let requests = await waitForAISetupRequests(recorder, count: 1)

        #expect(outcome == .notConnected)
        #expect(!relaunched.connected)
        #expect(handoffCount == 0)
        #expect(requests.methods == ["openclaw.setup.verify"])
        #expect(OnboardingSystemAgentResumeStore.activationOwner(
            for: "local",
            defaults: defaults
        )?.id == replacementID)
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .completed)
    }

    @Test func `ownerless mutations cannot match an owned activation`() throws {
        let suiteName = "OnboardingOwnedActivationMutationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let activationOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "owned-activation",
            routeFingerprint: "owned-route"
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            activationOwner: activationOwner,
            defaults: defaults
        )

        OnboardingSystemAgentResumeStore.markVerified(
            ifOwnedBy: "local",
            defaults: defaults
        )
        #expect({
            if case .activating = OnboardingSystemAgentResumeStore.pendingState(
                for: "local",
                defaults: defaults
            ) {
                return true
            }
            return false
        }())
        #expect(!OnboardingSystemAgentResumeStore.markCompleted(
            ifOwnedBy: "local",
            defaults: defaults
        ))

        OnboardingSystemAgentResumeStore.clear(
            ifOwnedBy: "local",
            defaults: defaults
        )
        #expect(OnboardingSystemAgentResumeStore.isOwned(
            by: activationOwner,
            for: "local",
            defaults: defaults
        ))
    }

    @Test func `pending marker for another route is preserved`() throws {
        let suiteName = "OnboardingSystemAgentRouteMismatchTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults
        )

        #expect(!OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults
        ))
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults
        ))
    }

    @Test func `A to B to A preserves first activation lease`() throws {
        let suiteName = "OnboardingSystemAgentMultiRouteTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)

        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults,
            now: now
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-b",
            defaults: defaults,
            now: now.addingTimeInterval(1)
        )

        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults,
            now: now.addingTimeInterval(2)
        ))
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults,
            now: now.addingTimeInterval(2)
        ))

        OnboardingSystemAgentResumeStore.clear(
            ifOwnedBy: "remote:id:gateway-b",
            defaults: defaults
        )
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults,
            now: now.addingTimeInterval(2)
        ))
        #expect(!OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults,
            now: now.addingTimeInterval(2)
        ))
    }

    @Test func `route reset clears only current route lease`() throws {
        let suiteName = "OnboardingSystemAgentRouteResetTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-b")
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults
        )
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-b",
            defaults: defaults
        )
        let model = OnboardingAISetupModel(
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() }
        )

        model.resetForGatewayChange()

        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults
        ))
        #expect(!OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults
        ))
    }

    @Test func `gateway selection reset preserves in flight lease`() throws {
        let suiteName = "OnboardingSystemAgentSelectionResetTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            defaults: defaults
        )
        let view = OnboardingView(
            state: appState,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" }
        )

        view.resetGatewayBoundAIState()

        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "local",
            defaults: defaults
        ))
    }

    @Test func `v1 route marker migrates without blocking another route`() throws {
        let suiteName = "OnboardingSystemAgentV1MigrationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        defaults.set([
            "version": 1,
            "routeIdentity": "remote:id:gateway-a",
            "phase": "verified",
        ], forKey: onboardingSystemAgentPendingKey)

        #expect({
            if case .verified = OnboardingSystemAgentResumeStore.pendingState(
                for: "remote:id:gateway-a",
                defaults: defaults,
                now: now
            ) {
                return true
            }
            return false
        }())
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-b",
            defaults: defaults,
            now: now
        )
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults,
            now: now
        ))
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults,
            now: now
        ))
    }

    @Test func `fallback remote route identity omits auth but preserves endpoint`() {
        let authenticatedIdentity = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "wss://user:secret@gateway.example.test/path?tenant=team-a&token=secret#fragment",
            remoteTarget: ""
        )
        let cleanIdentity = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "wss://gateway.example.test/path?tenant=team-a",
            remoteTarget: ""
        )
        let otherEndpointIdentity = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "wss://gateway.example.test/other",
            remoteTarget: ""
        )
        let otherQueryIdentity = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "wss://gateway.example.test/path?tenant=team-b",
            remoteTarget: ""
        )

        #expect(authenticatedIdentity?.hasPrefix("remote:direct:") == true)
        #expect(authenticatedIdentity?.contains("secret") == false)
        #expect(authenticatedIdentity?.contains("gateway.example.test") == false)
        #expect(authenticatedIdentity == cleanIdentity)
        #expect(authenticatedIdentity != otherEndpointIdentity)
        #expect(authenticatedIdentity != otherQueryIdentity)
    }

    @Test func `fallback route identity distinguishes local state dirs and ssh gateway ports`() {
        let localA = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .local,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "",
            remoteTarget: "",
            localStateDir: URL(fileURLWithPath: "/tmp/openclaw-state-a")
        )
        let localB = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .local,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "",
            remoteTarget: "",
            localStateDir: URL(fileURLWithPath: "/tmp/openclaw-state-b")
        )
        let sshA = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .ssh,
            remoteURL: "",
            remoteTarget: "user@gateway.example.test",
            sshRemotePort: 18789
        )
        let sshB = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .ssh,
            remoteURL: "",
            remoteTarget: "user@gateway.example.test",
            sshRemotePort: 18790
        )

        #expect(localA?.hasPrefix("local:") == true)
        #expect(localA != localB)
        #expect(sshA != sshB)
    }

    @Test func `fallback remote route identity canonicalizes the persisted URL`() {
        let beforePersistence = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "ws://localhost",
            remoteTarget: ""
        )
        let afterPersistence = OnboardingSystemAgentResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "ws://localhost:18789",
            remoteTarget: ""
        )

        #expect(beforePersistence == afterPersistence)
    }

    @Test func `activation marks pending before request and clears definitive failure`() async throws {
        let suiteName = "OnboardingActivationMarkerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let observation = ActivationMarkerObservation()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupPreparation(task: task, request: request, kind: "codex-cli") {
                    return
                }
                let requestDefaults = UserDefaults(suiteName: suiteName)
                await observation.record(
                    requestDefaults.map {
                        OnboardingSystemAgentResumeStore.isPending(
                            for: "local",
                            defaults: $0
                        )
                    } == true
                )
                task.emitReceiveSuccess(.data(failedActivationResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )

        await model.detectAndAutoConnect()
        await model.activate(kind: "codex-cli")

        #expect(await observation.value())
        #expect(!OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `stale queued detection cannot probe a replacement Gateway`() async throws {
        let suiteName = "OnboardingQueuedDetectionRouteTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "route-a-token")
        let recorder = AISetupRequestRecorder()
        let session = makeAISetupSession(recorder: recorder)
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() }
        )

        model.startIfNeeded()
        model.resetForGatewayChange()
        config.setToken("route-b-token")
        routeIdentity.set("remote:id:gateway-b")
        model.startIfNeeded()

        let requests = await waitForAISetupRequests(recorder, count: 1)
        await settleQueuedAISetupTasks()
        #expect(requests.methods == ["openclaw.setup.detect"])
        #expect(requests.apiKeys.isEmpty)
        #expect(model.phase == .ready)
    }

    @Test func `stale queued selection cannot activate on a replacement Gateway`() async throws {
        let suiteName = "OnboardingQueuedSelectionRouteTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "route-a-token")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder))
        )
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() }
        )
        await model.detectAndAutoConnect()

        model.userSelect(kind: "claude-cli")
        model.resetForGatewayChange()
        config.setToken("route-b-token")
        routeIdentity.set("remote:id:gateway-b")
        await settleQueuedAISetupTasks()

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["openclaw.setup.detect"])
        #expect(!OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults
        ))
        #expect(model.phase == .idle)
    }

    @Test func `stale manual key task never sends credentials to a replacement Gateway`() async throws {
        let suiteName = "OnboardingQueuedManualRouteTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "route-a-token")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder))
        )
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() }
        )
        await model.detectAndAutoConnect()
        model.manualProviderID = "openai-api-key"
        model.manualKey = "old-route-secret"

        model.submitManualKey()
        model.resetForGatewayChange()
        config.setToken("route-b-token")
        routeIdentity.set("remote:id:gateway-b")
        await settleQueuedAISetupTasks()

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["openclaw.setup.detect"])
        #expect(!requests.apiKeys.contains("old-route-secret"))
        #expect(!OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults
        ))
        #expect(!model.manualTesting)
    }

    @Test func `automatic activation rejects an auth-token change before dispatch`() async throws {
        let suiteName = "OnboardingAutomaticActivationTokenTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "token-a")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(
                recorder: recorder,
                detectedKind: "codex-cli"
            ))
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )

        await model.detectAndAutoConnect()
        config.switchToken(to: "token-b", afterReads: 2)
        await model.activate(kind: "codex-cli")

        #expect(await (recorder.snapshot()).methods == ["openclaw.setup.detect"])
        #expect(!OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        #expect(!model.pendingActivationVerification)
        #expect(model.phase == .ready)
    }

    @Test func `manual activation rejects an auth-token change before sending the key`() async throws {
        let suiteName = "OnboardingManualActivationTokenTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "token-a")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder))
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        await model.detectAndAutoConnect()
        model.manualProviderID = "openai-api-key"
        model.manualKey = "must-not-send"
        config.switchToken(to: "token-b", afterReads: 2)

        model.submitManualKey()
        for _ in 0 ..< 200 {
            guard model.manualTesting else { break }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["openclaw.setup.detect"])
        #expect(!requests.apiKeys.contains("must-not-send"))
        #expect(!OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        #expect(!model.pendingActivationVerification)
        #expect(model.detectError != nil)
    }

    @Test func `cancellation after activation dispatch retains pending resume marker`() async throws {
        let suiteName = "OnboardingDispatchedCancellationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "token-a")
        let recorder = AISetupRequestRecorder()
        let gate = AISetupRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                if respondToAISetupPreparation(
                    task: task,
                    request: request,
                    kind: "codex-cli"
                ) {
                    return
                }
                guard request.method == "openclaw.setup.activate" else { return }
                await gate.wait()
                throw CancellationError()
            })
        })
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        model.onPendingActivationDeadline = { deadline, routeIdentity in
            scheduledDeadlines.append((deadline, routeIdentity))
        }

        await model.detectAndAutoConnect()
        let activation = Task { await model.activate(kind: "codex-cli") }
        await gate.waitUntilStarted()
        activation.cancel()
        await gate.release()
        await activation.value

        #expect(await (recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
        ])
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.isBusy)
        #expect(model.phase == .detecting)
        #expect(scheduledDeadlines.count == 1)
        #expect(scheduledDeadlines.first?.routeIdentity == "local")
    }

    @Test func `indeterminate Gateway activation error retains pending resume marker`() async throws {
        let suiteName = "OnboardingIndeterminateGatewayActivationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                    guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                    if respondToAISetupPreparation(task: task, request: request, kind: "codex-cli") {
                        return
                    }
                    await recorder.record(message)
                    task.emitReceiveSuccess(.data(indeterminateActivationResponse(id: request.id)))
                })
            }))
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var scheduledRoutes: [String] = []
        model.onPendingActivationDeadline = { _, routeIdentity in
            scheduledRoutes.append(routeIdentity)
        }

        await model.detectAndAutoConnect()
        await model.activate(kind: "codex-cli")

        #expect(await (recorder.snapshot()).methods == ["openclaw.setup.activate"])
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.phase == .detecting)
        #expect(scheduledRoutes == ["local"])
    }

    @Test func `ambiguous activation recreates a marker cleared by an earlier probe`() async throws {
        let suiteName = "OnboardingMarkerClearedActivationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let recorder = AISetupRequestRecorder()
        let markerObservation = ActivationMarkerObservation()
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                    guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                    if respondToAISetupPreparation(task: task, request: request, kind: "codex-cli") {
                        return
                    }
                    await recorder.record(message)
                    if let callbackDefaults = UserDefaults(suiteName: suiteName) {
                        let pendingState = OnboardingSystemAgentResumeStore.pendingState(
                            for: "local",
                            defaults: callbackDefaults
                        )
                        if case let .activating(deadline) = pendingState {
                            await markerObservation.record(deadline: deadline)
                        }
                        OnboardingSystemAgentResumeStore.clear(
                            ifOwnedBy: "local",
                            defaults: callbackDefaults
                        )
                    }
                    task.emitReceiveSuccess(.data(indeterminateActivationResponse(id: request.id)))
                })
            }))
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        model.onPendingActivationDeadline = { deadline, routeIdentity in
            #expect(OnboardingSystemAgentResumeStore.isPending(
                for: routeIdentity,
                defaults: defaults
            ))
            scheduledDeadlines.append((deadline, routeIdentity))
        }

        await model.detectAndAutoConnect()
        await model.activate(kind: "codex-cli")

        #expect(await (recorder.snapshot()).methods == ["openclaw.setup.activate"])
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.phase == .detecting)
        #expect(scheduledDeadlines.count == 1)
        #expect(scheduledDeadlines.first?.routeIdentity == "local")
        let originalDeadline = try #require(await markerObservation.deadline())
        let restoredState = OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        )
        guard case let .activating(restoredDeadline) = restoredState else {
            Issue.record("expected restored activation marker")
            return
        }
        #expect(restoredDeadline == originalDeadline)

        let relaunched = OnboardingAISetupModel(
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        relaunched.waitForPendingActivationDeadline()
        #expect(relaunched.waitingForPendingActivationDeadline)
        #expect(relaunched.pendingActivationVerification == false)
    }

    @Test func `ambiguous activation with cleared marker cannot hand off from same model`() async throws {
        let suiteName = "OnboardingClearedMarkerConfiguredRouteTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                    guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                    if respondToAISetupHealth(task: task, request: request) {
                        return
                    }
                    await recorder.record(message)
                    switch request.method {
                    case "openclaw.setup.activate":
                        if let callbackDefaults = UserDefaults(suiteName: suiteName) {
                            OnboardingSystemAgentResumeStore.clear(
                                ifOwnedBy: "local",
                                defaults: callbackDefaults
                            )
                        }
                        task.emitReceiveSuccess(.data(indeterminateActivationResponse(id: request.id)))
                    case "agents.list":
                        task.emitReceiveSuccess(.data(configuredModelResponse(id: request.id)))
                    case "openclaw.setup.verify":
                        task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
                    case "openclaw.setup.detect":
                        task.emitReceiveSuccess(.data(detectedSetupResponse(
                            id: request.id,
                            kind: "codex-cli",
                            modelRef: "openai/gpt-5.5"
                        )))
                    default:
                        break
                    }
                })
            }))
        )
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" }
        )
        view.onboardingVisible = true
        var scheduledDeadlines: [Date] = []
        var handoffCount = 0
        view.aiSetup.onConnected = { handoffCount += 1 }
        view.aiSetup.onPendingActivationDeadline = { deadline, routeIdentity in
            guard routeIdentity == "local" else { return }
            scheduledDeadlines.append(deadline)
        }

        await view.aiSetup.detectAndAutoConnect()
        await view.aiSetup.activate(kind: "codex-cli")
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        #expect(scheduledDeadlines.count == 1)

        let initialRecheck = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true
        ))
        await initialRecheck.value
        let requests = await waitForAISetupRequests(recorder, count: 4)
        await settleQueuedAISetupTasks()

        #expect(requests.methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
            "agents.list",
            "openclaw.setup.verify",
        ])
        #expect(!view.aiSetup.connected)
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect({
            if case .verified = OnboardingSystemAgentResumeStore.pendingState(
                for: "local",
                defaults: defaults
            ) {
                return true
            }
            return false
        }())

        let activationOwner = try #require(OnboardingSystemAgentResumeStore.activationOwner(
            for: "local",
            defaults: defaults
        ))
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            activationOwner: activationOwner,
            activationTimeoutMs: 0,
            defaults: defaults,
            now: Date(timeIntervalSinceNow: -10)
        )
        let deadlineRecheck = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true
        ))
        await deadlineRecheck.value
        let completedRequests = await waitForAISetupRequests(recorder, count: 7)
        await settleQueuedAISetupTasks()

        #expect(completedRequests.methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
            "agents.list",
            "openclaw.setup.verify",
            "agents.list",
            "openclaw.setup.verify",
            "openclaw.setup.detect",
        ])
        #expect(!view.aiSetup.connected)
        #expect(view.aiSetup.phase == .ready)
        #expect(!view.aiSetup.pendingActivationVerification)
        #expect(!view.aiSetup.waitingForPendingActivationDeadline)
        #expect(handoffCount == 0)
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .none)
        view.onboardingDidDisappear()
    }

    @Test func `ambiguous activation after lease expiry rechecks before fresh setup`() async throws {
        let suiteName = "OnboardingExpiredDispatchedCancellationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupHealth(task: task, request: request) {
                    return
                }
                await recorder.record(message)
                switch request.method {
                case "openclaw.setup.activate":
                    if let requestDefaults = UserDefaults(suiteName: suiteName),
                       let activationOwner = OnboardingSystemAgentResumeStore.activationOwner(
                           for: "local",
                           defaults: requestDefaults
                       )
                    {
                        OnboardingSystemAgentResumeStore.markPending(
                            routeIdentity: "local",
                            activationOwner: activationOwner,
                            activationTimeoutMs: 0,
                            defaults: requestDefaults,
                            now: Date(timeIntervalSinceNow: -10)
                        )
                    }
                    task.emitReceiveSuccess(.data(indeterminateActivationResponse(id: request.id)))
                case "agents.list":
                    task.emitReceiveSuccess(.data(missingConfiguredModelResponse(id: request.id)))
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" }
        )
        var recheckTask: Task<Void, Never>?
        var recheckRoute: String?
        view.aiSetup.onPendingActivationDeadline = { _, routeIdentity in
            recheckRoute = routeIdentity
            recheckTask = view.probeConfiguredGatewayForDashboard(
                startAISetupWhenMissing: true,
                knownVisible: true,
                knownAISetupPage: true
            )
        }

        await view.aiSetup.detectAndAutoConnect()
        await view.aiSetup.activate(kind: "claude-cli")
        await recheckTask?.value
        let requests = await waitForAISetupRequests(recorder, count: 4)
        await settleQueuedAISetupTasks()

        #expect(recheckRoute == "local")
        #expect(requests.methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
            "agents.list",
            "openclaw.setup.detect",
        ])
        #expect(view.aiSetup.phase == .ready)
        #expect(!view.aiSetup.pendingActivationVerification)
        #expect(!view.aiSetup.waitingForPendingActivationDeadline)
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults
        ) == .none)
        view.onboardingDidDisappear()
    }

    @Test func `manual indeterminate response schedules pending deadline recheck`() async throws {
        let suiteName = "OnboardingManualDispatchedCancellationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(
                recorder: recorder,
                indeterminateActivationAfterDispatch: true
            ))
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        await model.detectAndAutoConnect()
        model.manualProviderID = "openai-api-key"
        model.manualKey = "temporary-key"
        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        model.onPendingActivationDeadline = { deadline, routeIdentity in
            scheduledDeadlines.append((deadline, routeIdentity))
        }

        model.submitManualKey()
        for _ in 0 ..< 200 {
            if !model.manualTesting, model.waitingForPendingActivationDeadline {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(await (recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
        ])
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.phase == .detecting)
        #expect(scheduledDeadlines.count == 1)
        #expect(scheduledDeadlines.first?.routeIdentity == "local")
    }

    @Test func `superseded activation cannot clear the current gateway handoff`() async throws {
        let suiteName = "OnboardingSupersededActivationMarkerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if respondToAISetupPreparation(task: task, request: request, kind: "codex-cli") {
                    return
                }
                task.emitReceiveFailure()
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "remote:id:gateway-a" }
        )

        await model.detectAndAutoConnect()
        let staleActivation = Task { await model.activate(kind: "codex-cli") }
        while !OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults
        ) {
            await Task.yield()
        }
        model.resetForGatewayChange()
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-b",
            defaults: defaults
        )
        staleActivation.cancel()
        await staleActivation.value

        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults
        ))
    }

    @Test func `configured resume preserves marker until route reset`() throws {
        let suiteName = "OnboardingConfiguredResumeMarkerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = OnboardingAISetupModel(
            defaults: defaults,
            routeIdentityProvider: { "local" }
        )
        OnboardingSystemAgentResumeStore.markPending(routeIdentity: "local", defaults: defaults)

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))

        model.resetForGatewayChange()
        #expect(!OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `retired setup socket requires a fresh detection lease`() {
        let model = OnboardingAISetupModel()
        model.manualProviderID = "openai"
        model.manualKey = "temporary-key"
        model.showManualEntry = true
        let failure = OnboardingAISetupModel.transportFailure("connection dropped")

        model.requireFreshDetection(after: failure)

        #expect(model.phase == .ready)
        #expect(model.detectError == failure)
        #expect(model.candidates.isEmpty)
        #expect(model.manualProviders.isEmpty)
        #expect(model.manualProviderID.isEmpty)
        #expect(model.manualKey.isEmpty)
        #expect(!model.showManualEntry)
    }
}
