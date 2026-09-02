import AppKit
import ApplicationServices
import ConcurrencyExtras
import CryptoKit
import Foundation
import ObjectiveC
import Observation
import OpenClawChatUI
import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private actor ActivationMarkerObservation {
    private var observed = false
    private var observedDeadline: Date?

    func record(_ value: Bool) {
        self.observed = value
    }

    func value() -> Bool {
        self.observed
    }

    func record(deadline: Date?) {
        self.observedDeadline = deadline
    }

    func deadline() -> Date? {
        self.observedDeadline
    }
}

private final class ActivationOwnerObservation: @unchecked Sendable {
    private let owner = LockIsolated<OnboardingSystemAgentResumeStore.ActivationOwner?>(nil)

    func record(_ owner: OnboardingSystemAgentResumeStore.ActivationOwner?) {
        self.owner.withValue { $0 = owner }
    }

    func value() -> OnboardingSystemAgentResumeStore.ActivationOwner? {
        self.owner.withValue { $0 }
    }
}

private final class AISetupSocketGeneration: @unchecked Sendable {
    private let generation = LockIsolated(0)

    func claim() -> Int {
        self.generation.withValue { value in
            defer { value += 1 }
            return value
        }
    }
}

private final class AISetupGatewayConfig: @unchecked Sendable {
    private struct State {
        var token: String
        var switchTokenAfterReads: (remaining: Int, token: String)?
    }

    private let url: URL
    private let state: LockIsolated<State>

    init(url: URL, token: String) {
        self.url = url
        self.state = LockIsolated(State(token: token))
    }

    func setToken(_ token: String) {
        self.state.withValue {
            $0.token = token
            $0.switchTokenAfterReads = nil
        }
    }

    func switchToken(to token: String, afterReads: Int) {
        self.state.withValue { $0.switchTokenAfterReads = (afterReads, token) }
    }

    func snapshot() -> GatewayConnection.Config {
        self.state.withValue { state in
            if let pending = state.switchTokenAfterReads {
                if pending.remaining == 0 {
                    state.token = pending.token
                    state.switchTokenAfterReads = nil
                } else {
                    state.switchTokenAfterReads = (
                        remaining: pending.remaining - 1,
                        token: pending.token)
                }
            }
            return (url: self.url, token: state.token, password: nil)
        }
    }
}

private final class AISetupRouteIdentity: @unchecked Sendable {
    private let value: LockIsolated<String>

    init(_ value: String) {
        self.value = LockIsolated(value)
    }

    func set(_ value: String) {
        self.value.withValue { $0 = value }
    }

    func snapshot() -> String {
        self.value.withValue { $0 }
    }
}

private actor AISetupRequestRecorder {
    private var methods: [String] = []
    private var apiKeys: [String] = []
    private var authChoices: [String] = []

    func record(_ message: URLSessionWebSocketTask.Message) {
        guard let request = aiSetupRequest(from: message) else { return }
        self.methods.append(request.method)
        if let apiKey = request.params["apiKey"] as? String {
            self.apiKeys.append(apiKey)
        }
        if let authChoice = request.params["authChoice"] as? String {
            self.authChoices.append(authChoice)
        }
    }

    func snapshot() -> (methods: [String], apiKeys: [String], authChoices: [String]) {
        (self.methods, self.apiKeys, self.authChoices)
    }
}

private actor AISetupRequestGate {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        self.started = true
        self.startWaiters.forEach { $0.resume() }
        self.startWaiters.removeAll()
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            self.releaseWaiters.append(continuation)
        }
    }

    func waitUntilStarted() async {
        guard !self.started else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func release() {
        self.released = true
        self.releaseWaiters.forEach { $0.resume() }
        self.releaseWaiters.removeAll()
    }
}

private final class AISetupDefaultsCleanup {
    private let suiteName: String

    init(suiteName: String) {
        self.suiteName = suiteName
    }

    deinit {
        UserDefaults.standard.removePersistentDomain(forName: self.suiteName)
    }
}

private func isolatedAISetupDefaults(prefix: String) -> UserDefaults? {
    isolatedAISetupDefaults(suiteName: "\(prefix)-\(UUID().uuidString)")
}

private func isolatedAISetupDefaults(suiteName: String) -> UserDefaults? {
    guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
    objc_setAssociatedObject(
        defaults,
        Unmanaged.passUnretained(defaults).toOpaque(),
        AISetupDefaultsCleanup(suiteName: suiteName),
        .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    return defaults
}

private actor AISetupConfigReadGate {
    private var blockNextRead = false
    private var blocked = false
    private var released = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func armNextRead() {
        self.blockNextRead = true
    }

    func snapshotToken() async -> String {
        if self.blockNextRead {
            self.blockNextRead = false
            self.blocked = true
            self.blockedWaiters.forEach { $0.resume() }
            self.blockedWaiters.removeAll()
            if !self.released {
                await withCheckedContinuation { continuation in
                    self.releaseWaiters.append(continuation)
                }
            }
        }
        return "route-a"
    }

    func waitUntilBlocked() async {
        guard !self.blocked else { return }
        await withCheckedContinuation { continuation in
            self.blockedWaiters.append(continuation)
        }
    }

    func release() {
        self.released = true
        self.releaseWaiters.forEach { $0.resume() }
        self.releaseWaiters.removeAll()
    }
}

private func aiSetupRequest(
    from message: URLSessionWebSocketTask.Message) -> (id: String, method: String, params: [String: Any])?
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
    return (id: id, method: method, params: object["params"] as? [String: Any] ?? [:])
}

private func detectedSetupResponse(
    id: String,
    kind: String = "claude-cli",
    modelRef: String = "claude-cli/claude-opus-4-8") -> Data
{
    Data(
        """
        {"type":"res","id":"\(id)","ok":true,"payload":{
          "candidates":[{"kind":"\(kind)","label":"Test AI","detail":"installed",
            "modelRef":"\(modelRef)","recommended":false,"credentials":false}],
          "manualProviders":[{"id":"openai-api-key","brandId":"openai","icon":"fixture-key-icon",
            "label":"OpenAI API key","hint":null}],
          "prepareOptions":[
            {"id":"ollama","brandId":"ollama","label":"Ollama",
              "hint":"Connect to an Ollama server and select a cloud or local model",
              "actionLabel":"Choose connection"},
            {"id":"llama-cpp","brandId":"llama-cpp","label":"Local model (llama.cpp)",
              "hint":"Download and run a private GGUF model","actionLabel":"Review download"},
            {"id":"lmstudio","brandId":"lmstudio","label":"LM Studio",
              "hint":"Connect to a running LM Studio server and use an already loaded model",
              "actionLabel":"Connect server","icon":"https://cdn.simpleicons.org/lmstudio",
              "website":"https://lmstudio.ai/download"}],
          "workspace":"/tmp/openclaw-workspace","configuredModel":null,"setupComplete":false}}
        """.utf8)
}

private func successfulEmptyResponse(id: String) -> Data {
    Data(#"{"type":"res","id":"\#(id)","ok":true,"payload":{}}"#.utf8)
}

private func respondToAISetupHealth(
    task: GatewayTestWebSocketTask,
    request: (id: String, method: String, params: [String: Any])) -> Bool
{
    guard request.method == "health" else { return false }
    task.emitReceiveSuccess(.data(successfulEmptyResponse(id: request.id)))
    return true
}

private func respondToAISetupPreparation(
    task: GatewayTestWebSocketTask,
    request: (id: String, method: String, params: [String: Any]),
    kind: String) -> Bool
{
    if respondToAISetupHealth(task: task, request: request) {
        return true
    }
    guard request.method == "openclaw.setup.detect" else { return false }
    let modelRef = kind == "codex-cli" ? "openai/gpt-5.5" : "claude-cli/claude-opus-4-8"
    task.emitReceiveSuccess(.data(detectedSetupResponse(
        id: request.id,
        kind: kind,
        modelRef: modelRef)))
    return true
}

private func actionableDetectedSetupResponse(id: String) -> Data {
    let response = String(decoding: detectedSetupResponse(id: id), as: UTF8.self)
        .replacingOccurrences(of: #""credentials":false"#, with: #""credentials":true"#)
    return Data(response.utf8)
}

private func selectableCandidatesDetectedSetupResponse(id: String) -> Data {
    Data(
        """
        {"type":"res","id":"\(id)","ok":true,"payload":{
          "candidates":[
            {"kind":"codex-cli","brandId":"openai","icon":"fixture-candidate-icon",
             "label":"Codex CLI","detail":"installed",
             "modelRef":"openai/gpt-5.5","recommended":false,"credentials":true},
            {"kind":"claude-cli","label":"Claude Code","detail":"installed",
             "modelRef":"claude-cli/claude-opus-4-8","recommended":false,"credentials":true}],
          "manualProviders":[],"workspace":"/tmp/openclaw-workspace",
          "configuredModel":null,"setupComplete":false}}
        """.utf8)
}

private func persistedDetectedSetupResponse(
    id: String,
    configuredModel: String = "openai/gpt-5.5") -> Data
{
    let response = String(decoding: detectedSetupResponse(
        id: id,
        kind: "codex-cli",
        modelRef: "openai/gpt-5.5"), as: UTF8.self)
        .replacingOccurrences(
            of: #""configuredModel":null"#,
            with: #""configuredModel":"\#(configuredModel)""#)
        .replacingOccurrences(of: #""setupComplete":false"#, with: #""setupComplete":true"#)
    return Data(response.utf8)
}

private func missingConfiguredModelResponse(id: String) -> Data {
    Data(
        """
        {"type":"res","id":"\(id)","ok":true,"payload":{
          "defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main"}]}}
        """.utf8)
}

private func configuredModelResponse(id: String) -> Data {
    Data(
        """
        {"type":"res","id":"\(id)","ok":true,"payload":{
          "defaultId":"main","mainKey":"main","scope":"per-sender",
          "agents":[{"id":"main","model":{"primary":"openai/gpt-5.5"}}]}}
        """.utf8)
}

/// Poll on the progress owner's executor; do not exhaust the wait while its work is queued.
@MainActor
private func waitForAISetupRequests(
    _ recorder: AISetupRequestRecorder,
    count: Int) async -> (methods: [String], apiKeys: [String], authChoices: [String])
{
    for _ in 0..<200 {
        let snapshot = await recorder.snapshot()
        if snapshot.methods.count >= count {
            return snapshot
        }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return await recorder.snapshot()
}

private func wizardStartResponse(id: String, sessionID: String) -> Data {
    Data(
        #"{"type":"res","id":"\#(id)","ok":true,"payload":{"sessionId":"\#(sessionID)","done":false,"status":"running"}}"#
            .utf8)
}

private func wizardProgressResponse(id: String, sessionID: String, message: String) -> Data {
    Data(
        """
        {"type":"res","id":"\(id)","ok":true,"payload":{
          "sessionId":"\(sessionID)","done":false,"status":"running",
          "step":{"id":"download","type":"progress","executor":"gateway","message":"\(message)"}}}
        """.utf8)
}

private func wizardDoneResponse(
    id: String,
    sessionID: String,
    preparedModelRef: String? = nil) -> Data
{
    var payload: [String: Any] = [
        "sessionId": sessionID,
        "done": true,
        "status": "done",
    ]
    if let preparedModelRef {
        payload["preparedModelRef"] = preparedModelRef
    }
    return try! JSONSerialization.data(withJSONObject: [
        "type": "res",
        "id": id,
        "ok": true,
        "payload": payload,
    ])
}

private func settleQueuedAISetupTasks() async {
    try? await Task.sleep(nanoseconds: 100_000_000)
}

@MainActor
private func waitForAISetupState(_ condition: () -> Bool) async {
    while !condition() {
        await withCheckedContinuation { continuation in
            withObservationTracking {
                _ = condition()
            } onChange: {
                continuation.resume()
            }
        }
    }
}

private func pendingState(
    _ defaults: UserDefaults,
    for route: String? = "local",
    now: Date = Date()) -> OnboardingSystemAgentResumeStore.PendingState
{
    OnboardingSystemAgentResumeStore.pendingState(for: route, defaults: defaults, now: now)
}

private func storedActivationOwner(
    _ defaults: UserDefaults,
    for route: String? = "local",
    now: Date = Date()) -> OnboardingSystemAgentResumeStore.ActivationOwner?
{
    OnboardingSystemAgentResumeStore.activationOwner(for: route, defaults: defaults, now: now)
}

private func isPending(
    _ defaults: UserDefaults,
    for route: String? = "local",
    now: Date = Date()) -> Bool
{
    OnboardingSystemAgentResumeStore.isPending(for: route, defaults: defaults, now: now)
}

private func isOwned(
    by owner: OnboardingSystemAgentResumeStore.ActivationOwner,
    defaults: UserDefaults,
    for route: String? = "local") -> Bool
{
    OnboardingSystemAgentResumeStore.isOwned(by: owner, for: route, defaults: defaults)
}

@discardableResult
private func markPending(
    _ defaults: UserDefaults,
    for route: String? = "local",
    owner: OnboardingSystemAgentResumeStore.ActivationOwner? = nil,
    timeoutMs: Double = OnboardingSystemAgentResumeStore.maximumActivationTimeoutMs,
    now: Date = Date()) -> Date?
{
    OnboardingSystemAgentResumeStore.markPending(
        routeIdentity: route,
        activationOwner: owner,
        activationTimeoutMs: timeoutMs,
        defaults: defaults,
        now: now)
}

@discardableResult
private func markCompleted(
    _ defaults: UserDefaults,
    for route: String? = "local",
    owner: OnboardingSystemAgentResumeStore.ActivationOwner? = nil) -> Bool
{
    OnboardingSystemAgentResumeStore.markCompleted(
        ifOwnedBy: route,
        activationOwner: owner,
        defaults: defaults)
}

private func routeIdentity(
    _ connectionMode: AppState.ConnectionMode,
    transport: AppState.RemoteTransport = .direct,
    url: String = "",
    target: String = "",
    localStateDir: URL = OpenClawConfigFile.stateDirURL(),
    sshRemotePort: Int = 18789) -> String?
{
    OnboardingSystemAgentResumeStore.routeIdentity(
        connectionMode: connectionMode,
        preferredGatewayID: nil,
        remoteTransport: transport,
        remoteURL: url,
        remoteTarget: target,
        localStateDir: localStateDir,
        sshRemotePort: sshRemotePort)
}

private typealias AISetupRequest = (id: String, method: String, params: [String: Any])
private typealias AISetupRequestHandler = @Sendable (GatewayTestWebSocketTask, AISetupRequest) async throws -> Void
private typealias AISetupHarnessHandler = @Sendable (
    GatewayTestWebSocketTask,
    AISetupRequest,
    AISetupRequestRecorder) async throws -> Data?

private func makeAISetupRequestSession(
    recorder: AISetupRequestRecorder? = nil,
    preparationKind: String? = nil,
    handler: @escaping AISetupRequestHandler = { _, _ in },
    receiveHook: GatewayTestWebSocketTask.ReceiveHook? = nil) -> GatewayTestWebSocketSession
{
    GatewayTestWebSocketSession(taskFactory: {
        GatewayTestWebSocketTask(
            sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                if let preparationKind,
                   respondToAISetupPreparation(task: task, request: request, kind: preparationKind)
                {
                    return
                }
                if preparationKind == nil, respondToAISetupHealth(task: task, request: request) {
                    return
                }
                if let recorder {
                    await recorder.record(message)
                }
                try await handler(task, request)
            },
            receiveHook: receiveHook)
    })
}

private func makeAISetupGateway(
    url: URL,
    token: String? = nil,
    password: String? = nil,
    session: GatewayTestWebSocketSession) -> GatewayConnection
{
    GatewayConnection(
        configProvider: { (url: url, token: token, password: password) },
        sessionBox: WebSocketSessionBox(session: session))
}

@MainActor
private func makeAISetupModel(
    gateway: GatewayConnection = .shared,
    defaults: UserDefaults = .standard,
    routeIdentityProvider: @escaping @MainActor () -> String? = { "local" },
    connectionModeProvider: @escaping @MainActor () -> AppState.ConnectionMode = { .local })
    -> OnboardingAISetupModel
{
    OnboardingAISetupModel(
        gateway: gateway,
        defaults: defaults,
        routeIdentityProvider: routeIdentityProvider,
        connectionModeProvider: connectionModeProvider)
}

@MainActor
private func makeAISetupView(
    state: AppState,
    gateway: GatewayConnection = .shared,
    defaults: UserDefaults = .standard,
    routeIdentityProvider: @escaping @MainActor () -> String?,
    configuredGatewayProbeTimeoutMs: Double = 15000,
    gatewaySelectionPersister: (@MainActor () -> Bool)? = nil) -> OnboardingView
{
    OnboardingView(
        state: state,
        aiSetupGateway: gateway,
        systemAgentDefaults: defaults,
        aiSetupRouteIdentityProvider: routeIdentityProvider,
        configuredGatewayProbeTimeoutMs: configuredGatewayProbeTimeoutMs,
        gatewaySelectionPersister: gatewaySelectionPersister)
}

@MainActor
private struct AISetupHarness {
    let recorder: AISetupRequestRecorder
    let session: GatewayTestWebSocketSession
    let gateway: GatewayConnection

    init(
        url: URL,
        token: String? = nil,
        password: String? = nil,
        preparationKind: String? = nil,
        handler: @escaping AISetupHarnessHandler = { _, _, _ in nil },
        receiveHook: GatewayTestWebSocketTask.ReceiveHook? = nil)
    {
        let recorder = AISetupRequestRecorder()
        self.recorder = recorder
        self.session = makeAISetupRequestSession(
            recorder: recorder,
            preparationKind: preparationKind,
            handler: { task, request in
                if let response = try await handler(task, request, recorder) {
                    task.emitReceiveSuccess(.data(response))
                }
            },
            receiveHook: receiveHook)
        self.gateway = makeAISetupGateway(
            url: url,
            token: token,
            password: password,
            session: self.session)
    }

    func model(
        defaults: UserDefaults = .standard,
        routeIdentityProvider: @escaping @MainActor () -> String? = { "local" },
        connectionModeProvider: @escaping @MainActor () -> AppState.ConnectionMode = { .local })
        -> OnboardingAISetupModel
    {
        makeAISetupModel(
            gateway: self.gateway,
            defaults: defaults,
            routeIdentityProvider: routeIdentityProvider,
            connectionModeProvider: connectionModeProvider)
    }

    func view(
        state: AppState,
        defaults: UserDefaults = .standard,
        routeIdentityProvider: @escaping @MainActor () -> String?,
        configuredGatewayProbeTimeoutMs: Double = 15000,
        gatewaySelectionPersister: (@MainActor () -> Bool)? = nil) -> OnboardingView
    {
        makeAISetupView(
            state: state,
            gateway: self.gateway,
            defaults: defaults,
            routeIdentityProvider: routeIdentityProvider,
            configuredGatewayProbeTimeoutMs: configuredGatewayProbeTimeoutMs,
            gatewaySelectionPersister: gatewaySelectionPersister)
    }
}

private func makeAISetupSession(
    recorder: AISetupRequestRecorder,
    indeterminateActivationAfterDispatch: Bool = false,
    detectedKind: String = "claude-cli") -> GatewayTestWebSocketSession
{
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
                    modelRef: modelRef)))
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
    postRestartConfiguredModel: String?,
    replacementGate: AISetupRequestGate? = nil) -> GatewayTestWebSocketSession
{
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
                        modelRef: "openai/gpt-5.5")))
                case "openclaw.setup.activate":
                    let owner = UserDefaults(suiteName: suiteName).flatMap {
                        OnboardingSystemAgentResumeStore.activationOwner(
                            for: "local",
                            defaults: $0)
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
                if let replacementGate {
                    await replacementGate.wait()
                }
                let response = postRestartConfiguredModel.map {
                    persistedDetectedSetupResponse(id: request.id, configuredModel: $0)
                } ?? detectedSetupResponse(
                    id: request.id,
                    kind: "codex-cli",
                    modelRef: "openai/gpt-5.5")
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
    Data(#"{"type":"res","id":"\#(id)","ok":true,"payload":{"ok":false,"status":"auth","error":"rejected"}}"#.utf8)
}

private func successfulActivationResponse(
    id: String,
    modelRef: String,
    latencyMs: Int,
    gatewayRestartRequired: Bool = false) -> Data
{
    let restartField = gatewayRestartRequired ? ",\"gatewayRestartRequired\":true" : ""
    return Data(
        """
        {"type":"res","id":"\(id)","ok":true,"payload":{
          "ok":true,"modelRef":"\(modelRef)","latencyMs":\(latencyMs),"lines":["Model ready"]\(restartField)}}
        """.utf8)
}

private func indeterminateActivationResponse(id: String) -> Data {
    Data(
        """
        {"type":"res","id":"\(id)","ok":false,"error":{
          "code":"UNAVAILABLE","message":"Setup inference activation is indeterminate"}}
        """.utf8)
}

private func verifiedSetupResponse(id: String) -> Data {
    Data(#"{"type":"res","id":"\#(id)","ok":true,"payload":{"ok":true,"modelRef":"openai/gpt-5.5","latencyMs":42}}"#
        .utf8)
}

private func rejectedSetupVerificationResponse(id: String) -> Data {
    Data(#"{"type":"res","id":"\#(id)","ok":true,"payload":{"ok":false,"status":"auth","error":"expired login"}}"#.utf8)
}

private func unconfiguredSetupVerificationResponse(id: String) -> Data {
    Data(
        #"{"type":"res","id":"\#(id)","ok":true,"payload":{"ok":false,"status":"unavailable","error":"No agent model is configured."}}"#
            .utf8)
}

private func unavailableGatewayResponse(id: String) -> Data {
    Data(#"{"type":"res","id":"\#(id)","ok":false,"error":{"code":"UNAVAILABLE","message":"temporary failure"}}"#.utf8)
}

private func setupAdmissionBusyResponse(id: String, confirmed: Bool = true) -> Data {
    let details = confirmed ? #", "details":{"code":"SETUP_ADMISSION_BUSY"}"# : ""
    return Data(
        """
        {"type":"res","id":"\(id)","ok":false,"error":{
          "code":"UNAVAILABLE","message":"OpenClaw setup is already in progress; try again when it finishes.",
          "retryable":true\(details)}}
        """.utf8)
}

private enum AISetupAccessibilityError: Error {
    case requestFailed(code: Int32)
    case missingGetter(String)
}

/// SwiftPM starts background-only, which AppKit does not permit to own windows.
/// Initialize a window-capable test process once; never toggle policy across AX awaits.
@MainActor
private let aiSetupAccessibilityApplication: Void = {
    #expect(NSApplication.shared.setActivationPolicy(.accessory))
    NSApplication.shared.finishLaunching()
}()

@MainActor
private func inspectAISetupAccessibility(_ root: NSView) async throws
-> (labels: [String], actions: [String: Bool]) {
    // A real client request materializes SwiftUI's lazy AX tree. Keep MainActor free
    // for AppKit's reply; window metadata is not used to select the retained root.
    let result = await Task.detached {
        let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        var windows: CFTypeRef?
        return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
    }.value
    guard result == .success else {
        throw AISetupAccessibilityError.requestFailed(code: result.rawValue)
    }
    func required<T>(_ getter: T?, _ name: String) throws -> T {
        guard let getter else { throw AISetupAccessibilityError.missingGetter(name) }
        return getter
    }
    var labels: [String] = []
    var actions: [String: Bool] = [:]
    var visited = Set<ObjectIdentifier>()
    func visit(_ element: AnyObject) throws {
        guard visited.insert(ObjectIdentifier(element)).inserted else { return }
        // SwiftUI virtual nodes implement public ObjC getters without the full
        // NSAccessibilityProtocol; text getters such as accessibilityTitle can be absent.
        let role = try required(element.accessibilityRole, "accessibilityRole")()
        let value: Any? = element.accessibilityValue?()
        let text = [
            element.accessibilityLabel?(),
            element.accessibilityTitle?(),
            value as? String,
        ].compactMap(\.self)
        labels.append(contentsOf: text)
        // Error details use link-styled actions rather than standard buttons.
        if role == .button || role == .link, !text.isEmpty {
            let enabled = try required(element.isAccessibilityEnabled, "isAccessibilityEnabled")()
            for label in text {
                actions[label] = enabled
            }
        }
        for child in try required(element.accessibilityChildren, "accessibilityChildren")() ?? [] {
            try visit(child as AnyObject)
        }
    }
    try visit(root)
    return (labels, actions)
}

@MainActor
private func inspectAISetupSheet(
    _ model: OnboardingAISetupModel,
    colorScheme: ColorScheme = .light) async -> (labels: [String], actions: [String: Bool], size: NSSize)
{
    _ = aiSetupAccessibilityApplication
    var appeared = false
    let hosting = NSHostingView(rootView: OnboardingAISetupSheet(model: model)
        .environment(\.colorScheme, colorScheme)
        .onAppear { appeared = true })
    hosting.frame = NSRect(x: 0, y: 0, width: 500, height: 500)
    // Keep the sheet mounted through the AX request and detach it before closing.
    let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    defer {
        window.orderOut(nil)
        window.contentView = nil
        window.close()
    }
    window.orderFront(nil)
    hosting.layoutSubtreeIfNeeded()
    window.displayIfNeeded()
    hosting.layoutSubtreeIfNeeded()
    #expect(appeared)
    let snapshot: (labels: [String], actions: [String: Bool])
    do {
        snapshot = try await inspectAISetupAccessibility(hosting)
    } catch {
        // Record the failure without skipping callers' gated wizard-task cleanup.
        Issue.record(error)
        snapshot = ([], [:])
    }
    #expect(snapshot.actions["Cancel"] != nil)
    return (snapshot.labels, snapshot.actions, hosting.fittingSize)
}

@Suite(.serialized)
@MainActor
struct OnboardingAISetupTests {
    @Test func `candidate failure keeps friendly summary and exact detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "auth",
            error: "Codex login expired (request 42)")

        #expect(failure.summary == "Codex CLI is installed, but the login didn’t work. Sign in again, then retry.")
        #expect(failure.detail == "Codex login expired (request 42)")
        #expect(failure.copyText == "Codex login expired (request 42)")
    }

    @Test func `candidate failure omits empty detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "timeout",
            error: "  ")

        #expect(failure.summary == "Codex CLI didn’t answer in time.")
        #expect(failure.detail == nil)
        #expect(failure.copyText == failure.summary)
    }

    @Test func `transport failure preserves original detail`() {
        let failure = OnboardingAISetupModel.transportFailure(
            "Gateway request failed: connection reset")

        #expect(failure.summary == "The Gateway setup request failed. Show details to inspect or copy the error.")
        #expect(failure.detail == "Gateway request failed: connection reset")
    }

    @Test func `unavailable failure keeps long detail out of the visible summary`() {
        let rawDetail = String(repeating: "installer output ", count: 200)
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "unavailable",
            error: rawDetail)

        #expect(failure.summary == "Codex CLI couldn’t complete the test. Show details to inspect or copy the error.")
        #expect(failure.detail == rawDetail.trimmingCharacters(in: .whitespacesAndNewlines))
        #expect(failure.copyText == failure.detail)
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

    @Test func `reconciliation deadline recomputes each RPC budget`() async throws {
        let deadline = OnboardingAISetupModel.ReconciliationDeadline(timeout: .seconds(2))
        let detectionBudget = deadline.remainingMilliseconds(cappedAt: 10000)

        try await Task.sleep(nanoseconds: 50_000_000)

        let verificationBudget = deadline.remainingMilliseconds(cappedAt: 10000)
        #expect(verificationBudget < detectionBudget)
    }

    @Test func `prepare choices use wire presentation and hide usable local models`() {
        let candidates = [
            OnboardingAISetupModel.Candidate(
                kind: "provider-auto:ollama",
                label: "Ollama",
                detail: "available locally",
                modelRef: "ollama/qwen3:8b",
                credentials: true),
            OnboardingAISetupModel.Candidate(
                kind: "provider-auto:other-choice",
                label: "LM Studio",
                detail: "available locally",
                modelRef: "lmstudio/qwen3-8b-instruct",
                credentials: true),
            OnboardingAISetupModel.Candidate(
                kind: "provider-auto:vendor%2Flocal%3Av1%25beta%3Fx%23y",
                label: "Vendor Local",
                detail: "available locally",
                modelRef: "vendor/model",
                credentials: true),
            OnboardingAISetupModel.Candidate(
                kind: "provider-auto:llama-cpp",
                label: "Local model (llama.cpp)",
                detail: "credentials required",
                modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
                credentials: false),
        ]
        let advertised = [
            OnboardingAISetupModel.PrepareOption(
                id: "ollama",
                label: "Wire Ollama",
                hint: "Wire hint",
                actionLabel: "Choose connection",
                brandId: "ollama",
                icon: "https://cdn.simpleicons.org/ollama",
                website: "https://ollama.com/download"),
            OnboardingAISetupModel.PrepareOption(
                id: "llama-cpp",
                label: "Local model (llama.cpp)",
                hint: "Private GGUF model",
                actionLabel: "Review download",
                brandId: "llama-cpp",
                icon: nil,
                website: nil),
            OnboardingAISetupModel.PrepareOption(
                id: "lmstudio-local",
                label: "LM Studio",
                hint: "Running local service",
                actionLabel: "Connect server",
                brandId: "lmstudio",
                icon: "https://cdn.simpleicons.org/lmstudio",
                website: "https://lmstudio.ai/download"),
            OnboardingAISetupModel.PrepareOption(
                id: "vendor/local:v1%beta?x#y",
                label: "Vendor Local",
                hint: nil,
                actionLabel: nil,
                brandId: "different-namespace",
                icon: nil,
                website: nil),
        ]

        let options = OnboardingAISetupModel.prepareOptions(
            candidates: candidates,
            advertisedOptions: advertised)

        #expect(options.map(\.id) == ["llama-cpp"])
        #expect(options.first?.label == "Local model (llama.cpp)")
        #expect(options.first?.actionLabel == "Review download")
        #expect(OnboardingAISetupModel.ProviderWizardKind.prepare.startMethod ==
            "openclaw.setup.prepare.start")
    }

    @Test(
        arguments: ["accept", "decline", "cancel", "error", "error-replaced", "malformed-success", "retry-cancel"],
        [false, true])
    func `activation consent uses shared wizard`(decision: String, manual: Bool) async throws {
        let recorder = AISetupRequestRecorder()
        let activationAttempts = AISetupSocketGeneration()
        let cancellationFails = LockIsolated(true)
        let terminalError = decision == "error" || decision == "error-replaced"
        let accepts = terminalError || ["accept", "malformed-success"].contains(decision)
        let failureDetail = "AI access was saved, but could not be applied."
        let reviewMessage = Array(
            repeating: "Review the staged runtime package and its capabilities.",
            count: manual ? 30 : 1).joined(separator: "\n")
        let defaults = try #require(isolatedAISetupDefaults(prefix: "ActivationConsent"))
        let session = makeAISetupRequestSession(
            recorder: recorder,
            handler: { task, request in
                var payload: [String: Any]
                switch request.method {
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(manual
                            ? detectedSetupResponse(id: request.id)
                            : selectableCandidatesDetectedSetupResponse(id: request.id)))
                    return
                case "openclaw.setup.activate.start":
                    #expect(request.params["kind"] as? String == (manual ? "api-key" : "codex-cli"))
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    if activationAttempts.claim() > 0 {
                        payload = [
                            "sessionId": sessionID, "done": true, "status": "done",
                            "modelActivation": ["modelRef": request
                                .params["modelRef"] as? String ?? "synthetic/manual"],
                        ]
                        break
                    }
                    task.emitReceiveSuccess(.data(wizardStartResponse(id: request.id, sessionID: sessionID)))
                    return
                case "wizard.next":
                    let answer = request.params["answer"] as? [String: Any]
                    switch answer?["stepId"] as? String {
                    case "review":
                        payload = ["done": false, "status": "running", "step": [
                            "id": "consent", "type": "confirm", "executor": "client",
                            "message": "Accept the reviewed plugin capabilities?", "initialValue": false,
                        ]]
                    case "consent":
                        let accepted = try #require(answer?["value"] as? Bool)
                        #expect(accepted == accepts)
                        payload = if terminalError {
                            ["done": true, "status": "error", "error": failureDetail]
                        } else if decision == "malformed-success" {
                            ["done": true, "status": "done"]
                        } else if accepted {
                            ["done": true, "status": "done", "modelActivation": ["modelRef": "openai/gpt-5.5"]]
                        } else {
                            ["done": true, "status": "cancelled", "error": "Plugin capability review was declined."]
                        }
                    default:
                        payload = ["done": false, "status": "running", "step": [
                            "id": "review", "type": "note", "executor": "client",
                            "title": "Plugin capabilities",
                            "message": reviewMessage,
                        ]]
                    }
                case "wizard.cancel":
                    if decision == "retry-cancel" {
                        if cancellationFails.value {
                            payload = ["status": "running"]
                            break
                        }
                        try task.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                            "type": "res", "id": request.id, "ok": false,
                            "error": ["code": "INVALID_REQUEST", "message": "wizard not found"],
                        ])))
                        return
                    }
                    payload = ["status": "cancelled", "error": "cancelled"]
                default:
                    Issue.record("Unexpected setup request: \(request.method)")
                    throw URLError(.unsupportedURL)
                }
                try task.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                    "type": "res", "id": request.id, "ok": true, "payload": payload,
                ])))
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: task.snapshotConnectRequestID() ?? "connect",
                    methods: ["openclaw.setup.activate", "openclaw.setup.activate.start"],
                    capabilities: ["openclaw-setup-model-ref"]))
            })
        let gateway = try makeAISetupGateway(url: #require(URL(string: "ws://example.invalid")), session: session)
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        var handoffs = 0
        model.onConnected = { handoffs += 1 }
        let activation = Task {
            await model.detectAndAutoConnect()
            if manual {
                model.manualProviderID = "openai-api-key"
                model.manualKey = "fixture-key"
                model.submitManualKey()
            }
        }
        defer {
            model.resetForGatewayChange()
            activation.cancel()
        }
        for _ in 0..<400 where model.authStep == nil {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        #expect(model.authStep?.title == "Plugin capabilities")
        #expect(model.activeAuthOption?.label == (manual ? "OpenAI API key" : "Codex CLI"))
        #expect(model.activeAuthOption?.brandId == "openai")
        #expect(model.activeAuthOption?.icon == (manual ? "fixture-key-icon" : "fixture-candidate-icon"))
        let reviewSheet = await inspectAISetupSheet(model)
        #expect(reviewSheet.labels.contains(reviewMessage))
        #expect(reviewSheet.size.height <= 500)
        if manual { #expect(reviewSheet.size.height > 260) }
        #expect(reviewSheet.actions["Continue"] == true)
        #expect(!model.connected)
        model.continueProviderAuth()
        for _ in 0..<400 where model.authStep?.id != "consent" {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        #expect(model.authStep.map(wizardStepType) == "confirm")
        #expect(!model.authConfirmation)
        let originalOwner = try #require(storedActivationOwner(defaults))
        let replacementOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: UUID().uuidString,
            routeFingerprint: originalOwner.routeFingerprint)
        if decision == "error-replaced" {
            markPending(defaults, owner: replacementOwner)
        }
        let consentSheet = await inspectAISetupSheet(model)
        #expect(consentSheet.labels.contains("Confirm"))
        #expect(consentSheet.actions["Submit"] == true)
        if decision == "retry-cancel" {
            model.cancelProviderAuth()
            for _ in 0..<400 where model.authError == nil {
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            #expect(model.authError != nil)
            #expect(model.authBusy)
            let retrySheet = await inspectAISetupSheet(model)
            #expect(retrySheet.actions["Cancel"] == true)
            #expect(!retrySheet.labels.contains("Requesting cancellation…"))
            #expect(retrySheet.labels.contains("Cancellation not confirmed"))
            cancellationFails.setValue(false)
            model.cancelProviderAuth()
        } else if decision == "cancel" {
            model.cancelProviderAuth()
        } else {
            model.authConfirmation = accepts
            model.continueProviderAuth()
        }
        for _ in 0..<400 where model.activeAuthOption != nil {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        await activation.value
        await settleQueuedAISetupTasks()
        let ambiguous = decision == "malformed-success" || decision == "retry-cancel"
        #expect(model.connected == (decision == "accept"))
        #expect(handoffs == (decision == "accept" ? 1 : 0))
        #expect(model.pendingActivationVerification == ambiguous)
        #expect(model.waitingForPendingActivationDeadline == ambiguous)
        #expect(model.isBusy == ambiguous)
        #expect(model.activeAuthOption == nil)
        if decision != "accept" {
            let failure: OnboardingAISetupModel.Failure
            if manual {
                failure = try #require(model.manualError)
            } else {
                guard case let .failed(candidateFailure) = model.statuses["codex-cli"] else {
                    Issue.record("Expected a visible activation failure")
                    return
                }
                failure = candidateFailure
            }
            if decision == "decline" || decision == "cancel" {
                #expect(failure.summary ==
                    "AI setup was cancelled. No inference route was selected. Choose a connection to try again.")
                #expect(failure.detail == nil)
            } else {
                #expect(failure.summary ==
                    "The Gateway setup request failed. Show details to inspect or copy the error.")
                #expect(failure.detail == (terminalError
                        ? failureDetail
                        :
                        "AI setup ended before its result was received. OpenClaw will verify the Gateway before trying again."))
            }
        }
        #expect(!model.exhaustedAutoCandidates)
        let requests = await recorder.snapshot()
        #expect(!requests.methods.contains("openclaw.setup.activate"))
        #expect(requests.methods.filter { $0 == "openclaw.setup.activate.start" }.count == 1)
        if terminalError {
            #expect(model.phase == .ready)
            if decision == "error-replaced" {
                #expect(storedActivationOwner(defaults) == replacementOwner)
            } else {
                #expect(pendingState(defaults) == .none)
            }
        } else if ambiguous {
            #expect(model.phase == .detecting)
            #expect(storedActivationOwner(defaults) == originalOwner)
        }
        guard decision == "error" else { return }
        // The failed wizard has settled. A new user action may retry immediately,
        // while the assertion above forbids an automatic switch to the next candidate.
        try #require(!model.isBusy)
        if manual {
            model.manualKey = "corrected-fixture-key"
            model.submitManualKey()
        } else {
            model.userSelect(kind: "codex-cli")
        }
        for _ in 0..<400 where !model.connected {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        #expect(model.connected)
        #expect(handoffs == 1)
        #expect(pendingState(defaults) == .completed)
        #expect(storedActivationOwner(defaults) != originalOwner)
        let retried = await recorder.snapshot()
        #expect(retried.methods.filter { $0 == "openclaw.setup.activate.start" }.count == 2)
        if manual {
            #expect(retried.apiKeys == ["fixture-key", "corrected-fixture-key"])
        }
    }

    @Test(arguments: ["terminal-reply", "nonterminal-reply", "confirmed-cancel"])
    func `activation cancel follows current wizard request ownership`(outcome: String) async throws {
        let terminalReply = outcome == "terminal-reply"
        let confirmedCancellation = outcome == "confirmed-cancel"
        let recorder = AISetupRequestRecorder()
        let frames = AISetupSocketGeneration()
        let terminal = AISetupRequestGate()
        let cancellation = AISetupRequestGate()
        let session = makeAISetupRequestSession(
            recorder: recorder,
            handler: { task, request in
                switch request.method {
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(selectableCandidatesDetectedSetupResponse(id: request.id)))
                case "openclaw.setup.activate.start":
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    task.emitReceiveSuccess(.data(wizardStartResponse(id: request.id, sessionID: sessionID)))
                case "wizard.next" where frames.claim() == 0:
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    task.emitReceiveSuccess(.data(wizardProgressResponse(
                        id: request.id,
                        sessionID: sessionID,
                        message: "Installing runtime")))
                case "wizard.next":
                    await terminal.wait()
                    let payload: [String: Any] = terminalReply
                        ? ["done": true, "status": "done", "modelActivation": ["modelRef": "openai/gpt-5.5"]]
                        : ["done": false, "status": "running", "step": [
                            "id": "review-again", "type": "note", "executor": "client", "message": "Review pending",
                        ]]
                    try task.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                        "type": "res", "id": request.id, "ok": true, "payload": payload,
                    ])))
                case "wizard.cancel":
                    if confirmedCancellation {
                        task.emitReceiveSuccess(.data(Data(
                            #"{"type":"res","id":"\#(request.id)","ok":true,"payload":{"status":"cancelled"}}"#.utf8)))
                        return
                    }
                    if !terminalReply { await cancellation.wait() }
                    try task.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                        "type": "res",
                        "id": request.id,
                        "ok": false,
                        "error": ["code": "INVALID_REQUEST", "message": "wizard not found"],
                    ])))
                default:
                    break
                }
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: task.snapshotConnectRequestID() ?? "connect",
                    methods: ["openclaw.setup.activate", "openclaw.setup.activate.start"],
                    capabilities: ["openclaw-setup-model-ref"]))
            })
        let gateway = try makeAISetupGateway(url: #require(URL(string: "ws://example.invalid")), session: session)
        let defaults = try #require(isolatedAISetupDefaults(prefix: "ActivationCancelTerminalRace"))
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        let activation = Task { await model.detectAndAutoConnect() }
        defer {
            model.resetForGatewayChange()
            activation.cancel()
        }

        await terminal.waitUntilStarted()
        model.cancelProviderAuth()
        if !terminalReply, !confirmedCancellation {
            await cancellation.waitUntilStarted()
            let pendingSheet = await inspectAISetupSheet(model)
            #expect(pendingSheet.labels.contains("Requesting cancellation…"))
            #expect(pendingSheet.actions["Cancel"] == false)
            #expect(pendingSheet.actions["Submit"] == nil)
            #expect(model.activeAuthOption != nil)
        }
        _ = await waitForAISetupRequests(recorder, count: 5)
        await settleQueuedAISetupTasks()
        if confirmedCancellation {
            for _ in 0..<400 where model.activeAuthOption != nil {
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            try #require(model.activeAuthOption == nil)
            await activation.value
        }
        // A running step captured before cancellation can arrive after its acknowledgement.
        await terminal.release()
        if !terminalReply, !confirmedCancellation {
            for _ in 0..<400 where model.authStep?.id != "review-again" {
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            try #require(model.authStep?.id == "review-again")
            await cancellation.release()
        }
        for _ in 0..<400 where model.activeAuthOption != nil {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        try #require(model.activeAuthOption == nil)
        await activation.value
        await settleQueuedAISetupTasks()

        #expect(model.connected == terminalReply)
        #expect(model.pendingActivationVerification == (!terminalReply && !confirmedCancellation))
        if confirmedCancellation {
            #expect(model.authStep == nil)
            #expect(pendingState(defaults) == .none)
        }
        if terminalReply { #expect(pendingState(defaults) == .completed) }
        #expect(await recorder.snapshot().methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate.start",
            "wizard.next",
            "wizard.next",
            "wizard.cancel",
        ])
    }

    @Test(
        arguments: [false, true],
        [OnboardingAISetupModel.ProviderWizardKind.activation, .auth, .prepare])
    func `setup cancel before admission observes the late session`(
        commitLocked: Bool, kind: OnboardingAISetupModel.ProviderWizardKind) async throws
    {
        let startGate = AISetupRequestGate()
        let cancelCount = LockIsolated(0)
        let detections = AISetupSocketGeneration()
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(
            url: url,
            handler: { _, request, _ in
                switch request.method {
                case "openclaw.setup.detect":
                    if kind == .activation { return selectableCandidatesDetectedSetupResponse(id: request.id) }
                    return detections.claim() == 0
                        ? detectedSetupResponse(id: request.id)
                        : persistedDetectedSetupResponse(id: request.id)
                case kind.startMethod:
                    await startGate.wait()
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    return wizardStartResponse(id: request.id, sessionID: sessionID)
                case "wizard.cancel":
                    let attempt = cancelCount.withValue { value in
                        value += 1
                        return value
                    }
                    if attempt == 1 {
                        return try JSONSerialization.data(withJSONObject: [
                            "type": "res",
                            "id": request.id,
                            "ok": false,
                            "error": ["code": "INVALID_REQUEST", "message": "wizard not found"],
                        ])
                    }
                    return try JSONSerialization.data(withJSONObject: [
                        "type": "res",
                        "id": request.id,
                        "ok": true,
                        "payload": ["status": commitLocked ? "running" : "cancelled"],
                    ])
                case "wizard.next":
                    #expect(request.params["answer"] == nil)
                    return try JSONSerialization.data(withJSONObject: [
                        "type": "res",
                        "id": request.id,
                        "ok": true,
                        "payload": [
                            "done": true,
                            "status": "done",
                            "modelActivation": ["modelRef": "openai/gpt-5.5"],
                            "preparedModelRef": "openai/gpt-5.5",
                        ],
                    ])
                case "openclaw.setup.activate":
                    return successfulActivationResponse(id: request.id, modelRef: "openai/gpt-5.5", latencyMs: 1)
                default:
                    return nil
                }
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: task.snapshotConnectRequestID() ?? "connect",
                    methods: ["openclaw.setup.activate", kind.startMethod],
                    capabilities: ["openclaw-setup-model-ref"]))
            })
        let defaults = try #require(isolatedAISetupDefaults(prefix: "ActivationLateAdmissionCancel"))
        let model = harness.model(defaults: defaults)
        let activation = Task {
            await model.detectAndAutoConnect()
            if kind != .activation {
                model.startProviderWizard(
                    OnboardingAISetupModel.AuthOption(
                        id: "test-provider", brandId: nil, label: "Test provider", hint: nil,
                        groupLabel: nil, icon: nil, website: nil, kind: "oauth", featured: false),
                    kind: kind)
            }
        }
        defer {
            model.resetForGatewayChange()
            activation.cancel()
        }

        await startGate.waitUntilStarted()
        model.cancelProviderAuth()
        try #require(model.activeAuthOption != nil)
        _ = await waitForAISetupRequests(harness.recorder, count: 3)
        await startGate.release()
        await waitForAISetupState { model.activeAuthOption == nil }
        try #require(model.activeAuthOption == nil)
        await activation.value
        if commitLocked { await waitForAISetupState { model.connected } }

        #expect(model.connected == commitLocked)
        #expect(model.activeAuthOption == nil)
        let requests = await harness.recorder.snapshot().methods
        #expect(requests.filter { $0 == "wizard.cancel" }.count == (commitLocked ? 3 : 2))
        #expect(requests.filter { $0 == "wizard.next" }.count == (commitLocked ? 1 : 0))
    }

    @Test func `active activation wizard retains candidate ownership`() async throws {
        let startGate = AISetupRequestGate()
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(
            url: url,
            handler: { _, request, _ in
                switch request.method {
                case "openclaw.setup.detect":
                    return selectableCandidatesDetectedSetupResponse(id: request.id)
                case "openclaw.setup.activate.start":
                    await startGate.wait()
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    return try JSONSerialization.data(withJSONObject: [
                        "type": "res",
                        "id": request.id,
                        "ok": true,
                        "payload": [
                            "sessionId": sessionID,
                            "done": true,
                            "status": "done",
                            "modelActivation": ["modelRef": "openai/gpt-5.5"],
                        ],
                    ])
                default:
                    return nil
                }
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: task.snapshotConnectRequestID() ?? "connect",
                    methods: ["openclaw.setup.activate", "openclaw.setup.activate.start"],
                    capabilities: ["openclaw-setup-model-ref"]))
            })
        let model = harness.model()
        let activation = Task { await model.detectAndAutoConnect() }
        defer { activation.cancel() }

        await startGate.waitUntilStarted()
        model.userSelect(kind: "claude-cli")

        #expect(model.selectedKind == "codex-cli")
        #expect(model.activeAuthOption?.label == "Codex CLI")
        let startingSheet = await inspectAISetupSheet(model)
        #expect(startingSheet.labels.contains("Preparing your AI connection…"))
        #expect(startingSheet.actions["Submit"] == nil)
        #expect(startingSheet.size.width == 500)
        #expect((220...260).contains(startingSheet.size.height))
        await startGate.release()
        await activation.value
        #expect(await harness.recorder.snapshot().methods.filter {
            $0 == "openclaw.setup.activate.start"
        }.count == 1)
    }

    @Test(arguments: [ColorScheme.light, .dark])
    func `prepare starts the shared wizard and polls gateway progress`(colorScheme: ColorScheme) async throws {
        let recorder = AISetupRequestRecorder()
        let frames = AISetupSocketGeneration()
        let completion = AISetupRequestGate()
        let preparedModelRef = "llama-cpp/gemma-4-e4b-it-q4_k_m"
        let session = makeAISetupRequestSession(
            recorder: recorder,
            handler: { task, request in
                switch request.method {
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                case "openclaw.setup.activate":
                    #expect(request.params["kind"] as? String == "provider-auto:llama-cpp")
                    #expect(request.params["modelRef"] as? String == preparedModelRef)
                    task.emitReceiveSuccess(.data(successfulActivationResponse(
                        id: request.id,
                        modelRef: preparedModelRef,
                        latencyMs: 731)))
                case "openclaw.setup.prepare.start":
                    let sessionID = request.params["sessionId"] as? String ?? "prepare-session"
                    task.emitReceiveSuccess(.data(wizardStartResponse(
                        id: request.id,
                        sessionID: sessionID)))
                case "wizard.next":
                    let sessionID = request.params["sessionId"] as? String ?? "prepare-session"
                    // Two gateway-executed progress frames, then the terminal
                    // result: a client that stops after the first frame never
                    // reaches either follow-up.
                    switch frames.claim() {
                    case 0:
                        task.emitReceiveSuccess(.data(wizardProgressResponse(
                            id: request.id,
                            sessionID: sessionID,
                            message: "Downloading model: 25%")))
                    case 1:
                        task.emitReceiveSuccess(.data(wizardProgressResponse(
                            id: request.id,
                            sessionID: sessionID,
                            message: "Downloading model: 80%")))
                    default:
                        await completion.wait()
                        task.emitReceiveSuccess(.data(wizardDoneResponse(
                            id: request.id,
                            sessionID: sessionID,
                            preparedModelRef: preparedModelRef)))
                    }
                default:
                    break
                }
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                let id = task.snapshotConnectRequestID() ?? "connect"
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: id,
                    methods: [
                        "openclaw.setup.prepare.start",
                        "openclaw.setup.activate",
                    ],
                    capabilities: ["openclaw-setup-model-ref"]))
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = makeAISetupGateway(url: url, session: session)
        let model = makeAISetupModel(gateway: gateway)

        await model.detectAndAutoConnect()
        let option = try #require(model.prepareOptions.first { $0.id == "llama-cpp" })
        model.startProviderPrepare(option)
        // Bounded wait, not `completion.waitUntilStarted()`: a client that stops
        // polling never reaches the gated frame, and this must fail rather than
        // hang. Once five requests are recorded the third `wizard.next` is held
        // at the gate, so the sheet deterministically shows the second frame.
        let requests = await waitForAISetupRequests(recorder, count: 5)

        #expect(Array(requests.methods.prefix(5)) == [
            "openclaw.setup.detect",
            "openclaw.setup.prepare.start",
            "wizard.next",
            "wizard.next",
            "wizard.next",
        ])
        #expect(requests.authChoices == ["llama-cpp"])
        #expect(model.isPreparingModel)
        #expect(model.authStep.map(wizardStepType) == "progress")
        #expect(model.authStep?.message == "Downloading model: 80%")
        let progressSheet = await inspectAISetupSheet(model, colorScheme: colorScheme)
        #expect(progressSheet.labels.contains("Downloading model: 80%"))
        #expect(progressSheet.labels.contains(option.label))
        #expect(progressSheet.actions["Submit"] == nil)
        #expect(progressSheet.actions["Continue"] == nil)
        #expect(progressSheet.actions["Cancel"] == true)
        model.continueProviderAuth()
        await settleQueuedAISetupTasks()
        #expect(await recorder.snapshot().methods.count == requests.methods.count)

        await completion.release()
        for _ in 0..<400 where !model.connected {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        #expect(model.activeAuthOption == nil)
        #expect(model.authError == nil)
        #expect(model.connected)
        #expect(model.selectedKind == "provider-auto:llama-cpp")
        let completedRequests = await recorder.snapshot()
        #expect(completedRequests.methods.suffix(2) == [
            "wizard.next",
            "openclaw.setup.activate",
        ])
        #expect(completedRequests.methods.filter { $0 == "openclaw.setup.detect" }.count == 1)
    }

    @Test func `prepare without a model handoff falls back to detection`() async throws {
        let recorder = AISetupRequestRecorder()
        let detections = AISetupSocketGeneration()
        let preparedModelRef = "llama-cpp/gemma-4-e4b-it-q4_k_m"
        let session = makeAISetupRequestSession(
            recorder: recorder,
            handler: { task, request in
                switch request.method {
                case "openclaw.setup.detect":
                    if detections.claim() == 0 {
                        task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                    } else {
                        let response = String(decoding: detectedSetupResponse(
                            id: request.id,
                            kind: "provider-auto:llama-cpp",
                            modelRef: preparedModelRef), as: UTF8.self)
                            .replacingOccurrences(
                                of: #""credentials":false"#,
                                with: #""credentials":true"#)
                        task.emitReceiveSuccess(.data(Data(response.utf8)))
                    }
                case "openclaw.setup.prepare.start":
                    let sessionID = request.params["sessionId"] as? String ?? "prepare-session"
                    task.emitReceiveSuccess(.data(wizardDoneResponse(
                        id: request.id,
                        sessionID: sessionID)))
                case "openclaw.setup.activate":
                    task.emitReceiveSuccess(.data(successfulActivationResponse(
                        id: request.id,
                        modelRef: preparedModelRef,
                        latencyMs: 731)))
                default:
                    break
                }
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                let id = task.snapshotConnectRequestID() ?? "connect"
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: id,
                    methods: [
                        "openclaw.setup.prepare.start",
                        "openclaw.setup.activate",
                    ],
                    capabilities: ["openclaw-setup-model-ref"]))
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = makeAISetupGateway(url: url, session: session)
        let model = makeAISetupModel(gateway: gateway)

        await model.detectAndAutoConnect()
        let option = try #require(model.prepareOptions.first { $0.id == "llama-cpp" })
        model.startProviderPrepare(option)
        for _ in 0..<400 where !model.connected {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(model.connected)
        #expect(model.selectedKind == "provider-auto:llama-cpp")
        #expect(await (recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.prepare.start",
            "openclaw.setup.detect",
            "openclaw.setup.activate",
        ])
    }

    @Test func `provider setup kinds encode reserved choice id characters`() {
        #expect(OnboardingAISetupModel.providerAutoSetupKind(
            choiceID: "vendor/local:v1%beta?x#y") ==
            "provider-auto:vendor%2Flocal%3Av1%25beta%3Fx%23y")
    }

    @Test func `provider auth opens only safe external links`() {
        let safe = OnboardingProviderAuthLink.safeURL(
            "https://auth.openai.com/oauth/authorize?client_id=test")
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
            brandId: nil,
            label: "OpenAI",
            hint: nil,
            groupLabel: "OpenAI",
            icon: nil,
            website: nil,
            kind: "oauth",
            featured: true)
        model._test_setProviderAuth(option: option, sessionID: "finished-session")

        model._test_applyAuthWizardResult(
            done: true,
            status: "error",
            error: "The authorization request was denied.")

        #expect(model.activeAuthOption?.id == option.id)
        #expect(model.authError?.copyText == "The authorization request was denied.")
        #expect(model._test_authSessionID == nil)
        #expect(!model.authBusy)

        model.cancelProviderAuth()
        #expect(model.activeAuthOption == nil)
        #expect(model.authError == nil)
    }

    @Test func `provider auth callback reacquires its route after a pre-dispatch disconnect`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingProviderAuthReconnectTests"))
        let detections = AISetupSocketGeneration()
        let answeredSessions = LockIsolated<[String]>([])
        let cancelledSessions = LockIsolated<[String]>([])
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "openclaw.setup.detect":
                return detections.claim() == 0
                    ? detectedSetupResponse(id: request.id)
                    : persistedDetectedSetupResponse(id: request.id)
            case "openclaw.setup.auth.start":
                let sessionID = try #require(request.params["sessionId"] as? String)
                return Data(
                    """
                    {"type":"res","id":"\(request.id)","ok":true,"payload":{
                      "sessionId":"\(sessionID)","done":false,"status":"running",
                      "step":{"id":"login","type":"text","executor":"client",
                        "message":"Enter the sign-in response"}}}
                    """.utf8)
            case "wizard.next":
                let sessionID = try #require(request.params["sessionId"] as? String)
                let answer = try #require(request.params["answer"] as? [String: Any])
                #expect(answer["stepId"] as? String == "login")
                #expect(answer["value"] as? String == "callback-value")
                answeredSessions.withValue { $0.append(sessionID) }
                return wizardDoneResponse(id: request.id, sessionID: sessionID)
            case "wizard.cancel":
                let sessionID = try #require(request.params["sessionId"] as? String)
                cancelledSessions.withValue { $0.append(sessionID) }
                return Data(
                    #"{"type":"res","id":"\#(request.id)","ok":true,"payload":{"status":"cancelled"}}"#.utf8)
            default:
                Issue.record("Unexpected setup request: \(request.method)")
                return successfulEmptyResponse(id: request.id)
            }
        }
        let model = harness.model(defaults: defaults)
        let option = OnboardingAISetupModel.AuthOption(
            id: "test-provider-login", brandId: nil, label: "Test provider", hint: nil,
            groupLabel: nil, icon: nil, website: nil, kind: "oauth", featured: false)

        await model.detectAndAutoConnect()
        model.startProviderAuth(option)
        for _ in 0..<200 where model.authStep == nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        let sessionID = try #require(model._test_authSessionID)
        let staleLease = try #require(await harness.gateway.captureServerLease())
        let firstSocket = try #require(harness.session.latestTask())

        firstSocket.emitReceiveFailure()
        for _ in 0..<200 {
            guard await harness.gateway.isCurrentServerLease(staleLease) else { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(await !harness.gateway.isCurrentServerLease(staleLease))
        model.authText = "callback-value"
        model.continueProviderAuth()
        for _ in 0..<400 where !model.connected && model.authError == nil {
            try await Task.sleep(for: .milliseconds(5))
        }

        #expect(answeredSessions.value == [sessionID])
        #expect(cancelledSessions.value.isEmpty)
        #expect(harness.session.snapshotMakeCount() == 2)
        #expect(model.authError == nil)
        #expect(model.connected)

        let requestCount = await (harness.recorder.snapshot()).methods.count
        model.continueProviderAuth()
        await settleQueuedAISetupTasks()
        #expect(await (harness.recorder.snapshot()).methods.count == requestCount)
        await harness.gateway.shutdown()
    }

    @Test(
        arguments: ["timeout", "replacement-unavailable", "commit-locked"],
        [OnboardingAISetupModel.ProviderWizardKind.auth, .prepare])
    func `unresolved provider cancellation stays visible and retries the exact session`(
        failure: String, kind: OnboardingAISetupModel.ProviderWizardKind) async throws
    {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingUnresolvedAuthCancellationTests"))
        let cancellationFails = LockIsolated(true)
        let cancelledSessions = LockIsolated<[String]>([])
        let recorder = AISetupRequestRecorder()
        let session = makeAISetupRequestSession(
            recorder: recorder,
            handler: { task, request in
                switch request.method {
                case "openclaw.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                case kind.startMethod:
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    task.emitReceiveSuccess(.data(Data(
                        """
                        {"type":"res","id":"\(request.id)","ok":true,"payload":{
                          "sessionId":"\(sessionID)","done":false,"status":"running",
                          "step":{"id":"login","type":"text","executor":"client",
                            "message":"Enter the sign-in response"}}}
                        """.utf8)))
                case "wizard.cancel":
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    cancelledSessions.withValue { $0.append(sessionID) }
                    if !cancellationFails.value {
                        task.emitReceiveSuccess(.data(Data(
                            #"{"type":"res","id":"\#(request.id)","ok":true,"payload":{"status":"cancelled"}}"#.utf8)))
                        return
                    }
                    switch failure {
                    case "timeout":
                        throw URLError(.timedOut)
                    case "replacement-unavailable":
                        task.emitReceiveFailure(URLError(.networkConnectionLost))
                    default:
                        // A commit-locked wizard remains running; cancellation did not succeed.
                        task.emitReceiveSuccess(.data(Data(
                            #"{"type":"res","id":"\#(request.id)","ok":true,"payload":{"status":"running"}}"#
                                .utf8)))
                    }
                default:
                    Issue.record("Unexpected setup mutation: \(request.method)")
                }
            },
            receiveHook: { task, receiveIndex in
                if failure == "replacement-unavailable", cancellationFails.value, !cancelledSessions.value.isEmpty {
                    throw URLError(.cannotConnectToHost)
                }
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: task.snapshotConnectRequestID() ?? "connect"))
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = makeAISetupGateway(url: url, session: session)
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        let option = OnboardingAISetupModel.AuthOption(
            id: "test-provider-login", brandId: nil, label: "Test provider", hint: nil,
            groupLabel: nil, icon: nil, website: nil, kind: "oauth", featured: false)

        await model.detectAndAutoConnect()
        model.startProviderWizard(option, kind: kind)
        await waitForAISetupState { model.authStep != nil }
        #expect(model.authStep?.id == "login")
        #expect(!model.authBusy)
        let sessionID = try #require(model._test_authSessionID)

        model.cancelProviderAuth()
        try #require(model.activeAuthOption == option)
        #expect(model.authError == nil)
        #expect(model._test_authSessionID == sessionID)
        #expect(model.authBusy)
        #expect(model.providerAuthCancellation == .requesting)
        #expect(!model.connected)

        await waitForAISetupState { model.providerAuthCancellation != .requesting }
        #expect(model.providerAuthCancellation == .unconfirmed)
        #expect(model.activeAuthOption == option)
        #expect(model.authError == OnboardingAISetupModel.providerAuthCancellationUnconfirmed())
        let sheet = await inspectAISetupSheet(model)
        #expect(sheet.labels.contains("Cancellation not confirmed"))
        #expect(sheet.actions["Cancel"] == true)
        #expect(sheet.actions["Submit"] == nil)
        cancellationFails.setValue(false)
        model.cancelProviderAuth()
        await waitForAISetupState { model.activeAuthOption == nil }
        #expect(model.authError == nil)
        #expect(model._test_authSessionID == nil)
        #expect(!model.authBusy)
        #expect(!cancelledSessions.value.isEmpty)
        #expect(cancelledSessions.value.allSatisfy { $0 == sessionID })
        #expect(await recorder.snapshot().methods.allSatisfy {
            ["openclaw.setup.detect", kind.startMethod, "wizard.cancel"].contains($0)
        })
        await gateway.shutdown()
    }

    @Test(
        arguments: [OnboardingAISetupModel.ProviderWizardKind.auth, .prepare],
        [
            (outcome: "commit-locked", terminalFirst: false),
            (outcome: "purged", terminalFirst: false),
            (outcome: "failed", terminalFirst: false),
            (outcome: "commit-locked", terminalFirst: true),
            (outcome: "purged", terminalFirst: true),
            (outcome: "failed", terminalFirst: true),
            (outcome: "failed-unresolved", terminalFirst: true),
            (outcome: "failed-cancelled", terminalFirst: true),
            (outcome: "request-failed", terminalFirst: true),
        ])
    func `provider cancellation preserves the pending terminal reply`(
        kind: OnboardingAISetupModel.ProviderWizardKind, scenario: (outcome: String, terminalFirst: Bool)) async throws
    {
        try await withMainSerialExecutor {
            let outcome = scenario.outcome
            let terminalFailure = outcome.hasPrefix("failed") || outcome == "request-failed"
            let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingLockedAuthCancellationTests"))
            let nextGate = AISetupRequestGate()
            let cancellationGate = AISetupRequestGate()
            let cancellationRequests = AISetupSocketGeneration()
            let detections = AISetupSocketGeneration()
            let cancelledSessions = LockIsolated<[String]>([])
            let session = makeAISetupRequestSession(handler: { task, request in
                switch request.method {
                case "openclaw.setup.detect":
                    let response = detections.claim() == 0
                        ? detectedSetupResponse(id: request.id)
                        : persistedDetectedSetupResponse(id: request.id)
                    task.emitReceiveSuccess(.data(response))
                case kind.startMethod:
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    task.emitReceiveSuccess(.data(Data(
                        """
                        {"type":"res","id":"\(request.id)","ok":true,"payload":{
                          "sessionId":"\(sessionID)","done":false,"status":"running",
                          "step":{"id":"login","type":"text","executor":"client",
                            "message":"Enter the sign-in response"}}}
                        """.utf8)))
                case "wizard.next":
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    await nextGate.wait()
                    if outcome == "request-failed" {
                        task.emitReceiveSuccess(.data(Data(
                            #"{"type":"res","id":"\#(request.id)","ok":false,"error":{"code":"UNAVAILABLE","message":"Provider declined sign-in"}}"#
                                .utf8)))
                    } else if terminalFailure {
                        task.emitReceiveSuccess(.data(Data(
                            #"{"type":"res","id":"\#(request.id)","ok":true,"payload":{"done":true,"status":"error","error":"Provider declined sign-in"}}"#
                                .utf8)))
                    } else {
                        task.emitReceiveSuccess(.data(wizardDoneResponse(
                            id: request.id, sessionID: sessionID,
                            preparedModelRef: kind == .prepare ? "openai/gpt-5.5" : nil)))
                    }
                case "openclaw.setup.activate":
                    #expect(kind == .prepare)
                    #expect(request.params["kind"] as? String == "provider-auto:test-provider-login")
                    task.emitReceiveSuccess(.data(successfulActivationResponse(
                        id: request.id, modelRef: "openai/gpt-5.5", latencyMs: 1)))
                case "wizard.cancel":
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    cancelledSessions.withValue { $0.append(sessionID) }
                    let cancellation = cancellationRequests.claim()
                    if scenario.terminalFirst, cancellation == 0 {
                        await cancellationGate.wait()
                    }
                    let status: String? = if outcome == "failed-cancelled" ||
                        (outcome == "request-failed" && cancellation == 1)
                    {
                        "cancelled"
                    } else if ["commit-locked", "failed-unresolved", "request-failed"].contains(outcome) {
                        "running"
                    } else {
                        nil
                    }
                    let response = if let status {
                        #"{"type":"res","id":"\#(request.id)","ok":true,"payload":{"status":"\#(status)"}}"#
                    } else {
                        #"{"type":"res","id":"\#(request.id)","ok":false,"error":{"code":"INVALID_REQUEST","message":"wizard not found"}}"#
                    }
                    task.emitReceiveSuccess(.data(Data(response.utf8)))
                default:
                    Issue.record("Unexpected setup request: \(request.method)")
                }
            })
            let url = try #require(URL(string: "ws://example.invalid"))
            let gateway = makeAISetupGateway(url: url, session: session)
            let model = makeAISetupModel(gateway: gateway, defaults: defaults)
            let option = OnboardingAISetupModel.AuthOption(
                id: "test-provider-login", brandId: nil, label: "Test provider", hint: nil,
                groupLabel: nil, icon: nil, website: nil, kind: "oauth", featured: false)

            await model.detectAndAutoConnect()
            model.startProviderWizard(option, kind: kind)
            await waitForAISetupState { model.authStep != nil }
            let sessionID = try #require(model._test_authSessionID)
            model.authText = "callback-value"
            model.continueProviderAuth()
            await nextGate.waitUntilStarted()

            model.cancelProviderAuth()
            try #require(model.activeAuthOption == option)
            #expect(model._test_authSessionID == sessionID)
            #expect(model.authBusy)
            var terminalError: OnboardingAISetupModel.Failure?
            if scenario.terminalFirst {
                await cancellationGate.waitUntilStarted()
                await nextGate.release()
                await waitForAISetupState {
                    model.connected || model.authError?.copyText.contains("Provider declined sign-in") == true
                }
                terminalError = model.authError
                await cancellationGate.release()
                await Task.megaYield()
                #expect(model.authError == terminalError)
            } else {
                await waitForAISetupState { model.providerAuthCancellation != .requesting }
                #expect(model.providerAuthCancellation == .unconfirmed)
                await nextGate.release()
                await waitForAISetupState {
                    model.connected || model.authError?.copyText.contains("Provider declined sign-in") == true
                }
                terminalError = model.authError
            }

            #expect(!cancelledSessions.value.isEmpty)
            #expect(cancelledSessions.value.allSatisfy { $0 == sessionID })
            if terminalFailure {
                #expect(!model.connected)
                #expect(model.activeAuthOption == option)
                #expect(model._test_authSessionID == nil)
                #expect(model.authStep == nil)
                if outcome == "request-failed" {
                    #expect(model.authError?.copyText.contains("Provider declined sign-in") == true)
                } else {
                    #expect(model.authError?.copyText == "Provider declined sign-in")
                }
                #expect(model.providerAuthCancellation == nil)
                #expect(!model.authBusy)
                let sheet = await inspectAISetupSheet(model)
                if let terminalError {
                    #expect(sheet.labels.contains(terminalError.summary))
                    #expect(
                        sheet.actions[terminalError.detail == nil ? "Copy error" : "Show details"] == true,
                        "Named actions: \(sheet.actions)")
                }
                #expect(sheet.actions["Submit"] == nil)
                #expect(sheet.actions["Cancel"] == true)
                model.cancelProviderAuth()
                #expect(model.activeAuthOption == nil)
            } else {
                await waitForAISetupState { model.connected }
                #expect(model.connected)
                #expect(model.authError == nil)
            }
            await gateway.shutdown()
        }
    }

    @Test(
        arguments: [OnboardingAISetupModel.ProviderWizardKind.auth, .prepare],
        ["cancel", "start", "next"])
    func `retired reconciliation cannot change a replacement wizard`(
        kind: OnboardingAISetupModel.ProviderWizardKind, failureAt: String) async throws
    {
        try await withMainSerialExecutor {
            let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingRetiredAuthReconciliationTests"))
            let reconciliationGate = AISetupRequestGate()
            let detections = AISetupSocketGeneration()
            let starts = AISetupSocketGeneration()
            let startedSessions = LockIsolated<[String]>([])
            let session = makeAISetupRequestSession(handler: { task, request in
                switch request.method {
                case "openclaw.setup.detect":
                    if detections.claim() == 1 {
                        await reconciliationGate.wait()
                    }
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                case kind.startMethod:
                    let sessionID = try #require(request.params["sessionId"] as? String)
                    startedSessions.withValue { $0.append(sessionID) }
                    if starts.claim() == 0, failureAt == "start" {
                        task.emitReceiveSuccess(.data(Data(
                            #"{"type":"res","id":"\#(request.id)","ok":false,"error":{"code":"UNAVAILABLE","message":"Sign-in reply unavailable"}}"#
                                .utf8)))
                    } else {
                        task.emitReceiveSuccess(.data(Data(
                            """
                            {"type":"res","id":"\(request.id)","ok":true,"payload":{
                              "sessionId":"\(sessionID)","done":false,"status":"running",
                              "step":{"id":"login","type":"text","executor":"client",
                                "message":"Enter the sign-in response"}}}
                            """.utf8)))
                    }
                case "wizard.next":
                    task.emitReceiveSuccess(.data(Data(
                        #"{"type":"res","id":"\#(request.id)","ok":false,"error":{"code":"UNAVAILABLE","message":"Sign-in reply unavailable"}}"#
                            .utf8)))
                case "wizard.cancel":
                    task.emitReceiveSuccess(.data(Data(
                        #"{"type":"res","id":"\#(request.id)","ok":false,"error":{"code":"INVALID_REQUEST","message":"wizard not found"}}"#
                            .utf8)))
                default:
                    Issue.record("Unexpected setup request: \(request.method)")
                }
            })
            let url = try #require(URL(string: "ws://example.invalid"))
            let gateway = makeAISetupGateway(url: url, session: session)
            let model = makeAISetupModel(gateway: gateway, defaults: defaults)
            let option = OnboardingAISetupModel.AuthOption(
                id: "test-provider-login", brandId: nil, label: "Test provider", hint: nil,
                groupLabel: nil, icon: nil, website: nil, kind: "oauth", featured: false)

            await model.detectAndAutoConnect()
            model.startProviderWizard(option, kind: kind)
            let firstSessionID = try #require(model._test_authSessionID)
            if failureAt != "start" {
                await waitForAISetupState { model.authStep != nil }
                if failureAt == "cancel" {
                    model.cancelProviderAuth()
                } else {
                    model.authText = "first-response"
                    model.continueProviderAuth()
                }
            }
            await reconciliationGate.waitUntilStarted()
            model.resetForGatewayChange()
            await model.detectAndAutoConnect()
            model.startProviderWizard(option, kind: kind)
            await waitForAISetupState { model.authStep != nil }
            let replacementSessionID = try #require(model._test_authSessionID)
            #expect(replacementSessionID != firstSessionID)
            model.authText = "replacement-response"

            await reconciliationGate.release()
            await Task.megaYield()

            #expect(startedSessions.value == [firstSessionID, replacementSessionID])
            #expect(model.activeAuthOption == option)
            #expect(model._test_authSessionID == replacementSessionID)
            #expect(model.authStep?.id == "login")
            #expect(model.authText == "replacement-response")
            #expect(model.authError == nil)
            #expect(!model.authBusy)
            #expect(model.providerAuthCancellation == nil)
            #expect(!model.connected)
            await gateway.shutdown()
        }
    }

    @Test func `provider auth mismatch cancels returned server session id`() {
        #expect(OnboardingAISetupModel.providerAuthCancellationSessionID(
            requested: "requested-session",
            returned: "returned-server-session") == "returned-server-session")
        #expect(OnboardingAISetupModel.providerAuthCancellationSessionID(
            requested: "matching-session",
            returned: "matching-session") == nil)
    }

    @Test func `provider auth reconciliation only trusts its own completed flow`() {
        #expect(!OnboardingAISetupModel.canAcceptProviderAuthReconciliation(
            pending: false,
            setupComplete: true,
            configuredModel: "openai/gpt-5.5"))
        #expect(!OnboardingAISetupModel.canAcceptProviderAuthReconciliation(
            pending: true,
            setupComplete: false,
            configuredModel: "openai/gpt-5.5"))
        #expect(OnboardingAISetupModel.canAcceptProviderAuthReconciliation(
            pending: true,
            setupComplete: true,
            configuredModel: "openai/gpt-5.5"))
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
            supportsExactModel: false)
        let capable = OnboardingAISetupModel.activationParams(
            kind: "codex-cli",
            modelRef: "openai/gpt-5.5",
            supportsExactModel: true)

        #expect(legacy["kind"]?.value as? String == "codex-cli")
        #expect(legacy["modelRef"] == nil)
        #expect(capable["kind"]?.value as? String == "codex-cli")
        #expect(capable["modelRef"]?.value as? String == "openai/gpt-5.5")

        let local = OnboardingAISetupModel.activationParams(
            kind: "provider-auto:lmstudio",
            modelRef: "lmstudio/qwen-local",
            supportsExactModel: true)
        #expect(local["kind"]?.value as? String == "provider-auto:lmstudio")
        #expect(local["modelRef"]?.value as? String == "lmstudio/qwen-local")
    }

    @Test func `unavailable detected integrations decode for informational display`() throws {
        let candidates = try JSONDecoder().decode(
            [OnboardingAISetupModel.UnavailableCandidate].self,
            from: Data(
                #"[{"id":"pi-cli","label":"Pi CLI","detail":"installed","reason":"Not a setup route."},{"id":"opencode-cli","label":"OpenCode CLI","detail":"installed","reason":"Not a setup route."}]"#
                    .utf8))

        #expect(candidates.map(\.id) == ["pi-cli", "opencode-cli"])
        #expect(candidates.map(\.label) == ["Pi CLI", "OpenCode CLI"])
        #expect(candidates.allSatisfy { $0.detail == "installed" })
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
            """#.utf8)
        let hello = try JSONDecoder().decode(HelloOk.self, from: data)

        #expect(hello.supportsServerCapability(.systemAgentSetupModelRef))
    }

    @Test func `only definitive failures can clear an activation marker`() {
        let unknownMethod = GatewayResponseError(
            method: "openclaw.setup.activate",
            code: "UNKNOWN_METHOD",
            message: "unknown method",
            details: nil)
        let invalidParams = GatewayResponseError(
            method: "openclaw.setup.activate",
            code: "INVALID_REQUEST",
            message: "invalid openclaw.setup.activate params: kind is required",
            details: nil)
        let indeterminate = GatewayResponseError(
            method: "openclaw.setup.activate",
            code: "UNAVAILABLE",
            message: "Setup inference activation is indeterminate",
            details: nil)
        let genericInvalidRequest = GatewayResponseError(
            method: "openclaw.setup.activate",
            code: "INVALID_REQUEST",
            message: "activation failed after dispatch",
            details: nil)
        let timeout = NSError(
            domain: "Gateway",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "gateway request timed out"])
        let decodeError = DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "invalid activation response"))

        #expect(OnboardingAISetupModel.activationFailureIsDefinitive(unknownMethod))
        #expect(OnboardingAISetupModel.activationFailureIsDefinitive(invalidParams))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(indeterminate))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(genericInvalidRequest))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(decodeError))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(timeout))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(CancellationError()))
    }

    @Test func `successful activation hands off and completion clears its owned receipt`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingCompletedActivationTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url, preparationKind: "claude-cli") { _, request, _ in
            request.method == "openclaw.setup.activate" ? verifiedSetupResponse(id: request.id) : nil
        }
        let model = harness.model(defaults: defaults)
        var handedOff = false
        model.onConnected = { handedOff = true }

        await model.detectAndAutoConnect()
        await model.activate(kind: "claude-cli")

        #expect(model.connected)
        #expect(handedOff)
        #expect(pendingState(defaults) == .completed)

        model.clearCompletedHandoffIfOwned()

        #expect(pendingState(defaults) == .none)
    }

    @Test func `adopts pending activation stored under the retired crestodian key`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingRetiredKeyMigrationTests"))

        _ = markPending(defaults)
        let payload = try #require(defaults.object(forKey: onboardingSystemAgentPendingKey))
        defaults.removeObject(forKey: onboardingSystemAgentPendingKey)
        defaults.set(payload, forKey: onboardingSystemAgentPendingRetiredKey)

        guard case .activating = pendingState(defaults)
        else {
            Issue.record("expected the retired-key activation lease to survive the rename")
            return
        }
        #expect(defaults.object(forKey: onboardingSystemAgentPendingKey) != nil)
        #expect(defaults.object(forKey: onboardingSystemAgentPendingRetiredKey) == nil)
    }

    @Test func `managed Gateway restart reconciles exact persisted activation before handoff`() async throws {
        let suiteName = "OnboardingManagedRestartReconciliationTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
        let recorder = AISetupRequestRecorder()
        let ownerObservation = ActivationOwnerObservation()
        let replacementGate = AISetupRequestGate()
        let session = makeRestartingAISetupSession(
            suiteName: suiteName,
            recorder: recorder,
            ownerObservation: ownerObservation,
            postRestartConfiguredModel: "openai/gpt-5.5",
            replacementGate: replacementGate)
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = makeAISetupGateway(url: url, token: "route-token", session: session)
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        var handoffs: [OnboardingDashboardHandoff] = []
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" },
            dashboardHandoffOpener: { handoffs.append($0) })

        await view.aiSetup.detectAndAutoConnect()
        let activation = Task { await view.aiSetup.activate(kind: "codex-cli") }
        await replacementGate.waitUntilStarted()
        guard case .activating = pendingState(defaults) else {
            Issue.record("expected restart-required activation to remain pending")
            return
        }
        await replacementGate.release()
        await activation.value

        let activationOwner = try #require(ownerObservation.value())
        #expect(session.snapshotMakeCount() >= 2)
        #expect(await (recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
            "openclaw.setup.detect",
            "openclaw.setup.verify",
        ])
        #expect(view.aiSetup.connected)
        #expect(view.aiSetup.selectedKind == "codex-cli")
        #expect(storedActivationOwner(defaults) == activationOwner)
        #expect(pendingState(defaults) == .completed)
        #expect(view.finish())
        #expect(handoffs == [.custodianOnboarding])
    }

    @Test func `managed Gateway restart rejects mismatched persisted transition`() async throws {
        let suiteName = "OnboardingManagedRestartMismatchTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
        let recorder = AISetupRequestRecorder()
        let ownerObservation = ActivationOwnerObservation()
        let session = makeRestartingAISetupSession(
            suiteName: suiteName,
            recorder: recorder,
            ownerObservation: ownerObservation,
            postRestartConfiguredModel: "anthropic/other-model")
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = makeAISetupGateway(url: url, token: "route-token", session: session)
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
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
        #expect(isOwned(by: activationOwner, defaults: defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
    }

    @Test func `completion cannot clear a replacement activation owner`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingCompletionReplacementOwnerTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url, preparationKind: "claude-cli") { _, request, _ in
            request.method == "openclaw.setup.activate" ? verifiedSetupResponse(id: request.id) : nil
        }
        let model = harness.model(defaults: defaults)

        await model.detectAndAutoConnect()
        await model.activate(kind: "claude-cli")
        let completedOwner = try #require(storedActivationOwner(defaults))
        let replacementOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "replacement-activation",
            routeFingerprint: completedOwner.routeFingerprint)
        markPending(defaults, for: "local", owner: replacementOwner)

        model.clearCompletedHandoffIfOwned()

        #expect(isOwned(by: replacementOwner, defaults: defaults))
        guard case .activating = pendingState(defaults)
        else {
            Issue.record("expected replacement activation to retain its lease")
            return
        }
    }

    @Test func `successful response cannot complete a replaced same route activation`() async throws {
        let suiteName = "OnboardingReplacedActivationOwnerTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
        let replacementID = "replacement-activation"
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url, preparationKind: "claude-cli") { _, request, _ in
            guard request.method == "openclaw.setup.activate",
                  let callbackDefaults = UserDefaults(suiteName: suiteName),
                  let originalOwner = OnboardingSystemAgentResumeStore.activationOwner(
                      for: "local",
                      defaults: callbackDefaults)
            else { return nil }
            OnboardingSystemAgentResumeStore.markPending(
                routeIdentity: "local",
                activationOwner: .init(
                    id: replacementID,
                    routeFingerprint: originalOwner.routeFingerprint),
                defaults: callbackDefaults)
            return verifiedSetupResponse(id: request.id)
        }
        let model = harness.model(defaults: defaults)
        var handoffCount = 0
        model.onConnected = { handoffCount += 1 }

        await model.detectAndAutoConnect()
        await model.activate(kind: "claude-cli")

        #expect(!model.connected)
        #expect(handoffCount == 0)
        #expect(model.phase == .ready)
        #expect(storedActivationOwner(defaults)?.id == replacementID)
        guard case .activating = pendingState(defaults)
        else {
            Issue.record("expected replacement activation to retain its lease")
            return
        }
    }

    @Test func `reset during final route validation rejects stale activation handoff`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingFinalRouteValidationResetTests"))
        let configGate = AISetupConfigReadGate()
        let session = makeAISetupRequestSession(preparationKind: "codex-cli") { task, request in
            guard request.method == "openclaw.setup.activate" else { return }
            await configGate.armNextRead()
            task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
        }
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await configGate.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
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
        #expect(isPending(defaults, for: "local"))
    }

    @Test func `gateway change clears route-bound setup state`() {
        let model = OnboardingAISetupModel()
        model.manualProviderID = "openai"
        model.manualKey = "temporary-key"
        model.showManualEntry = true

        model.resetForGatewayChange()

        #expect(model.phase == .idle)
        #expect(model.manualProviderID.isEmpty)
        #expect(model.manualKey.isEmpty)
        #expect(!model.showManualEntry)
    }

    @Test func `configured model label stays pending until live verification`() async throws {
        // Isolated defaults + fixed route: the default init reads the machine's
        // real resume store, whose leftover activation leases fail this test on
        // any Mac that completed onboarding.
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingConfiguredLabelTests"))
        let model = OnboardingAISetupModel(
            defaults: defaults,
            routeIdentityProvider: { "local" })

        model.resumeConfiguredInference(modelRef: " openai/gpt-5.5 ")

        #expect(!model.connected)
        #expect(model.pendingActivationVerification)
        #expect(model.phase == .detecting)
        #expect(OnboardingController.shared.busyReason == "OpenClaw is testing your AI connection.")

        await model.activate(kind: "codex-cli")
        #expect(model.pendingActivationVerification)
        #expect(!model.connected)

        model.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")

        #expect(model.connected)
        #expect(!model.pendingActivationVerification)
        #expect(model.selectedKind == "existing-model")
        #expect(OnboardingController.shared.busyReason == nil)
    }

    @Test func `implicit model label falls through verification to automatic setup`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingImplicitModelTests"))
        let recorder = AISetupRequestRecorder()
        let session = makeAISetupRequestSession(recorder: recorder) { task, request in
            let response: Data? = switch request.method {
            case "agents.list": configuredModelResponse(id: request.id)
            case "openclaw.setup.verify": unconfiguredSetupVerificationResponse(id: request.id)
            case "openclaw.setup.detect": actionableDetectedSetupResponse(id: request.id)
            case "openclaw.setup.activate": successfulActivationResponse(
                    id: request.id,
                    modelRef: "claude-cli/claude-opus-4-8",
                    latencyMs: 42)
            default: nil
            }
            if let response {
                task.emitReceiveSuccess(.data(response))
            }
        }
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = makeAISetupGateway(url: url, session: session)
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        var handoffs: [OnboardingDashboardHandoff] = []
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" },
            dashboardHandoffOpener: { handoffs.append($0) })
        view.onboardingVisible = true
        view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

        let probe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true))
        await probe.value
        for _ in 0..<200 {
            if view.aiSetup.connected {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(view.aiSetup.connected)
        #expect(view.aiSetup.selectedKind == "claude-cli")
        #expect(view.finishState.didFinish)
        // Fresh activation hands off to the custodian first-run flow.
        #expect(handoffs == [.custodianOnboarding])
        #expect(await (recorder.snapshot()).methods == [
            "agents.list",
            "openclaw.setup.verify",
            "openclaw.setup.detect",
            "openclaw.setup.activate",
        ])
    }

    @Test func `pending handoff connects only after route-bound live verification`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            request.method == "openclaw.setup.verify" ? verifiedSetupResponse(id: request.id) : nil
        }
        let model = harness.model()

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        await model.verifyPendingConfiguredInference()

        let requests = await harness.recorder.snapshot()
        #expect(requests.methods == ["openclaw.setup.verify"])
        #expect(model.connected)
        #expect(model.selectedKind == "existing-model")
    }

    @Test func `overlapping pending verification callers share one route-bound request`() async throws {
        let gate = AISetupRequestGate()
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            guard request.method == "openclaw.setup.verify" else { return nil }
            await gate.wait()
            return verifiedSetupResponse(id: request.id)
        }
        let model = harness.model()
        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")

        let first = Task { await model.verifyPendingConfiguredInference() }
        await gate.waitUntilStarted()
        let second = Task { await model.verifyPendingConfiguredInference() }
        await Task.yield()

        #expect(await (harness.recorder.snapshot()).methods == ["openclaw.setup.verify"])
        await gate.release()
        #expect(await first.value == .connected)
        #expect(await second.value == .connected)
        #expect(await (harness.recorder.snapshot()).methods == ["openclaw.setup.verify"])
    }

    @Test func `pending verification revalidates route after shared task completes`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingPendingRouteRevalidationTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let harness = AISetupHarness(url: url) { _, request, _ in
            request.method == "openclaw.setup.verify" ? verifiedSetupResponse(id: request.id) : nil
        }
        let model = harness.model(defaults: defaults, routeIdentityProvider: { routeIdentity.snapshot() })
        model.onConnected = { routeIdentity.set("remote:id:gateway-b") }

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()

        #expect(outcome == .superseded)
    }

    @Test func `disappearing onboarding invalidates detection before activation`() async throws {
        let gate = AISetupRequestGate()
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "openclaw.setup.detect":
                await gate.wait()
                return actionableDetectedSetupResponse(id: request.id)
            case "openclaw.setup.activate": return failedActivationResponse(id: request.id)
            default: return nil
            }
        }
        let appState = AppState(preview: true)
        appState.connectionMode = .remote
        appState.remoteTransport = .direct
        appState.remoteUrl = "ws://example.invalid"
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: harness.gateway,
            aiSetupRouteIdentityProvider: { "remote:direct:example.invalid" })
        view.onboardingVisible = true

        view.aiSetup.startIfNeeded()
        await gate.waitUntilStarted()
        view.onboardingDidDisappear()
        await gate.release()
        await settleQueuedAISetupTasks()

        #expect(await (harness.recorder.snapshot()).methods == ["openclaw.setup.detect"])
        #expect(view.aiSetup.phase == .idle)
    }

    @Test func `failed pending verification keeps activation lease before deadline`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingPendingVerificationFailureTests"))
        markPending(defaults)
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            request.method == "openclaw.setup.verify" ? rejectedSetupVerificationResponse(id: request.id) : nil
        }
        let model = harness.model(defaults: defaults)

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        #expect(OnboardingController.shared.busyReason == "OpenClaw is testing your AI connection.")
        let outcome = await model.verifyPendingConfiguredInference()

        #expect(!model.connected)
        #expect(model.pendingActivationVerification)
        #expect(model.phase == .ready)
        #expect(OnboardingController.shared.busyReason == nil)
        #expect(model.detectError?.detail == "expired login")
        #expect(outcome == .notConnected)
        #expect(isPending(defaults))

        model.retryFromScratch()

        #expect(model.phase == .detecting)
        #expect(model.detectError == nil)
        #expect(OnboardingController.shared.busyReason == "OpenClaw is testing your AI connection.")

        await settleQueuedAISetupTasks()

        #expect(model.phase == .ready)
        #expect(model.detectError?.detail == "expired login")
        #expect(OnboardingController.shared.busyReason == nil)
        #expect(await (harness.recorder.snapshot()).methods == ["openclaw.setup.verify", "openclaw.setup.verify"])
    }

    @Test func `completed activation receipt survives verification transport failure`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingCompletedVerificationRetryTests"))
        let recorder = AISetupRequestRecorder()
        let session = makeAISetupRequestSession(recorder: recorder) { task, request in
            guard request.method == "openclaw.setup.verify" else { return }
            let verifyCount = await recorder.snapshot().methods.count
            let response = verifyCount == 1
                ? unavailableGatewayResponse(id: request.id)
                : verifiedSetupResponse(id: request.id)
            task.emitReceiveSuccess(.data(response))
        }
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: "completed-route", password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let route = try #require(await gateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "completed-before-verification",
            routeFingerprint: #require(route.activationOwnershipFingerprint))
        markPending(defaults, for: "local", owner: activationOwner)
        #expect(markCompleted(defaults, owner: activationOwner))
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")

        let failedOutcome = await model.verifyPendingConfiguredInference()

        #expect(failedOutcome == .notConnected)
        #expect(model.pendingActivationVerification)
        #expect(!model.connected)
        #expect(pendingState(defaults) == .completed)

        model.retryFromScratch()

        #expect(model.phase == .detecting)
        #expect(model.detectError == nil)
        #expect(OnboardingController.shared.busyReason == "OpenClaw is testing your AI connection.")

        let requests = await waitForAISetupRequests(recorder, count: 2)
        await settleQueuedAISetupTasks()

        #expect(model.connected)
        #expect(OnboardingController.shared.busyReason == nil)
        #expect(requests.methods == ["openclaw.setup.verify", "openclaw.setup.verify"])
    }

    @Test func `pending OpenClaw marker is app local and clearable`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingSystemAgentResumeStoreTests"))

        #expect(!isPending(defaults))
        markPending(defaults)
        #expect(isPending(defaults))
        OnboardingSystemAgentResumeStore.clear(defaults: defaults)
        #expect(!isPending(defaults))
    }

    @Test func `persisted route owner ignores tunnel URL but changes with Gateway auth`() async throws {
        let firstURL = try #require(URL(string: "ws://127.0.0.1:49152"))
        let reboundURL = try #require(URL(string: "ws://127.0.0.1:53241"))
        let first = GatewayConnection(
            configProvider: { (url: firstURL, token: "route-token", password: "route-password") },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            })))
        let rebound = GatewayConnection(
            configProvider: { (url: reboundURL, token: "route-token", password: "route-password") },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            })))
        let changedPassword = GatewayConnection(
            configProvider: { (url: reboundURL, token: "route-token", password: "replacement-password") },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            })))
        let changedToken = GatewayConnection(
            configProvider: { (url: reboundURL, token: "replacement-token", password: "route-password") },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            })))
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
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingUnsafeOwnerMigrationTests"))
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

        #expect(pendingState(defaults) == .none)
        #expect(defaults.object(forKey: onboardingSystemAgentPendingKey) == nil)
    }

    @Test func `ownerless v2 completion record is scrubbed`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingOwnerlessReceiptMigrationTests"))
        defaults.set([
            "version": 2,
            "records": ["local": ["phase": "completed"]],
        ], forKey: onboardingSystemAgentPendingKey)

        #expect(pendingState(defaults) == .none)
        #expect(defaults.object(forKey: onboardingSystemAgentPendingKey) == nil)
    }

    @Test func `unbound activation leases stay attempt-specific`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingUnboundLeaseTests"))
        let attemptA = OnboardingSystemAgentResumeStore.ActivationOwner.unbound()
        let attemptB = OnboardingSystemAgentResumeStore.ActivationOwner.unbound()
        _ = markPending(defaults, for: "local", owner: attemptB)

        // A stale keychain-unavailable attempt must not complete or clear a
        // newer attempt's record: candidate and manual-key flows both key the
        // store by this per-attempt lease.
        #expect(!markCompleted(defaults, for: "local", owner: attemptA))
        #expect(!OnboardingSystemAgentResumeStore.clear(
            ifOwnedBy: "local",
            activationOwner: attemptA,
            defaults: defaults))
        #expect(markCompleted(defaults, for: "local", owner: attemptB))
    }

    @Test func `unbound completed receipt never authorizes a relaunch handoff`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingUnboundReceiptGuardTests"))
        let attempt = OnboardingSystemAgentResumeStore.ActivationOwner.unbound()
        _ = markPending(defaults, for: "local", owner: attempt)
        #expect(markCompleted(defaults, for: "local", owner: attempt))

        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            request.method == "openclaw.setup.verify"
                ? verifiedSetupResponse(id: request.id)
                : unavailableGatewayResponse(id: request.id)
        }
        let model = harness.model(defaults: defaults)

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()

        // The unbound receipt is refused before any handoff; setup restarts.
        #expect(outcome == .freshSetupAllowed)
        #expect(!model.connected)
        #expect(pendingState(defaults) == .none)
    }

    @Test func `ownerless completed receipt never authorizes a relaunch handoff`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingOwnerlessReceiptGuardTests"))
        // The durable state a keychain-unavailable activation leaves behind when
        // its response raced a lease change: an ownerless completed record.
        _ = markPending(defaults, for: "local")
        #expect(markCompleted(defaults, for: "local"))

        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            request.method == "openclaw.setup.verify"
                ? verifiedSetupResponse(id: request.id)
                : unavailableGatewayResponse(id: request.id)
        }
        let model = harness.model(defaults: defaults)

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()

        // Live inference succeeded, but an unbound receipt can belong to
        // replaced credentials; setup must repeat a fresh activation instead.
        #expect(outcome == .freshSetupAllowed)
        #expect(!model.connected)
        #expect(pendingState(defaults) == .none)
    }

    @Test func `activation proceeds ownerless when Keychain binding is unavailable`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingMissingKeychainBindingTests"))
        let recorder = AISetupRequestRecorder()
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: "route-token", password: nil) },
            activationBindingKeyProvider: { nil },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(
                recorder: recorder,
                detectedKind: "codex-cli")))
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)

        // The explicit activation must dispatch to the Gateway instead of
        // dead-ending on the missing Keychain binding.
        await model.detectAndAutoConnect()
        await model.activate(kind: "codex-cli")

        let methods = await recorder.snapshot().methods
        #expect(methods == ["openclaw.setup.detect", "openclaw.setup.activate"])
        // The ownerless record must not outlive the cleanly failed activation.
        #expect(!isPending(defaults))
        #expect(model.phase == .ready)
        guard case let .failed(failure) = model.statuses["codex-cli"] else {
            Issue.record("expected activation failure from the Gateway response")
            return
        }
        #expect(failure.detail?.contains("Secure storage") != true)
    }

    @Test func `active v3 record keeps its deadline while credential verifier is scrubbed`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingActiveUnsafeOwnerMigrationTests"))
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
            now: now) == .activating(deadline: deadline))
        let migrated = try #require(
            defaults.dictionary(forKey: onboardingSystemAgentPendingKey))
        let records = try #require(migrated["records"] as? [String: Any])
        let local = try #require(records["local"] as? [String: Any])
        #expect(migrated["version"] as? Int == 4)
        #expect(local["activationId"] == nil)
        #expect(local["routeFingerprint"] == nil)
    }

    @Test func `legacy marker relaunch migrates to a full conservative lease`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingLegacySystemAgentResumeStoreTests"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        defaults.set("local", forKey: onboardingSystemAgentPendingKey)

        let migrated = OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now)
        let deadline: Date? = if case let .activating(deadline) = migrated {
            deadline
        } else {
            nil
        }
        let leaseDeadline = try #require(deadline)

        #expect(leaseDeadline == now.addingTimeInterval(
            OnboardingSystemAgentResumeStore.legacyActivationLeaseSeconds))
        #expect(defaults.object(forKey: onboardingSystemAgentPendingKey) is [String: Any])
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now.addingTimeInterval(484)) == .activating(deadline: leaseDeadline))
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now.addingTimeInterval(486)) == .activationExpired)
    }

    @Test func `missing model cannot start a second activation before pending deadline`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingPendingDeadlineBlockTests"))
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let routeIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity(state: appState)
        markPending(defaults, for: routeIdentity, timeoutMs: 30000)
        let harness = AISetupHarness(url: url) { _, request, _ in
            request.method == "agents.list" ? missingConfiguredModelResponse(id: request.id) : nil
        }
        let view = harness.view(state: appState, defaults: defaults, routeIdentityProvider: { routeIdentity })

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        await settleQueuedAISetupTasks()

        #expect(await (harness.recorder.snapshot()).methods == ["agents.list"])
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect(isPending(defaults, for: routeIdentity))
        view.onboardingDidDisappear()
    }

    @Test func `expired pending activation safely permits a fresh activation`() async throws {
        let suiteName = "OnboardingExpiredPendingActivationTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let routeIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity(state: appState)
        let activationOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "expired-owner",
            routeFingerprint: "selected-route")
        markPending(
            defaults,
            for: routeIdentity,
            owner: activationOwner,
            timeoutMs: 0,
            now: Date(timeIntervalSinceNow: -10))
        let markerObservation = ActivationMarkerObservation()
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "agents.list":
                return missingConfiguredModelResponse(id: request.id)
            case "openclaw.setup.detect":
                if let callbackDefaults = UserDefaults(suiteName: suiteName) {
                    await markerObservation.record(!OnboardingSystemAgentResumeStore.isPending(
                        for: routeIdentity,
                        defaults: callbackDefaults))
                }
                return actionableDetectedSetupResponse(id: request.id)
            case "openclaw.setup.activate":
                return failedActivationResponse(id: request.id)
            default:
                return nil
            }
        }
        let view = harness.view(state: appState, defaults: defaults, routeIdentityProvider: { routeIdentity })

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        let requests = await waitForAISetupRequests(harness.recorder, count: 3)

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
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
        let routeIdentity = "local"
        let originalOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "expired-owner-a",
            routeFingerprint: "selected-route")
        let replacementOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "expired-owner-b",
            routeFingerprint: "selected-route")
        markPending(
            defaults,
            for: routeIdentity,
            owner: originalOwner,
            timeoutMs: 0,
            now: Date(timeIntervalSinceNow: -10))
        let url = try #require(URL(string: "ws://localhost:18789"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "agents.list":
                if let callbackDefaults = UserDefaults(suiteName: suiteName) {
                    markPending(
                        callbackDefaults,
                        for: routeIdentity,
                        owner: replacementOwner,
                        timeoutMs: 0,
                        now: Date(timeIntervalSinceNow: -10))
                }
                return missingConfiguredModelResponse(id: request.id)
            case "openclaw.setup.detect": return detectedSetupResponse(id: request.id)
            default: return nil
            }
        }
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = harness.view(state: appState, defaults: defaults, routeIdentityProvider: { routeIdentity })

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        await settleQueuedAISetupTasks()

        #expect(await (harness.recorder.snapshot()).methods == ["agents.list"])
        #expect(isOwned(by: replacementOwner, defaults: defaults, for: routeIdentity))
        #expect(pendingState(defaults, for: routeIdentity) == .activationExpired)
        #expect(view.aiSetup.phase == .idle)
        view.onboardingDidDisappear()
    }

    @Test func `stale missing probe cannot reset inference connected while suspended`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingStaleMissingConnectedTests"))
        markPending(defaults, for: "local")
        markCompleted(defaults, for: "local")
        let gate = AISetupRequestGate()
        let url = try #require(URL(string: "ws://localhost:18789"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "agents.list":
                await gate.wait()
                return missingConfiguredModelResponse(id: request.id)
            case "openclaw.setup.detect": return detectedSetupResponse(id: request.id)
            default: return nil
            }
        }
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = harness.view(state: appState, defaults: defaults, routeIdentityProvider: { "local" })

        let staleProbe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true))
        await gate.waitUntilStarted()
        view.aiSetup.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        view.aiSetup.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")
        #expect(view.aiSetup.connected)
        await gate.release()
        await staleProbe.value
        await settleQueuedAISetupTasks()

        #expect(view.aiSetup.connected)
        #expect(pendingState(defaults) == .completed)
        #expect(await (harness.recorder.snapshot()).methods == ["agents.list"])
    }

    @Test func `unavailable configured gateway timeout does not start inference setup`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingUnavailableGatewayTimeoutTests"))
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                guard sendIndex > 0 else { return }
                await recorder.record(message)
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = makeAISetupGateway(url: url, session: session)
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" },
            configuredGatewayProbeTimeoutMs: 1)
        view.onboardingVisible = true
        view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

        let probe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true))
        await probe.value
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["agents.list"])
        #expect(view.aiSetup.phase == .ready)
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(view.aiSetup.detectError != nil)
        #expect(!isPending(defaults))
    }

    @Test func `remote configured gateway auth routes back without AI detection`() async throws {
        let url = try #require(URL(string: "wss://gateway.example.test"))
        let harness = AISetupHarness(url: url, receiveHook: { task, receiveIndex in
            if receiveIndex == 0 {
                return .data(GatewayWebSocketTestSupport.connectChallengeData())
            }
            return .data(GatewayWebSocketTestSupport.connectAuthFailureData(
                id: task.snapshotConnectRequestID() ?? "connect",
                detailCode: GatewayConnectAuthDetailCode.authTokenMissing.rawValue))
        })
        let appState = AppState(preview: true)
        appState.connectionMode = .remote
        appState.remoteTransport = .direct
        appState.remoteUrl = url.absoluteString
        let view = harness.view(
            state: appState,
            routeIdentityProvider: { "remote:direct:gateway" },
            gatewaySelectionPersister: { true })
        view.onboardingVisible = true
        view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

        let probe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true))
        await probe.value
        await settleQueuedAISetupTasks()

        #expect(view.aiSetup.configuredGatewayAuthIssue == .tokenRequired)
        #expect(!view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(view.aiSetup.detectError == nil)
        #expect(view.aiSetup.candidates.isEmpty)
        #expect(harness.session.latestTask()?.snapshotSendCount() == 1)
        let card = OnboardingAISetupView.gatewayAuthCard(for: .tokenRequired)
        #expect(card.title == "Gateway authentication required")
        #expect(card.primaryTitle == "Back to Gateway")
        #expect(card.secondaryTitle == "Try again")
        #expect(!card.title.localizedCaseInsensitiveContains("AI account"))

        let decision = try #require(OnboardingView.gatewayAuthenticationReturnDecision(
            connectionMode: appState.connectionMode,
            authIssue: view.aiSetup.configuredGatewayAuthIssue,
            pageOrder: view.pageOrder,
            connectionPageIndex: view.connectionPageIndex,
            probeInput: view.remoteGatewayProbeInput))
        #expect(decision.connectionPage == view.pageOrder.firstIndex(of: view.connectionPageIndex))
        #expect(decision.authIssue == .tokenRequired)
        #expect(decision.probeState == .failed(
            view.remoteGatewayProbeInput,
            RemoteGatewayAuthIssue.tokenRequired.statusMessage))
        #expect(decision.showRemoteChoices)
        #expect(decision.showAdvancedConnection)
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: decision.showAdvancedConnection,
            remoteToken: appState.remoteToken,
            remoteTokenUnsupported: appState.remoteTokenUnsupported,
            authIssue: decision.authIssue))
    }

    @Test func `remote AI detection auth blocks without candidate fallthrough`() async throws {
        let url = try #require(URL(string: "wss://gateway.example.test"))
        let harness = AISetupHarness(url: url, receiveHook: { task, receiveIndex in
            if receiveIndex == 0 {
                return .data(GatewayWebSocketTestSupport.connectChallengeData())
            }
            return .data(GatewayWebSocketTestSupport.connectAuthFailureData(
                id: task.snapshotConnectRequestID() ?? "connect",
                detailCode: GatewayConnectAuthDetailCode.pairingRequired.rawValue))
        })
        let model = harness.model(
            routeIdentityProvider: { "remote:direct:gateway" },
            connectionModeProvider: { .remote })

        await model.detectAndAutoConnect()

        #expect(model.configuredGatewayAuthIssue == .pairingRequired)
        #expect(!model.configuredGatewayProbeUnavailable)
        #expect(model.detectError == nil)
        #expect(model.candidates.isEmpty)
        #expect(!model.showManualEntry)
        #expect(harness.session.latestTask()?.snapshotSendCount() == 1)
    }

    @Test(arguments: [false, true])
    func `configured gateway probe refuses an unpersisted endpoint selection`(remote: Bool) async throws {
        let url = try #require(URL(string: "ws://localhost:18789"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "agents.list": missingConfiguredModelResponse(id: request.id)
            case "openclaw.setup.detect": detectedSetupResponse(id: request.id)
            default: nil
            }
        }
        let appState = AppState(preview: true)
        appState.connectionMode = remote ? .remote : .local
        if remote {
            appState.remoteTransport = .direct
            appState.remoteUrl = "wss://replacement.example.test"
        }
        var persistAttempts = 0
        let view = makeAISetupView(
            state: appState,
            gateway: harness.gateway,
            routeIdentityProvider: { remote ? "remote:direct:replacement.example.test" : "local" },
            gatewaySelectionPersister: {
                persistAttempts += 1
                return persistAttempts > 2
            })
        view.onboardingVisible = true

        let probe = view.probeConfiguredGatewayForDashboard(knownVisible: true)
        await settleQueuedAISetupTasks()

        #expect(probe == nil)
        #expect(persistAttempts == 1)
        #expect(harness.session.snapshotMakeCount() == 0)
        #expect(!view.aiSetup.connected)
        #expect(view.aiSetup.phase == .ready)
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(view.aiSetup.detectError?.summary ==
            "Could not save Gateway settings. Check your connection settings and try again.")

        #expect(view.retryConfiguredGatewayProbe() == nil)
        #expect(persistAttempts == 2)
        #expect(harness.session.snapshotMakeCount() == 0)
        #expect(view.aiSetup.phase == .ready)
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)

        let retry = try #require(view.retryConfiguredGatewayProbe())
        await retry.value
        let requests = await waitForAISetupRequests(harness.recorder, count: 2)
        await settleQueuedAISetupTasks()

        #expect(persistAttempts == 3)
        #expect(requests.methods == ["agents.list", "openclaw.setup.detect"])
        #expect(view.aiSetup.phase == .ready)
        #expect(!view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(!view.aiSetup.candidates.isEmpty)
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
            let defaults =
                try #require(isolatedAISetupDefaults(prefix: "OnboardingUnavailableGatewayMarkerTests-\(markerPhase)"))
            markPending(
                defaults,
                for: "local",
                timeoutMs: markerPhase == "expired" ? 0 : 30000,
                now: markerPhase == "expired" ? Date(timeIntervalSinceNow: -10) : Date())
            if markerPhase == "completed" {
                markCompleted(defaults, for: "local")
            }
            let url = try #require(URL(string: "ws://localhost:18789"))
            let harness = AISetupHarness(url: url) { _, request, _ in unavailableGatewayResponse(id: request.id) }
            let appState = AppState(preview: true)
            appState.connectionMode = .local
            let view = harness.view(state: appState, defaults: defaults, routeIdentityProvider: { "local" })
            view.onboardingVisible = true
            view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

            let probe = try #require(view.probeConfiguredGatewayForDashboard(
                startAISetupWhenMissing: true,
                knownVisible: true))
            await probe.value
            await settleQueuedAISetupTasks()

            #expect(await (harness.recorder.snapshot()).methods == ["agents.list"])
            #expect(view.aiSetup.phase == .ready)
            #expect(view.aiSetup.configuredGatewayProbeUnavailable)
            let markerState = pendingState(defaults)
            if markerPhase == "expired" {
                #expect(markerState == .activationExpired)
            } else {
                #expect(markerState == .completed)
            }

            let retry = try #require(view.retryConfiguredGatewayProbe())
            await retry.value
            let retried = await harness.recorder.snapshot()
            await settleQueuedAISetupTasks()

            #expect(retried.methods == ["agents.list", "agents.list"])
            #expect(view.aiSetup.phase == .ready)
            #expect(view.aiSetup.configuredGatewayProbeUnavailable)
            #expect(pendingState(defaults) == markerState)
        }
    }

    @Test func `unavailable probe resets stale ready setup before successful missing retry`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingUnavailableReadyRetryTests"))
        let url = try #require(URL(string: "ws://localhost:18789"))
        let harness = AISetupHarness(url: url) { _, request, recorder in
            switch request.method {
            case "openclaw.setup.detect":
                return detectedSetupResponse(id: request.id)
            case "agents.list":
                let probeCount = await recorder.snapshot().methods.filter { $0 == "agents.list" }.count
                return probeCount == 1
                    ? unavailableGatewayResponse(id: request.id)
                    : missingConfiguredModelResponse(id: request.id)
            default:
                return nil
            }
        }
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = harness.view(state: appState, defaults: defaults, routeIdentityProvider: { "local" })
        view.onboardingVisible = true
        view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

        await view.aiSetup.detectAndAutoConnect()
        #expect(view.aiSetup.phase == .ready)
        #expect(!view.aiSetup.candidates.isEmpty)

        let unavailableProbe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true))
        await unavailableProbe.value
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(view.aiSetup.candidates.isEmpty)

        let retry = try #require(view.retryConfiguredGatewayProbe())
        await retry.value
        let requests = await waitForAISetupRequests(harness.recorder, count: 4)
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
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingUnavailableActiveLeaseRetryTests"))
        markPending(defaults, for: "local", timeoutMs: 30000)
        let url = try #require(URL(string: "ws://localhost:18789"))
        let harness = AISetupHarness(url: url) { _, request, recorder in
            let probeCount = await recorder.snapshot().methods.filter { $0 == "agents.list" }.count
            return probeCount == 1
                ? unavailableGatewayResponse(id: request.id)
                : missingConfiguredModelResponse(id: request.id)
        }
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = harness.view(state: appState, defaults: defaults, routeIdentityProvider: { "local" })

        let unavailableProbe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true))
        await unavailableProbe.value
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)

        let retry = try #require(view.retryConfiguredGatewayProbe())
        await retry.value
        await settleQueuedAISetupTasks()

        #expect(await (harness.recorder.snapshot()).methods == ["agents.list", "agents.list"])
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect(isPending(defaults))
    }

    @Test func `verified configured model stays read only until pending deadline`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingPendingConfiguredVerificationTests"))
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        markPending(defaults, for: "local", timeoutMs: 30000)
        let harness = AISetupHarness(url: url) { _, request, recorder in
            switch request.method {
            case "agents.list":
                let agentsListCount = await recorder.snapshot().methods.filter {
                    $0 == "agents.list"
                }.count
                return agentsListCount == 1
                    ? missingConfiguredModelResponse(id: request.id)
                    : configuredModelResponse(id: request.id)
            case "openclaw.setup.verify":
                return verifiedSetupResponse(id: request.id)
            default:
                return nil
            }
        }
        let view = harness.view(state: appState, defaults: defaults, routeIdentityProvider: { "local" })

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        let configuredProbe = try #require(
            view.probeConfiguredGatewayForDashboard(knownVisible: true))
        await configuredProbe.value
        for _ in 0..<200 {
            if case .verified = pendingState(defaults) {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        let methods = await harness.recorder.snapshot().methods
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
            if case .verified = pendingState(defaults) {
                return true
            }
            return false
        }())
        view.onboardingDidDisappear()
    }

    @Test(arguments: [false, true])
    func `replacement auth waits for active or verified owner deadline`(
        wasVerified: Bool) async throws
    {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingReplacementAuthActiveLeaseTests"))
        let url = try #require(URL(string: "ws://127.0.0.1:49152"))
        let seedGateway = GatewayConnection(
            configProvider: { (url: url, token: "route-a", password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            })))
        let seedRoute = try #require(await seedGateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "active-before-auth-replacement",
            routeFingerprint: #require(seedRoute.activationOwnershipFingerprint))
        _ = try #require(OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:ssh:stable-gateway",
            activationOwner: activationOwner,
            activationTimeoutMs: 30000,
            defaults: defaults))
        if wasVerified {
            OnboardingSystemAgentResumeStore.markVerified(
                ifOwnedBy: "remote:ssh:stable-gateway",
                activationOwner: activationOwner,
                defaults: defaults)
        }
        let expectedDeadline: Date
        switch pendingState(defaults, for: "remote:ssh:stable-gateway") {
        case let .activating(storedDeadline), let .verified(storedDeadline):
            expectedDeadline = storedDeadline
        case .activationExpired, .completed, .none:
            Issue.record("expected seeded activation lease")
            return
        }

        let recorder = AISetupRequestRecorder()
        let replacementGateway = GatewayConnection(
            configProvider: { (url: url, token: "route-b", password: nil) },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder)))
        let model = OnboardingAISetupModel(
            gateway: replacementGateway,
            defaults: defaults,
            routeIdentityProvider: { "remote:ssh:stable-gateway" })
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
        #expect(storedActivationOwner(defaults, for: "remote:ssh:stable-gateway") == activationOwner)
        let storedPendingState = pendingState(defaults, for: "remote:ssh:stable-gateway")
        if wasVerified {
            guard case let .verified(storedDeadline) = storedPendingState else {
                Issue.record("expected verified activation lease")
                return
            }
            #expect(storedDeadline == expectedDeadline)
        } else {
            guard case let .activating(storedDeadline) = storedPendingState else {
                Issue.record("expected active activation lease")
                return
            }
            #expect(storedDeadline == expectedDeadline)
        }
    }

    @Test func `expired ambiguous activation cannot hand off from same model verification`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingVerifiedExpiredActivationTests"))
        let recorder = AISetupRequestRecorder()
        let session = makeAISetupRequestSession(recorder: recorder) { task, request in
            switch request.method {
            case "openclaw.setup.verify":
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            case "openclaw.setup.detect":
                task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
            default:
                break
            }
        }
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = makeAISetupGateway(url: url, session: session)
        let route = try #require(await gateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "expired-activation",
            routeFingerprint: #require(route.activationOwnershipFingerprint))
        markPending(defaults, for: "local", owner: activationOwner, timeoutMs: 0, now: Date(timeIntervalSinceNow: -10))
        OnboardingSystemAgentResumeStore.markVerified(
            ifOwnedBy: "local",
            activationOwner: activationOwner,
            defaults: defaults)
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        var handedOff = false
        model.onConnected = { handedOff = true }

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()
        let requests = await waitForAISetupRequests(recorder, count: 2)

        #expect(outcome == .freshSetupAllowed)
        #expect(!model.connected)
        #expect(!handedOff)
        #expect(requests.methods == ["openclaw.setup.verify", "openclaw.setup.detect"])
        #expect(pendingState(defaults) == .none)
    }

    @Test func `relaunch cannot reuse a completed receipt on replacement Gateway auth`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingReplacementRouteReceiptTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let seedGateway = GatewayConnection(
            configProvider: { (url: url, token: "route-a", password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            })))
        let seedRoute = try #require(await seedGateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "completed-activation",
            routeFingerprint: #require(seedRoute.activationOwnershipFingerprint))
        markPending(defaults, for: "local", owner: activationOwner)
        #expect(markCompleted(defaults, owner: activationOwner))

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
            })))
        let relaunched = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })

        relaunched.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await relaunched.verifyPendingConfiguredInference()
        let requests = await waitForAISetupRequests(recorder, count: 1)

        #expect(outcome == .freshSetupAllowed)
        #expect(!relaunched.connected)
        #expect(requests.methods == ["openclaw.setup.detect"])
        #expect(pendingState(defaults) == .none)
    }

    @Test func `relaunch cannot reuse a completed receipt after device token rotation`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingDeviceTokenReceiptRotationTests"))
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
                gatewayID: deviceAuthGatewayID)
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
                            deviceToken: replacementToken))
                    })
            })
            let seedGateway = GatewayConnection(
                endpointProvider: {
                    GatewayConnection.EndpointSnapshot(
                        config: (url: url, token: nil, password: nil),
                        routeAuthority: nil,
                        deviceAuthGatewayID: deviceAuthGatewayID)
                },
                activationBindingKeyProvider: { activationBindingKey },
                sessionBox: WebSocketSessionBox(session: seedSession))
            let seedLease = try await seedGateway.acquireServerLease()
            let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
                id: "completed-device-token-activation",
                routeFingerprint: #require(await seedGateway.activationOwnershipFingerprint(
                    ifCurrentServerLease: seedLease)))
            #expect(await seedGateway.authSource() == .deviceToken)
            markPending(defaults, for: "local", owner: activationOwner)
            #expect(markCompleted(defaults, owner: activationOwner))
            let persistedReceipt = String(describing: defaults.object(forKey: onboardingSystemAgentPendingKey))
            #expect(!persistedReceipt.contains(originalToken))
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: deviceAuthGatewayID)?.token == replacementToken)
            await seedGateway.shutdown()

            let recorder = AISetupRequestRecorder()
            let replacementGateway = GatewayConnection(
                endpointProvider: {
                    GatewayConnection.EndpointSnapshot(
                        config: (url: url, token: nil, password: nil),
                        routeAuthority: nil,
                        deviceAuthGatewayID: deviceAuthGatewayID)
                },
                activationBindingKeyProvider: { activationBindingKey },
                sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder)))
            let relaunched = OnboardingAISetupModel(
                gateway: replacementGateway,
                defaults: defaults,
                routeIdentityProvider: { "local" })

            relaunched.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
            let outcome = await relaunched.verifyPendingConfiguredInference()
            let requests = await waitForAISetupRequests(recorder, count: 1)

            #expect(outcome == .freshSetupAllowed)
            #expect(!relaunched.connected)
            #expect(requests.methods == ["openclaw.setup.detect"])
            #expect(pendingState(defaults) == .none)
            #expect(!String(describing: defaults.object(forKey: onboardingSystemAgentPendingKey))
                .contains(replacementToken))
            await replacementGateway.shutdown()
        }
    }

    @Test func `relaunch cannot hand off after completed receipt owner is replaced`() async throws {
        let suiteName = "OnboardingSameModelReplacementOwnerTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
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
                               defaults: callbackDefaults)
                        {
                            let replacementOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
                                id: replacementID,
                                routeFingerprint: originalOwner.routeFingerprint)
                            markPending(callbackDefaults, for: "local", owner: replacementOwner)
                            markCompleted(callbackDefaults, for: "local", owner: replacementOwner)
                        }
                        task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
                    default:
                        break
                    }
                })
            })))
        let route = try #require(await gateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "completed-before-relaunch",
            routeFingerprint: #require(route.activationOwnershipFingerprint))
        markPending(defaults, for: "local", owner: activationOwner)
        #expect(markCompleted(defaults, owner: activationOwner))
        let relaunched = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })
        var handoffCount = 0
        relaunched.onConnected = { handoffCount += 1 }

        relaunched.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await relaunched.verifyPendingConfiguredInference()
        let requests = await waitForAISetupRequests(recorder, count: 1)

        #expect(outcome == .notConnected)
        #expect(!relaunched.connected)
        #expect(handoffCount == 0)
        #expect(requests.methods == ["openclaw.setup.verify"])
        #expect(storedActivationOwner(defaults)?.id == replacementID)
        #expect(pendingState(defaults) == .completed)
    }

    @Test func `ownerless mutations cannot match an owned activation`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingOwnedActivationMutationTests"))
        let activationOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "owned-activation",
            routeFingerprint: "owned-route")
        markPending(defaults, for: "local", owner: activationOwner)

        OnboardingSystemAgentResumeStore.markVerified(
            ifOwnedBy: "local",
            defaults: defaults)
        #expect({
            if case .activating = pendingState(defaults) {
                return true
            }
            return false
        }())
        #expect(!markCompleted(defaults))

        OnboardingSystemAgentResumeStore.clear(
            ifOwnedBy: "local",
            defaults: defaults)
        #expect(isOwned(by: activationOwner, defaults: defaults))
    }

    @Test func `pending marker for another route is preserved`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingSystemAgentRouteMismatchTests"))
        markPending(defaults, for: "remote:id:gateway-a")

        #expect(!isPending(defaults, for: "remote:id:gateway-b"))
        #expect(isPending(defaults, for: "remote:id:gateway-a"))
    }

    @Test func `A to B to A preserves first activation lease`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingSystemAgentMultiRouteTests"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)

        markPending(defaults, for: "remote:id:gateway-a", now: now)
        markPending(defaults, for: "remote:id:gateway-b", now: now.addingTimeInterval(1))

        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults,
            now: now.addingTimeInterval(2)))
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults,
            now: now.addingTimeInterval(2)))

        OnboardingSystemAgentResumeStore.clear(
            ifOwnedBy: "remote:id:gateway-b",
            defaults: defaults)
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults,
            now: now.addingTimeInterval(2)))
        #expect(!OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults,
            now: now.addingTimeInterval(2)))
    }

    @Test func `route reset clears only current route lease`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingSystemAgentRouteResetTests"))
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-b")
        markPending(defaults, for: "remote:id:gateway-a")
        markPending(defaults, for: "remote:id:gateway-b")
        let model = OnboardingAISetupModel(
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() })

        model.resetForGatewayChange()

        #expect(isPending(defaults, for: "remote:id:gateway-a"))
        #expect(!isPending(defaults, for: "remote:id:gateway-b"))
    }

    @Test func `gateway selection reset preserves in flight lease`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingSystemAgentSelectionResetTests"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        markPending(defaults, for: "local")
        let view = OnboardingView(
            state: appState,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" })

        view.resetGatewayBoundAIState()

        #expect(isPending(defaults, for: "local"))
    }

    @Test func `v1 route marker migrates without blocking another route`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingSystemAgentV1MigrationTests"))
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
                now: now)
            {
                return true
            }
            return false
        }())
        markPending(defaults, for: "remote:id:gateway-b", now: now)
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults,
            now: now))
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults,
            now: now))
    }

    @Test func `fallback remote route identity omits auth but preserves endpoint`() {
        let authenticatedIdentity = routeIdentity(
            .remote,
            url: "wss://user:secret@gateway.example.test/path?tenant=team-a&token=secret#fragment")
        let cleanIdentity = routeIdentity(.remote, url: "wss://gateway.example.test/path?tenant=team-a")
        let otherEndpointIdentity = routeIdentity(.remote, url: "wss://gateway.example.test/other")
        let otherQueryIdentity = routeIdentity(.remote, url: "wss://gateway.example.test/path?tenant=team-b")

        #expect(authenticatedIdentity?.hasPrefix("remote:direct:") == true)
        #expect(authenticatedIdentity?.contains("secret") == false)
        #expect(authenticatedIdentity?.contains("gateway.example.test") == false)
        #expect(authenticatedIdentity == cleanIdentity)
        #expect(authenticatedIdentity != otherEndpointIdentity)
        #expect(authenticatedIdentity != otherQueryIdentity)
    }

    @Test func `fallback route identity distinguishes local state dirs and ssh gateway ports`() {
        let localA = routeIdentity(.local, localStateDir: URL(fileURLWithPath: "/tmp/openclaw-state-a"))
        let localB = routeIdentity(.local, localStateDir: URL(fileURLWithPath: "/tmp/openclaw-state-b"))
        let sshA = routeIdentity(.remote, transport: .ssh, target: "user@gateway.example.test")
        let sshB = routeIdentity(
            .remote,
            transport: .ssh,
            target: "user@gateway.example.test",
            sshRemotePort: 18790)

        #expect(localA?.hasPrefix("local:") == true)
        #expect(localA != localB)
        #expect(sshA != sshB)
    }

    @Test func `fallback remote route identity canonicalizes the persisted URL`() {
        let beforePersistence = routeIdentity(.remote, url: "ws://localhost")
        let afterPersistence = routeIdentity(.remote, url: "ws://localhost:18789")

        #expect(beforePersistence == afterPersistence)
    }

    @Test(arguments: ["automatic", "selected", "manual"], [false, true])
    func `setup admission failure releases only confirmed unadmitted activations`(
        entry: String,
        confirmedBusy: Bool) async throws
    {
        let suiteName = "OnboardingAdmissionFailureTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
        let observation = ActivationMarkerObservation()
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "openclaw.setup.detect":
                if entry == "manual" {
                    return detectedSetupResponse(id: request.id)
                }
                let response = selectableCandidatesDetectedSetupResponse(id: request.id)
                return entry == "automatic" ? response : Data(String(decoding: response, as: UTF8.self)
                    .replacingOccurrences(of: #""credentials":true"#, with: #""credentials":false"#).utf8)
            case "openclaw.setup.activate":
                await observation.record(UserDefaults(suiteName: suiteName).map { isPending($0) } == true)
                return setupAdmissionBusyResponse(id: request.id, confirmed: confirmedBusy)
            default:
                Issue.record("Unexpected setup request: \(request.method)")
                return successfulEmptyResponse(id: request.id)
            }
        }
        let model = harness.model(defaults: defaults)
        var scheduledDeadlines = 0
        var handoffs = 0
        model.onPendingActivationDeadline = { _, _ in scheduledDeadlines += 1 }
        model.onConnected = { handoffs += 1 }

        await model.detectAndAutoConnect()
        if entry == "manual" {
            model.manualKey = "test-key-placeholder"
            model.submitManualKey()
            for _ in 0..<200 where model.manualTesting {
                try await Task.sleep(for: .milliseconds(5))
            }
        } else if entry == "selected" {
            await model.activate(kind: "codex-cli")
        }

        #expect(await observation.value())
        #expect(await harness.recorder.snapshot().methods == ["openclaw.setup.detect", "openclaw.setup.activate"])
        #expect(isPending(defaults) == !confirmedBusy)
        #expect(model.pendingActivationVerification == !confirmedBusy)
        #expect(model.waitingForPendingActivationDeadline == !confirmedBusy)
        #expect(model.isBusy == !confirmedBusy)
        #expect(model.phase == (confirmedBusy ? .ready : .detecting))
        #expect(scheduledDeadlines == (confirmedBusy ? 0 : 1))
        #expect(handoffs == 0)
        let failure: OnboardingAISetupModel.Failure? = if entry == "manual" {
            model.manualError
        } else if case let .failed(value) = model.statuses["codex-cli"] {
            value
        } else {
            nil
        }
        #expect(failure?.copyText.contains("OpenClaw setup is already in progress") == true)
        #expect(!model.exhaustedAutoCandidates)
        await harness.gateway.shutdown()
    }

    @Test(arguments: [OnboardingAISetupModel.ProviderWizardKind.auth, .prepare])
    func `setup admission busy cannot cancel or adopt another provider operation`(
        kind: OnboardingAISetupModel.ProviderWizardKind) async throws
    {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingWizardAdmissionTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, recorder in
            switch request.method {
            case "openclaw.setup.detect":
                let detections = await recorder.snapshot().methods.filter { $0 == "openclaw.setup.detect" }.count
                return detections == 1
                    ? detectedSetupResponse(id: request.id)
                    : persistedDetectedSetupResponse(id: request.id)
            case kind.startMethod:
                return setupAdmissionBusyResponse(id: request.id)
            case "wizard.cancel":
                return Data(
                    #"{"type":"res","id":"\#(request.id)","ok":false,"error":{"code":"INVALID_REQUEST","message":"wizard not found"}}"#
                        .utf8)
            default:
                Issue.record("Unexpected setup request: \(request.method)")
                return successfulEmptyResponse(id: request.id)
            }
        }
        let model = harness.model(defaults: defaults)
        let option = OnboardingAISetupModel.AuthOption(
            id: "test-provider", brandId: nil, label: "Test provider", hint: nil,
            groupLabel: nil, icon: nil, website: nil, kind: "oauth", featured: false)
        var handoffs = 0
        model.onConnected = { handoffs += 1 }
        await model.detectAndAutoConnect()
        model.startProviderWizard(option, kind: kind)
        for _ in 0..<200 where model.authBusy {
            try await Task.sleep(for: .milliseconds(5))
        }

        #expect(!model.authBusy)
        #expect(model.activeAuthOption == option)
        #expect(model.authStep == nil)
        #expect(model.authError?.copyText ==
            "\(kind.startMethod): [UNAVAILABLE] OpenClaw setup is already in progress; try again when it finishes.")
        #expect(!model.connected)
        #expect(!isPending(defaults))
        #expect(handoffs == 0)
        model.cancelProviderAuth()
        #expect(model.activeAuthOption == nil)
        #expect(model.authError == nil)
        await settleQueuedAISetupTasks()
        #expect(await harness.recorder.snapshot().methods == ["openclaw.setup.detect", kind.startMethod])
        await harness.gateway.shutdown()
    }

    @Test func `activation marks pending before request and clears definitive failure`() async throws {
        let suiteName = "OnboardingActivationMarkerTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
        let observation = ActivationMarkerObservation()
        let session = makeAISetupRequestSession(preparationKind: "codex-cli") { task, request in
            let requestDefaults = UserDefaults(suiteName: suiteName)
            await observation.record(
                requestDefaults.map {
                    OnboardingSystemAgentResumeStore.isPending(
                        for: "local",
                        defaults: $0)
                } == true)
            task.emitReceiveSuccess(.data(failedActivationResponse(id: request.id)))
        }
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = makeAISetupGateway(url: url, session: session)
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)

        await model.detectAndAutoConnect()
        await model.activate(kind: "codex-cli")

        #expect(await observation.value())
        #expect(!isPending(defaults))
    }

    @Test(arguments: [false, true])
    func `different candidate supersedes busy activation and ignores its late result`(confirmedBusy: Bool) async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingCandidateSupersedeTests"))
        let firstActivation = AISetupRequestGate()
        let claudeAttempts = AISetupSocketGeneration()
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "openclaw.setup.detect":
                return selectableCandidatesDetectedSetupResponse(id: request.id)
            case "openclaw.setup.activate":
                switch request.params["kind"] as? String {
                case "codex-cli":
                    await firstActivation.wait()
                    return successfulActivationResponse(
                        id: request.id,
                        modelRef: "openai/gpt-5.5",
                        latencyMs: 900)
                case "claude-cli" where claudeAttempts.claim() == 0:
                    return setupAdmissionBusyResponse(id: request.id, confirmed: confirmedBusy)
                case "claude-cli":
                    return successfulActivationResponse(
                        id: request.id,
                        modelRef: "claude-cli/claude-opus-4-8",
                        latencyMs: 120)
                default:
                    return failedActivationResponse(id: request.id)
                }
            default:
                return nil
            }
        }
        let model = harness.model(defaults: defaults)
        var handoffCount = 0
        model.onConnected = { handoffCount += 1 }

        let automatic = Task { await model.detectAndAutoConnect() }
        await firstActivation.waitUntilStarted()
        model.userSelect(kind: "claude-cli")

        #expect(model.selectedKind == "claude-cli")
        #expect(model.statuses["codex-cli"] == .untried)
        #expect(model.statuses["claude-cli"] == .testing)
        _ = await waitForAISetupRequests(harness.recorder, count: 3)
        await firstActivation.release()
        await automatic.value
        for _ in 0..<400 where !model.connected && !model.waitingForPendingActivationDeadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(model.connected == confirmedBusy)
        if confirmedBusy {
            #expect(pendingState(defaults) == .completed)
        } else {
            #expect(isPending(defaults))
        }
        #expect(model.waitingForPendingActivationDeadline == !confirmedBusy)
        #expect(model.selectedKind == "claude-cli")
        #expect(handoffCount == (confirmedBusy ? 1 : 0))
        #expect(await (harness.recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
            "openclaw.setup.activate",
        ] + (confirmedBusy ? ["openclaw.setup.activate"] : []))
        await harness.gateway.shutdown()
    }

    @Test func `same candidate click during testing is a no-op`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingSameCandidateClickTests"))
        let activation = AISetupRequestGate()
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "openclaw.setup.detect":
                return selectableCandidatesDetectedSetupResponse(id: request.id)
            case "openclaw.setup.activate":
                await activation.wait()
                return successfulActivationResponse(
                    id: request.id,
                    modelRef: "openai/gpt-5.5",
                    latencyMs: 900)
            default:
                return nil
            }
        }
        let model = harness.model(defaults: defaults)

        let automatic = Task { await model.detectAndAutoConnect() }
        await activation.waitUntilStarted()
        let owner = try #require(storedActivationOwner(defaults))
        model.userSelect(kind: "codex-cli")
        await settleQueuedAISetupTasks()

        #expect(model.selectedKind == "codex-cli")
        #expect(model.statuses["codex-cli"] == .testing)
        #expect(storedActivationOwner(defaults) == owner)
        #expect(await (harness.recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
        ])
        await activation.release()
        await automatic.value
    }

    @Test func `user pick after exhausted auto candidates clears the stale verdict`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingExhaustedRetryTests"))
        let attempts = AISetupSocketGeneration()
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "openclaw.setup.detect":
                selectableCandidatesDetectedSetupResponse(id: request.id)
            case "openclaw.setup.activate" where attempts.claim() < 2:
                failedActivationResponse(id: request.id)
            case "openclaw.setup.activate":
                successfulActivationResponse(
                    id: request.id,
                    modelRef: "openai/gpt-5.5",
                    latencyMs: 120)
            default:
                nil
            }
        }
        let model = harness.model(defaults: defaults)

        await model.detectAndAutoConnect()
        #expect(model.exhaustedAutoCandidates)
        #expect(!model.connected)

        model.userSelect(kind: "codex-cli")
        // The retest owns the verdict from the moment it starts; the stale
        // "none of the found options worked" card must not outlive the pick.
        #expect(!model.exhaustedAutoCandidates)
        for _ in 0..<400 where !model.connected {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        #expect(model.connected)
        #expect(model.selectedKind == "codex-cli")
    }

    @Test func `candidate click after connection is ignored`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingConnectedCandidateClickTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "openclaw.setup.detect":
                selectableCandidatesDetectedSetupResponse(id: request.id)
            case "openclaw.setup.activate":
                successfulActivationResponse(
                    id: request.id,
                    modelRef: "openai/gpt-5.5",
                    latencyMs: 120)
            default:
                nil
            }
        }
        let model = harness.model(defaults: defaults)

        await model.detectAndAutoConnect()
        model.userSelect(kind: "claude-cli")
        await settleQueuedAISetupTasks()

        #expect(model.connected)
        #expect(model.selectedKind == "codex-cli")
        #expect(await (harness.recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
        ])
    }

    @Test func `superseding candidate replaces and clears the pending activation owner`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingCandidateLeaseReplacementTests"))
        let firstActivation = AISetupRequestGate()
        let secondActivation = AISetupRequestGate()
        let url = try #require(URL(string: "ws://example.invalid"))
        let harness = AISetupHarness(url: url) { _, request, _ in
            switch request.method {
            case "openclaw.setup.detect":
                return selectableCandidatesDetectedSetupResponse(id: request.id)
            case "openclaw.setup.activate" where request.params["kind"] as? String == "codex-cli":
                await firstActivation.wait()
                return successfulActivationResponse(
                    id: request.id,
                    modelRef: "openai/gpt-5.5",
                    latencyMs: 900)
            case "openclaw.setup.activate":
                await secondActivation.wait()
                return failedActivationResponse(id: request.id)
            default:
                return nil
            }
        }
        let model = harness.model(defaults: defaults)

        let automatic = Task { await model.detectAndAutoConnect() }
        await firstActivation.waitUntilStarted()
        let supersededOwner = try #require(storedActivationOwner(defaults))
        guard case let .activating(supersededDeadline) = pendingState(defaults) else {
            Issue.record("expected the first candidate to own an activation lease")
            return
        }
        model.userSelect(kind: "claude-cli")
        await secondActivation.waitUntilStarted()
        let replacementOwner = try #require(storedActivationOwner(defaults))
        guard case let .activating(replacementDeadline) = pendingState(defaults) else {
            Issue.record("expected the selected candidate to replace the activation lease")
            return
        }

        #expect(replacementOwner != supersededOwner)
        #expect(replacementDeadline >= supersededDeadline)
        #expect(!isOwned(by: supersededOwner, defaults: defaults))
        #expect(isOwned(by: replacementOwner, defaults: defaults))
        await firstActivation.release()
        await secondActivation.release()
        await automatic.value
        for _ in 0..<200 where isPending(defaults) {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(pendingState(defaults) == .none)
        #expect(!model.connected)
    }

    @Test func `stale queued detection cannot probe a replacement Gateway`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingQueuedDetectionRouteTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "route-a-token")
        let recorder = AISetupRequestRecorder()
        let session = makeAISetupSession(recorder: recorder)
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: session))
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() })

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
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingQueuedSelectionRouteTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "route-a-token")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder)))
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() })
        await model.detectAndAutoConnect()

        model.userSelect(kind: "claude-cli")
        model.resetForGatewayChange()
        config.setToken("route-b-token")
        routeIdentity.set("remote:id:gateway-b")
        await settleQueuedAISetupTasks()

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["openclaw.setup.detect"])
        #expect(!isPending(defaults, for: "remote:id:gateway-b"))
        #expect(model.phase == .idle)
    }

    @Test func `stale manual key task never sends credentials to a replacement Gateway`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingQueuedManualRouteTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "route-a-token")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder)))
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() })
        await model.detectAndAutoConnect()
        model.manualProviderID = "openai-api-key"
        model.manualKey = "old-route-secret"

        model.submitManualKey()
        #expect(model.manualTesting)
        #expect(OnboardingController.shared.busyReason == "OpenClaw is testing your AI connection.")
        model.resetForGatewayChange()
        #expect(OnboardingController.shared.busyReason == nil)
        config.setToken("route-b-token")
        routeIdentity.set("remote:id:gateway-b")
        await settleQueuedAISetupTasks()

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["openclaw.setup.detect"])
        #expect(!requests.apiKeys.contains("old-route-secret"))
        #expect(!isPending(defaults, for: "remote:id:gateway-b"))
        #expect(!model.manualTesting)
    }

    @Test func `automatic activation rejects an auth-token change before dispatch`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingAutomaticActivationTokenTests"))
            let url = try #require(URL(string: "ws://example.invalid"))
            let config = AISetupGatewayConfig(url: url, token: "token-a")
            let recorder = AISetupRequestRecorder()
            let gateway = GatewayConnection(
                configProvider: { config.snapshot() },
                sessionBox: WebSocketSessionBox(session: makeAISetupSession(
                    recorder: recorder,
                    detectedKind: "codex-cli")))
            let model = makeAISetupModel(gateway: gateway, defaults: defaults)

            await model.detectAndAutoConnect()
            config.switchToken(to: "token-b", afterReads: 2)
            await model.activate(kind: "codex-cli")

            #expect(await (recorder.snapshot()).methods == ["openclaw.setup.detect"])
            #expect(!isPending(defaults))
            #expect(!model.pendingActivationVerification)
            #expect(model.phase == .ready)
        }
    }

    @Test func `manual activation rejects an auth-token change before sending the key`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingManualActivationTokenTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "token-a")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder)))
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        await model.detectAndAutoConnect()
        model.manualProviderID = "openai-api-key"
        model.manualKey = "must-not-send"
        config.switchToken(to: "token-b", afterReads: 2)

        model.submitManualKey()
        for _ in 0..<200 {
            guard model.manualTesting else { break }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["openclaw.setup.detect"])
        #expect(!requests.apiKeys.contains("must-not-send"))
        #expect(!isPending(defaults))
        #expect(!model.pendingActivationVerification)
        #expect(model.detectError != nil)
    }

    @Test(arguments: [false, true])
    func `cancellation after activation dispatch retains pending resume marker`(cancelCaller: Bool) async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingDispatchedCancellationTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "token-a")
        let recorder = AISetupRequestRecorder()
        let gate = AISetupRequestGate()
        let session = makeAISetupRequestSession(recorder: recorder) { task, request in
            if respondToAISetupPreparation(
                task: task,
                request: request,
                kind: "codex-cli")
            {
                return
            }
            guard request.method == "openclaw.setup.activate" else { return }
            await gate.wait()
            throw CancellationError()
        }
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: session))
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        model.onPendingActivationDeadline = { deadline, routeIdentity in
            scheduledDeadlines.append((deadline, routeIdentity))
        }

        await model.detectAndAutoConnect()
        let activation = Task { await model.activate(kind: "codex-cli") }
        await gate.waitUntilStarted()
        if cancelCaller {
            activation.cancel()
        }
        await gate.release()
        await activation.value

        #expect(await (recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
        ])
        #expect(isPending(defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.isBusy)
        #expect(model.phase == .detecting)
        #expect(scheduledDeadlines.count == 1)
        #expect(scheduledDeadlines.first?.routeIdentity == "local")
    }

    @Test func `indeterminate Gateway activation error retains pending resume marker`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingIndeterminateGatewayActivationTests"))
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
            })))
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        var scheduledRoutes: [String] = []
        model.onPendingActivationDeadline = { _, routeIdentity in
            scheduledRoutes.append(routeIdentity)
        }

        await model.detectAndAutoConnect()
        await model.activate(kind: "codex-cli")

        #expect(await (recorder.snapshot()).methods == ["openclaw.setup.activate"])
        #expect(isPending(defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.phase == .detecting)
        #expect(scheduledRoutes == ["local"])
    }

    @Test func `ambiguous activation recreates a marker cleared by an earlier probe`() async throws {
        let suiteName = "OnboardingMarkerClearedActivationTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
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
                            defaults: callbackDefaults)
                        if case let .activating(deadline) = pendingState {
                            await markerObservation.record(deadline: deadline)
                        }
                        OnboardingSystemAgentResumeStore.clear(
                            ifOwnedBy: "local",
                            defaults: callbackDefaults)
                    }
                    task.emitReceiveSuccess(.data(indeterminateActivationResponse(id: request.id)))
                })
            })))
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        model.onPendingActivationDeadline = { deadline, routeIdentity in
            #expect(isPending(defaults, for: routeIdentity))
            scheduledDeadlines.append((deadline, routeIdentity))
        }

        await model.detectAndAutoConnect()
        await model.activate(kind: "codex-cli")

        #expect(await (recorder.snapshot()).methods == ["openclaw.setup.activate"])
        #expect(isPending(defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.phase == .detecting)
        #expect(scheduledDeadlines.count == 1)
        #expect(scheduledDeadlines.first?.routeIdentity == "local")
        let originalDeadline = try #require(await markerObservation.deadline())
        let restoredState = pendingState(defaults)
        guard case let .activating(restoredDeadline) = restoredState else {
            Issue.record("expected restored activation marker")
            return
        }
        #expect(restoredDeadline == originalDeadline)

        let relaunched = OnboardingAISetupModel(
            defaults: defaults,
            routeIdentityProvider: { "local" })
        relaunched.waitForPendingActivationDeadline()
        #expect(relaunched.waitingForPendingActivationDeadline)
        #expect(relaunched.pendingActivationVerification == false)
    }

    @Test func `ambiguous activation with cleared marker cannot hand off from same model`() async throws {
        let suiteName = "OnboardingClearedMarkerConfiguredRouteTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
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
                                defaults: callbackDefaults)
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
                            modelRef: "openai/gpt-5.5")))
                    default:
                        break
                    }
                })
            })))
        let view = makeAISetupView(
            state: appState,
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })
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
        #expect(isPending(defaults))
        #expect(scheduledDeadlines.count == 1)

        let initialRecheck = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true))
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
            if case .verified = pendingState(defaults) {
                return true
            }
            return false
        }())

        let storedOwner = try #require(storedActivationOwner(defaults))
        markPending(defaults, for: "local", owner: storedOwner, timeoutMs: 0, now: Date(timeIntervalSinceNow: -10))
        let deadlineRecheck = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true))
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
        #expect(pendingState(defaults) == .none)
        view.onboardingDidDisappear()
    }

    @Test func `ambiguous activation after lease expiry rechecks before fresh setup`() async throws {
        let suiteName = "OnboardingExpiredDispatchedCancellationTests-\(UUID().uuidString)"
        let defaults = try #require(isolatedAISetupDefaults(suiteName: suiteName))
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let recorder = AISetupRequestRecorder()
        let session = makeAISetupRequestSession(recorder: recorder) { task, request in
            switch request.method {
            case "openclaw.setup.activate":
                if let requestDefaults = UserDefaults(suiteName: suiteName),
                   let activationOwner = OnboardingSystemAgentResumeStore.activationOwner(
                       for: "local",
                       defaults: requestDefaults)
                {
                    markPending(
                        requestDefaults,
                        for: "local",
                        owner: activationOwner,
                        timeoutMs: 0,
                        now: Date(timeIntervalSinceNow: -10))
                }
                task.emitReceiveSuccess(.data(indeterminateActivationResponse(id: request.id)))
            case "agents.list":
                task.emitReceiveSuccess(.data(missingConfiguredModelResponse(id: request.id)))
            case "openclaw.setup.detect":
                task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
            default:
                break
            }
        }
        let gateway = makeAISetupGateway(url: url, session: session)
        let view = makeAISetupView(
            state: appState,
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })
        var recheckTask: Task<Void, Never>?
        var recheckRoute: String?
        view.aiSetup.onPendingActivationDeadline = { _, routeIdentity in
            recheckRoute = routeIdentity
            recheckTask = view.probeConfiguredGatewayForDashboard(
                startAISetupWhenMissing: true,
                knownVisible: true,
                knownAISetupPage: true)
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
        #expect(pendingState(defaults) == .none)
        view.onboardingDidDisappear()
    }

    @Test func `manual indeterminate response schedules pending deadline recheck`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingManualDispatchedCancellationTests"))
        let url = try #require(URL(string: "ws://example.invalid"))
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(
                recorder: recorder,
                indeterminateActivationAfterDispatch: true)))
        let model = makeAISetupModel(gateway: gateway, defaults: defaults)
        await model.detectAndAutoConnect()
        model.manualProviderID = "openai-api-key"
        model.manualKey = "temporary-key"
        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        model.onPendingActivationDeadline = { deadline, routeIdentity in
            scheduledDeadlines.append((deadline, routeIdentity))
        }

        model.submitManualKey()
        // The full suite can starve MainActor work; wait for state instead of a one-second budget.
        for _ in 0..<2000 {
            if !model.manualTesting, model.waitingForPendingActivationDeadline {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(await (recorder.snapshot()).methods == [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
        ])
        #expect(isPending(defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.phase == .detecting)
        #expect(scheduledDeadlines.count == 1)
        #expect(scheduledDeadlines.first?.routeIdentity == "local")
    }

    @Test func `superseded activation cannot clear the current gateway handoff`() async throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingSupersededActivationMarkerTests"))
        let session = makeAISetupRequestSession(preparationKind: "codex-cli") { task, _ in
            task.emitReceiveFailure()
        }
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = makeAISetupGateway(url: url, session: session)
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "remote:id:gateway-a" })

        await model.detectAndAutoConnect()
        let staleActivation = Task { await model.activate(kind: "codex-cli") }
        while !isPending(defaults, for: "remote:id:gateway-a") {
            await Task.yield()
        }
        model.resetForGatewayChange()
        markPending(defaults, for: "remote:id:gateway-b")
        staleActivation.cancel()
        await staleActivation.value

        #expect(isPending(defaults, for: "remote:id:gateway-b"))
    }

    @Test func `configured resume preserves marker until route reset`() throws {
        let defaults = try #require(isolatedAISetupDefaults(prefix: "OnboardingConfiguredResumeMarkerTests"))
        let model = OnboardingAISetupModel(
            defaults: defaults,
            routeIdentityProvider: { "local" })
        markPending(defaults)

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        #expect(isPending(defaults))

        model.resetForGatewayChange()
        #expect(!isPending(defaults))
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
