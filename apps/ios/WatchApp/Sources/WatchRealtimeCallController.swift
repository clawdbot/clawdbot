import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import Synchronization

@MainActor
@Observable
final class WatchRealtimeCallController {
    enum State: Equatable {
        case idle, preparingAudio, connectingGateway, choosingAgent, connectingVoice, active, reconnecting, stopping,
             failed
    }

    private(set) var state: State = .idle
    private(set) var agents: [AgentSummary] = []
    private(set) var selectedAgentID: String?
    private(set) var latestUserTranscript = ""
    private(set) var latestAssistantTranscript = ""
    private(set) var inputLevel: Float = 0
    private(set) var isMuted = false
    private(set) var errorText: String?

    @ObservationIgnored private var call: Call?
    @ObservationIgnored private var attempt: Attempt?
    @ObservationIgnored private var cleanupTask: Task<Void, Never>?
    @ObservationIgnored private var transitionID = UUID()

    func start(connection: WatchVoiceConnection, isCurrent: @escaping @MainActor () -> Bool) {
        self.transitionID = UUID()
        self.call = nil
        self.retireAttempt()
        self.resetPresentation()
        self.errorText = nil
        guard isCurrent(), !connection.websocketURLs.isEmpty,
              connection.websocketURLs.allSatisfy({ $0.scheme == "wss" && $0.user == nil && $0.password == nil })
        else {
            self.state = .failed
            self.errorText = String(localized: "Reconnect the Watch to your Gateway, then start voice again.")
            return
        }
        let call = Call(connection: connection, isCurrent: isCurrent)
        self.call = call
        self.launchAttempt(for: call)
    }

    func selectAgent(_ agentID: String) {
        guard self.state == .choosingAgent, let attempt = self.attempt,
              self.agents.contains(where: { $0.id.utf8.elementsEqual(agentID.utf8) })
        else { return }
        do {
            try self.checkCurrent(attempt)
            self.select(agentID, for: attempt.call)
            self.state = .connectingVoice
            attempt.startupTask = Task { [weak self, weak attempt] in
                guard let self, let attempt else { return }
                do {
                    try await self.connectVoice(attempt)
                } catch {
                    self.fail(error, attempt: attempt)
                }
            }
        } catch {
            self.fail(error, attempt: attempt)
        }
    }

    func setMuted(_ muted: Bool) {
        self.isMuted = muted
        self.attempt?.media.setMuted(self.state != .active || muted)
        if muted { self.inputLevel = 0 }
    }

    @discardableResult
    func end(message: String? = nil) -> Task<Void, Never> {
        let transitionID = UUID()
        self.transitionID = transitionID
        self.call = nil
        self.state = .stopping
        self.errorText = message
        self.retireAttempt()
        // The app retains this controller across Gateway changes, not the previous call's presentation.
        self.resetPresentation()
        let cleanup = self.cleanupTask
        let completion = Task { [weak self] in
            await cleanup?.value
            guard let self, self.transitionID == transitionID else { return }
            self.state = .idle
        }
        self.cleanupTask = completion
        return completion
    }

    @discardableResult
    func sceneDidEnterBackground() -> Task<Void, Never>? {
        // A retry has connecting states too. Only the call owner's recorded readiness
        // distinguishes an established background call from an unfinished first start.
        guard let call = self.call, !call.wasActive else { return nil }
        return self
            .end(
                message: String(
                    localized: "Connection stopped in the background. Keep OpenClaw on screen until connected."))
    }

    private func resetPresentation() {
        self.agents = []
        self.selectedAgentID = nil
        self.latestUserTranscript = ""
        self.latestAssistantTranscript = ""
        self.inputLevel = 0
        self.isMuted = false
    }

    private func launchAttempt(for call: Call) {
        let attempt = Attempt(call: call)
        self.attempt = attempt
        self.state = call.reconnectCount == 0 ? .preparingAudio : .reconnecting
        let cleanup = self.cleanupTask
        // Lifecycle callbacks only enqueue events. This consumer is created outside the
        // Gateway callback context, so teardown never awaits its own callback barrier.
        attempt.eventTask = Task { [weak self, weak attempt, events = attempt.events] in
            for await event in events {
                guard let self, let attempt, self.attempt === attempt else { return }
                switch event {
                case .mediaConnected:
                    attempt.mediaConnected = true
                    self.becomeActiveIfReady(attempt)
                case let .ended(error): self.fail(error, attempt: attempt)
                case let .gatewayDisconnected(endpointGeneration):
                    guard attempt.endpointGeneration == endpointGeneration, attempt.route != nil else { continue }
                    self.fail(
                        WatchRealtimeMediaFailure(
                            kind: .network,
                            message: String(localized: "Gateway connection lost.")),
                        attempt: attempt)
                }
            }
        }
        attempt.startupTask = Task { [weak self, weak attempt] in
            guard let self, let attempt else { return }
            await cleanup?.value
            do {
                try self.checkCurrent(attempt)
                if call.reconnectCount > 0 {
                    try await Task.sleep(for: .seconds(call.reconnectCount))
                    try self.checkCurrent(attempt)
                }
                // watchOS permits low-level networking only with an active audio session.
                // Capture stays muted until both the Gateway owner and media are ready.
                attempt.media.setMuted(true)
                try await attempt.media.startAudio()
                try self.checkCurrent(attempt)
                try await self.connectGateway(attempt)
                try self.checkCurrent(attempt)
                let data = try await self.request("agents.list", paramsJSON: nil, attempt: attempt)
                let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
                self.agents = result.agents
                if let agentID = call.agentID {
                    guard result.agents.contains(where: { $0.id.utf8.elementsEqual(agentID.utf8) }) else {
                        throw Self
                            .unavailable(
                                String(localized: "The selected agent is no longer available. Start a new call."))
                    }
                } else if result.agents.count == 1, let agent = result.agents.first {
                    self.select(agent.id, for: call)
                } else if result.agents.isEmpty {
                    throw Self.unavailable(String(localized: "No agents are available on this Gateway."))
                } else {
                    self.state = .choosingAgent
                    return
                }
                try await self.connectVoice(attempt)
            } catch {
                self.fail(error, attempt: attempt)
            }
        }
    }

    private func connectGateway(_ attempt: Attempt) async throws {
        self.state = .connectingGateway
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read", "operator.talk"],
            scopesAreExplicit: true,
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-watchos",
            clientMode: "node",
            clientDisplayName: "OpenClaw Watch Voice",
            deviceIdentityProfile: .primary,
            deviceAuthGatewayID: attempt.call.connection.gatewayID)
        let events = attempt.continuation
        for (index, url) in attempt.call.connection.websocketURLs.enumerated() {
            try self.checkCurrent(attempt)
            attempt.endpointGeneration = index
            do {
                try await attempt.gateway.connect(
                    url: url,
                    credentials: GatewayNodeSessionCredentials(),
                    connectOptions: options,
                    sessionBox: WebSocketSessionBox(session: attempt.controlHTTP),
                    onConnected: {},
                    onDisconnected: { _ in events.yield(.gatewayDisconnected(index)) },
                    onInvoke: { request in
                        BridgeInvokeResponse(
                            id: request.id,
                            ok: false,
                            error: OpenClawNodeError(
                                code: .unavailable,
                                message: "Voice connection has no node commands."))
                    },
                    onRouteInvalidated: { events.yield(.gatewayDisconnected(index)) })
                try self.checkCurrent(attempt)
                guard let route = await attempt.gateway.currentRoute(ifGatewayID: attempt.call.connection.gatewayID)
                else {
                    throw WatchRealtimeMediaFailure(
                        kind: .network,
                        message: String(localized: "Gateway connection lost during startup."))
                }
                try self.checkCurrent(attempt)
                let scopes = await attempt.gateway.currentOperatorScopes(ifCurrentRoute: route) ?? []
                try self.checkCurrent(attempt)
                guard scopes == Set(["operator.read", "operator.talk"]) else {
                    throw Self
                        .unavailable(String(localized: "Pair this Watch with read and Talk access in iPhone Settings."))
                }
                attempt.route = route
                return
            } catch {
                try self.checkCurrent(attempt)
                guard Self.isNetworkFailure(error),
                      index + 1 < attempt.call.connection.websocketURLs.count else { throw error }
                await attempt.gateway.disconnect()
                try self.checkCurrent(attempt)
            }
        }
    }

    private func select(_ agentID: String, for call: Call) {
        call.agentID = agentID
        call.sessionKey = "agent:\(agentID):watch:\(UUID().uuidString.lowercased())"
        self.selectedAgentID = agentID
    }

    private func connectVoice(_ attempt: Attempt) async throws {
        try self.checkCurrent(attempt)
        guard let sessionKey = attempt.call.sessionKey else { throw CancellationError() }
        self.state = .connectingVoice
        let voiceID = attempt.voiceSessionID
        let subscription = await attempt.gateway.makeServerEventSubscription(bufferingNewest: 64) { event in
            event.event == "talk.event" && event.payload?.dictionaryValue?["voiceSessionId"]?.stringValue == voiceID
        }
        do {
            try self.checkCurrent(attempt)
        } catch {
            subscription.cancel()
            throw error
        }
        attempt.subscription = subscription
        attempt.talkTask = Task { [weak self, weak attempt] in
            for await frame in subscription.events {
                guard let self, let attempt, self.attempt === attempt else { return }
                self.handleTalkEvent(frame, attempt: attempt)
            }
        }
        let params = TalkRealtimeClientCreateParams(
            sessionKey: sessionKey, voiceSessionId: voiceID, capabilities: ["gateway-control-v1"])
        let data = try await self.request("talk.client.create", paramsJSON: Self.encode(params), attempt: attempt)
        let session = try JSONDecoder().decode(TalkRealtimeClientSession.self, from: data)
        // The requested ID lets us subscribe before creation; reject any different owner
        // rather than admitting events or closing a session under another identifier.
        guard session.voiceSessionId == voiceID, session.clientControl?.owner == "gateway", session.isWebRTC,
              !session.clientSecret.isEmpty, let offerURL = session.offerUrl, let route = attempt.route,
              let url = await attempt.gateway.resolveGatewayHTTPURL(offerURL, relativeToGatewayContextOf: route),
              url.scheme == "https", url.user == nil, url.password == nil
        else {
            throw Self
                .unavailable(
                    String(localized: "This Gateway did not provide a usable Gateway-controlled WebRTC session."))
        }
        attempt.created = true
        try self.checkCurrent(attempt)
        let offer = try await attempt.media.makeOffer()
        try self.checkCurrent(attempt)
        let answer = try await self.exchangeOffer(offer, at: url, session: session, attempt: attempt)
        try self.checkCurrent(attempt)
        try await attempt.media.applyAnswer(answer)
        try self.checkCurrent(attempt)
        attempt.answerApplied = true
        self.becomeActiveIfReady(attempt)
        if self.state != .active {
            attempt.deadlineTask = Task { [weak self, weak attempt] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                guard let self, let attempt, self.attempt === attempt, self.state != .active else { return }
                self.fail(
                    WatchRealtimeMediaFailure(
                        kind: .network,
                        message: String(localized: "Voice did not connect. Check your network and try again.")),
                    attempt: attempt)
            }
        }
    }

    private func exchangeOffer(
        _ offer: String, at url: URL, session: TalkRealtimeClientSession, attempt: Attempt) async throws -> String
    {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data(offer.utf8)
        for (key, value) in session.offerHeaders ?? [:] {
            guard !["authorization", "cookie", "proxy-authorization", "host"].contains(key.lowercased())
            else { continue }
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.setValue("Bearer \(session.clientSecret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        // A redirect must never forward the ephemeral provider credential to a new URL.
        let http = Self.makeURLSession()
        attempt.http = http
        defer {
            http.invalidateAndCancel()
            attempt.http = nil
        }
        try self.checkCurrent(attempt)
        let (bytes, response) = try await http.bytes(for: request)
        try self.checkCurrent(attempt)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw Self.unavailable(String(localized: "The voice provider rejected the connection. Start a new call."))
        }
        var data = Data()
        for try await byte in bytes {
            try self.checkCurrent(attempt)
            guard data.count < 65536
            else { throw Self.unavailable(String(localized: "The voice provider returned an invalid SDP answer.")) }
            data.append(byte)
        }
        try self.checkCurrent(attempt)
        guard let answer = String(data: data, encoding: .utf8), !answer.isEmpty else {
            throw Self.unavailable(String(localized: "The voice provider returned an empty SDP answer."))
        }
        return answer
    }

    private func request(_ method: String, paramsJSON: String?, attempt: Attempt) async throws -> Data {
        try self.checkCurrent(attempt)
        guard let route = attempt.route else { throw CancellationError() }
        let data = try await attempt.gateway.request(method: method, paramsJSON: paramsJSON, ifCurrentRoute: route)
        try self.checkCurrent(attempt)
        return data
    }

    private func handleTalkEvent(_ frame: EventFrame, attempt: Attempt) {
        do {
            try self.checkCurrent(attempt)
            guard try attempt.talkEvents.accept(frame) else { return }
            self.errorText = attempt.talkEvents.errorText
            self.latestUserTranscript = attempt.talkEvents.latestUserTranscript
            self.latestAssistantTranscript = attempt.talkEvents.latestAssistantTranscript
            self.becomeActiveIfReady(attempt)
        } catch {
            self.fail(error, attempt: attempt)
        }
    }

    private func becomeActiveIfReady(_ attempt: Attempt) {
        guard self.attempt === attempt, attempt.answerApplied, attempt.mediaConnected,
              attempt.talkEvents.controlReady else { return }
        do { try self.checkCurrent(attempt) } catch { self.fail(error, attempt: attempt)
            return
        }
        guard self.state != .active else { return }
        attempt.deadlineTask?.cancel()
        attempt.call.wasActive = true
        self.state = .active
        attempt.media.setMuted(self.isMuted)
        attempt.meterTask = Task { [weak self, weak attempt] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                guard let self, let attempt, self.attempt === attempt else { return }
                self.inputLevel = self.isMuted ? 0 : attempt.level.value.withLock { $0 }
            }
        }
    }

    private func checkCurrent(_ attempt: Attempt) throws {
        try Task.checkCancellation()
        guard self.attempt === attempt, self.call === attempt.call,
              attempt.call.isCurrent() else { throw CancellationError() }
    }

    private func fail(_ error: Error, attempt: Attempt) {
        guard self.attempt === attempt else { return }
        self.transitionID = UUID()
        let call = attempt.call
        let stillOwned = self.call === call && call.isCurrent()
        self.retireAttempt()
        if stillOwned, call.wasActive, call.reconnectCount < 2,
           Self.isNetworkFailure(error) || error is CancellationError
        {
            call.reconnectCount += 1
            self.launchAttempt(for: call)
        } else {
            self.call = nil
            self.state = .failed
            self.errorText = stillOwned ? String(error.localizedDescription.prefix(
                500)) : String(localized: "The Gateway connection changed. Start voice again.")
        }
    }

    private func retireAttempt() {
        guard let old = self.attempt else { return }
        self.attempt = nil
        self.inputLevel = 0
        old.media.cancel()
        old.startupTask?.cancel()
        old.eventTask?.cancel()
        old.talkTask?.cancel()
        old.deadlineTask?.cancel()
        old.meterTask?.cancel()
        old.continuation.finish()
        old.subscription?.cancel()
        old.http?.invalidateAndCancel()
        let previous = self.cleanupTask
        self.cleanupTask = Task {
            await previous?.value
            async let audioStopped: Void = old.media.stop()
            if old.created, let sessionKey = old.call.sessionKey, let route = old.route,
               let params = try? Self.encode(TalkRealtimeClientCloseParams(
                   sessionKey: sessionKey,
                   voiceSessionId: old.voiceSessionID))
            {
                _ = try? await old.gateway.request(
                    method: "talk.client.close",
                    paramsJSON: params,
                    timeoutSeconds: 5,
                    ifCurrentRoute: route)
            }
            // Disconnect also closes Gateway-owned creation that outlived its canceled RPC.
            await old.gateway.disconnect()
            old.controlHTTP.invalidateAndCancel()
            await audioStopped
            await old.startupTask?.value
            await old.eventTask?.value
            await old.talkTask?.value
            await old.deadlineTask?.value
            await old.meterTask?.value
        }
    }

    private static func encode(_ value: some Encodable) throws -> String {
        guard let json = try String(data: JSONEncoder().encode(value), encoding: .utf8) else {
            throw self.unavailable(String(localized: "Voice could not encode its Gateway request."))
        }
        return json
    }

    private static func makeURLSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 25
        return URLSession(configuration: configuration, delegate: WatchURLSessionMetrics(), delegateQueue: nil)
    }

    private static func unavailable(_ message: String) -> WatchRealtimeMediaFailure {
        WatchRealtimeMediaFailure(kind: .protocolError, message: message)
    }

    private static func isNetworkFailure(_ error: Error) -> Bool {
        if let failure = error as? WatchRealtimeMediaFailure { return failure.kind == .network }
        let error = error as NSError
        guard error.domain == NSURLErrorDomain else { return false }
        return [
            URLError.timedOut,
            .cannotFindHost,
            .cannotConnectToHost,
            .networkConnectionLost,
            .dnsLookupFailed,
            .notConnectedToInternet,
            .internationalRoamingOff,
            .dataNotAllowed,
        ]
            .contains(URLError.Code(rawValue: error.code))
    }
}

extension WatchRealtimeCallController {
    @MainActor
    private final class Call {
        let connection: WatchVoiceConnection
        let isCurrent: @MainActor () -> Bool
        var agentID: String?
        var sessionKey: String?
        var wasActive = false
        var reconnectCount = 0

        init(connection: WatchVoiceConnection, isCurrent: @escaping @MainActor () -> Bool) {
            self.connection = connection
            self.isCurrent = isCurrent
        }
    }

    private enum Event: Sendable {
        case mediaConnected, gatewayDisconnected(Int), ended(WatchRealtimeMediaFailure)
    }

    private final class Level: Sendable {
        let value = Mutex<Float>(0)
    }

    @MainActor
    private final class Attempt {
        let call: Call
        let voiceSessionID = UUID().uuidString.lowercased()
        let gateway = GatewayNodeSession()
        let controlHTTP = WatchRealtimeCallController.makeURLSession()
        let media: WatchRealtimeMediaSession
        let events: AsyncStream<Event>
        let continuation: AsyncStream<Event>.Continuation
        let level = Level()
        var route: GatewayNodeSessionRoute?
        var endpointGeneration = 0
        var subscription: GatewayServerEventSubscription?
        var http: URLSession?
        var startupTask: Task<Void, Never>?
        var eventTask: Task<Void, Never>?
        var talkTask: Task<Void, Never>?
        var deadlineTask: Task<Void, Never>?
        var meterTask: Task<Void, Never>?
        var created = false
        var answerApplied = false
        var mediaConnected = false
        var talkEvents = TalkEvents()

        init(call: Call) {
            self.call = call
            let (events, continuation) = AsyncStream<Event>.makeStream(bufferingPolicy: .bufferingNewest(8))
            self.events = events
            self.continuation = continuation
            self.media = WatchRealtimeMediaSession { [level = self.level] event in
                switch event {
                case .connected: continuation.yield(.mediaConnected)
                case let .ended(error): continuation.yield(.ended(error))
                case let .inputLevel(value): level.value.withLock { $0 = value }
                }
            }
        }
    }

    @MainActor
    struct TalkEvents {
        private(set) var controlReady = false
        private(set) var errorText: String?
        private var lastSequence = -1
        private var userTranscript = Transcript()
        private var assistantTranscript = Transcript()

        var latestUserTranscript: String {
            self.userTranscript.text
        }

        var latestAssistantTranscript: String {
            self.assistantTranscript.text
        }

        mutating func accept(_ frame: EventFrame) throws -> Bool {
            guard let payload = frame.payload else { return false }
            let event = try JSONDecoder().decode(VoiceEvent.self, from: JSONEncoder().encode(payload)).talkEvent
            guard event.seq > self.lastSequence else { return false }
            self.lastSequence = event.seq
            switch event.type.stringValue {
            case "session.ready":
                guard !self.controlReady else { return false }
                self.controlReady = true
                self.errorText = nil
            case "session.error":
                // Response and transcription errors do not close the Gateway's session.
                // Only its explicit closure or an actual transport failure retires the call.
                self.errorText = String((event.payload.dictionaryValue?["message"]?
                        .stringValue ?? String(localized: "Voice encountered an error. Try speaking again."))
                    .prefix(500))
            case "turn.started":
                self.errorText = nil
            case "session.closed":
                throw WatchRealtimeMediaFailure(
                    kind: .sessionEnded,
                    message: String(localized: "The voice call ended. Start a new call to continue."))
            case "transcript.delta", "transcript.done":
                self.userTranscript.accept(event)
            case "output.text.delta", "output.text.done":
                self.assistantTranscript.accept(event)
            default: return false
            }
            return true
        }
    }

    private struct VoiceEvent: Decodable {
        let talkEvent: TalkEvent
    }

    private struct Transcript {
        private var turnID: String?
        private var finished = false
        private(set) var text = ""

        mutating func accept(_ event: TalkEvent) {
            guard let value = event.payload.dictionaryValue?["text"]?.stringValue else { return }
            let isFinal = event.final == true || event.type.stringValue?.hasSuffix(".done") == true
            if self.turnID != event.turnid || self.finished || isFinal { self.text = "" }
            self.turnID = event.turnid
            self.finished = isFinal
            self.text = String((self.text + value).suffix(1000))
        }
    }
}
