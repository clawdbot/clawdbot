import MoltbotKit
import MoltbotProtocol
import Network
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class NodeAppModel {
    enum CameraHUDKind {
        case photo
        case recording
        case success
        case error
    }

    enum ConnectionRole: String {
        case `operator`
        case node
    }

    enum GatewayPairingState: Equatable {
        case none
        case operatorPending
        case nodePending
        case bothPending
    }

    var isBackgrounded: Bool = false
    let screen = ScreenController()
    let camera = CameraController()
    private let screenRecorder = ScreenRecordService()
    var gatewayStatusText: String = "Offline"
    var gatewayServerName: String?
    var gatewayRemoteAddress: String?
    var connectedGatewayID: String?
    var seamColorHex: String?
    var mainSessionKey: String = "agent:main:main"
    var operatorPairingPending: Bool = false
    var nodePairingPending: Bool = false

    var gatewayPairingState: GatewayPairingState {
        switch (self.operatorPairingPending, self.nodePairingPending) {
        case (true, true):
            return .bothPending
        case (true, false):
            return .operatorPending
        case (false, true):
            return .nodePending
        case (false, false):
            return .none
        }
    }

    private let gateway: GatewayOperatorSession
    private let nodeSession: GatewayNodeSession
    private var operatorTask: Task<Void, Never>?
    private var nodeTask: Task<Void, Never>?
    private var voiceWakeSyncTask: Task<Void, Never>?
    private var pairingEventTask: Task<Void, Never>?
    @ObservationIgnored private var cameraHUDDismissTask: Task<Void, Never>?
    let voiceWake = VoiceWakeManager()
    let talkMode = TalkModeManager()
    private let locationService = LocationService()
    private var lastAutoA2uiURL: String?

    var operatorConnected: Bool = false
    var nodeConnected: Bool = false
    var gatewaySession: GatewayOperatorSession { self.gateway }
    var gatewayNodeSession: GatewayNodeSession { self.nodeSession }

    var cameraHUDText: String?
    var cameraHUDKind: CameraHUDKind?
    var cameraFlashNonce: Int = 0
    var screenRecordActive: Bool = false

    init(
        gatewaySession: GatewayOperatorSession = GatewayOperatorSession(),
        nodeSession: GatewayNodeSession = GatewayNodeSession())
    {
        self.gateway = gatewaySession
        self.nodeSession = nodeSession

        self.voiceWake.configure { [weak self] cmd in
            guard let self else { return }
            let sessionKey = await MainActor.run { self.mainSessionKey }
            do {
                try await self.sendVoiceTranscript(text: cmd, sessionKey: sessionKey)
            } catch {
                // Best-effort only.
            }
        }

        let enabled = UserDefaults.standard.bool(forKey: "voiceWake.enabled")
        self.voiceWake.setEnabled(enabled)
        self.talkMode.attachGateway(self.gateway, nodeSession: self.nodeSession)
        let talkEnabled = UserDefaults.standard.bool(forKey: "talk.enabled")
        self.talkMode.setEnabled(talkEnabled)

        // Wire up deep links from canvas taps
        self.screen.onDeepLink = { [weak self] url in
            guard let self else { return }
            Task { @MainActor in
                await self.handleDeepLink(url: url)
            }
        }

        // Wire up A2UI action clicks (buttons, etc.)
        self.screen.onA2UIAction = { [weak self] body in
            guard let self else { return }
            Task { @MainActor in
                await self.handleCanvasA2UIAction(body: body)
            }
        }
    }

    private func handleCanvasA2UIAction(body: [String: Any]) async {
        let userActionAny = body["userAction"] ?? body
        let userAction: [String: Any] = {
            if let dict = userActionAny as? [String: Any] { return dict }
            if let dict = userActionAny as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !userAction.isEmpty else { return }

        guard let name = MoltbotCanvasA2UIAction.extractActionName(userAction) else { return }
        let actionId: String = {
            let id = (userAction["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return id.isEmpty ? UUID().uuidString : id
        }()

        let surfaceId: String = {
            let raw = (userAction["surfaceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? "main" : raw
        }()
        let sourceComponentId: String = {
            let raw = (userAction[
                "sourceComponentId",
            ] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? "-" : raw
        }()

        let host = UserDefaults.standard.string(forKey: "node.displayName") ?? UIDevice.current.name
        let instanceId = (UserDefaults.standard.string(forKey: "node.instanceId") ?? "ios-node").lowercased()
        let contextJSON = MoltbotCanvasA2UIAction.compactJSON(userAction["context"])
        let sessionKey = self.mainSessionKey

        let messageContext = MoltbotCanvasA2UIAction.AgentMessageContext(
            actionName: name,
            session: .init(key: sessionKey, surfaceId: surfaceId),
            component: .init(id: sourceComponentId, host: host, instanceId: instanceId),
            contextJSON: contextJSON)
        let message = MoltbotCanvasA2UIAction.formatAgentMessage(messageContext)

        let ok: Bool
        var errorText: String?
        if await !self.isGatewayConnected() {
            ok = false
            errorText = "gateway not connected"
        } else {
            do {
                try await self.sendAgentRequest(link: AgentDeepLink(
                    message: message,
                    sessionKey: sessionKey,
                    thinking: "low",
                    deliver: false,
                    to: nil,
                    channel: nil,
                    timeoutSeconds: nil,
                    key: actionId))
                ok = true
            } catch {
                ok = false
                errorText = error.localizedDescription
            }
        }

        let js = MoltbotCanvasA2UIAction.jsDispatchA2UIActionStatus(actionId: actionId, ok: ok, error: errorText)
        do {
            _ = try await self.screen.eval(javaScript: js)
        } catch {
            // ignore
        }
    }

    private func resolveA2UIHostURL() async -> String? {
        guard let raw = await self.nodeSession.currentCanvasHostUrl() else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let base = URL(string: trimmed) else { return nil }
        return base.appendingPathComponent("__moltbot__/a2ui/").absoluteString + "?platform=ios"
    }

    private func showA2UIOnConnectIfNeeded() async {
        guard let a2uiUrl = await self.resolveA2UIHostURL() else { return }
        let current = self.screen.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if current.isEmpty || current == self.lastAutoA2uiURL {
            self.screen.navigate(to: a2uiUrl)
            self.lastAutoA2uiURL = a2uiUrl
        }
    }

    private func showLocalCanvasOnDisconnect() {
        self.lastAutoA2uiURL = nil
        self.screen.showDefaultCanvas()
    }

    func setScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background:
            self.isBackgrounded = true
        case .active, .inactive:
            self.isBackgrounded = false
        @unknown default:
            self.isBackgrounded = false
        }
    }

    func setVoiceWakeEnabled(_ enabled: Bool) {
        self.voiceWake.setEnabled(enabled)
    }

    func setTalkEnabled(_ enabled: Bool) {
        self.talkMode.setEnabled(enabled)
    }

    func requestLocationPermissions(mode: MoltbotLocationMode) async -> Bool {
        guard mode != .off else { return true }
        let status = await self.locationService.ensureAuthorization(mode: mode)
        switch status {
        case .authorizedAlways:
            return true
        case .authorizedWhenInUse:
            return mode != .always
        default:
            return false
        }
    }

    func connectToGateway(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        password: String?,
        operatorConnectOptions: GatewayConnectOptions,
        nodeConnectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox? = nil)
    {
        // Cancel any existing connection tasks
        self.operatorTask?.cancel()
        self.nodeTask?.cancel()
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        self.pairingEventTask?.cancel()
        self.pairingEventTask = nil

        // Reset state
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        let id = gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        self.connectedGatewayID = id.isEmpty ? url.absoluteString : id
        self.operatorConnected = false
        self.nodeConnected = false
        self.clearPairingPending()
        self.gatewayStatusText = "Connecting…"

        // Create separate session boxes for operator and node to avoid shared websocket state.
        // Each connection needs its own URLSession/TLS session to prevent response cross-talk.
        func makeSessionBox() -> WebSocketSessionBox? {
            if let sessionBox { return sessionBox }
            if let tls { return WebSocketSessionBox(session: GatewayTLSPinningSession(params: tls)) }
            return nil
        }

        // Start independent connection loops for operator and node
        self.operatorTask = Task { [weak self] in
            await self?.operatorConnectLoop(
                url: url,
                token: token,
                password: password,
                connectOptions: operatorConnectOptions,
                sessionBox: makeSessionBox())
        }

        self.nodeTask = Task { [weak self] in
            await self?.nodeConnectLoop(
                url: url,
                token: token,
                password: password,
                connectOptions: nodeConnectOptions,
                sessionBox: makeSessionBox())
        }
    }

    /// Independent connection loop for the operator session.
    private func operatorConnectLoop(
        url: URL,
        token: String?,
        password: String?,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?)
    async {
        var attempt = 0

        while !Task.isCancelled {
            do {
                try await self.gateway.connect(
                    url: url,
                    token: token,
                    password: password,
                    connectOptions: connectOptions,
                    sessionBox: sessionBox,
                    onConnected: { [weak self] in
                        guard let self else { return }
                        await MainActor.run {
                            self.setPairingPending(for: .operator, pending: false)
                            self.operatorConnected = true
                            self.gatewayServerName = url.host ?? "gateway"
                            self.updateGatewayConnectionStatus()
                        }
                        if let addr = await self.gateway.currentRemoteAddress() {
                            await MainActor.run {
                                self.gatewayRemoteAddress = addr
                            }
                        }
                        await self.refreshBrandingFromGateway()
                        await self.startVoiceWakeSync()
                        await self.startPairingEventSync()
                    },
                    onDisconnected: { [weak self] reason in
                        guard let self else { return }
                        await MainActor.run {
                            self.operatorConnected = false
                            self.gatewayRemoteAddress = nil
                            if !self.nodeConnected {
                                self.gatewayServerName = nil
                                self.showLocalCanvasOnDisconnect()
                            }
                            self.updateGatewayConnectionStatus(reason: reason)
                            self.updatePairingPending(for: .operator, reason: reason)
                        }
                    })

                // Connection succeeded - reset attempt counter and wait before checking again
                attempt = 0
                try? await Task.sleep(nanoseconds: 1_000_000_000)

            } catch {
                if Task.isCancelled { break }
                attempt += 1
                await MainActor.run {
                    self.updatePairingPending(for: .operator, reason: error.localizedDescription)
                    self.operatorConnected = false
                    self.updateGatewayConnectionStatus(reason: error.localizedDescription)
                }

                // Exponential backoff
                let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(attempt)))
                try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
            }
        }

        // Cleanup on task cancellation
        await self.gateway.disconnect()
        await MainActor.run {
            self.operatorConnected = false
            self.setPairingPending(for: .operator, pending: false)
            self.updateGatewayConnectionStatus()
        }
    }

    /// Independent connection loop for the node session.
    private func nodeConnectLoop(
        url: URL,
        token: String?,
        password: String?,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?)
    async {
        var attempt = 0

        while !Task.isCancelled {
            do {
                try await self.nodeSession.connect(
                    url: url,
                    token: token,
                    password: password,
                    connectOptions: connectOptions,
                    sessionBox: sessionBox,
                    onConnected: { [weak self] in
                        guard let self else { return }
                        await MainActor.run {
                            self.setPairingPending(for: .node, pending: false)
                            self.nodeConnected = true
                            if self.gatewayServerName == nil {
                                self.gatewayServerName = url.host ?? "gateway"
                            }
                            self.updateGatewayConnectionStatus()
                        }
                        await self.showA2UIOnConnectIfNeeded()
                    },
                    onDisconnected: { [weak self] reason in
                        guard let self else { return }
                        await MainActor.run {
                            self.nodeConnected = false
                            if !self.operatorConnected {
                                self.gatewayServerName = nil
                                self.showLocalCanvasOnDisconnect()
                            }
                            self.updateGatewayConnectionStatus(reason: reason)
                        }
                    },
                    onInvoke: { [weak self] req in
                        guard let self else {
                            return BridgeInvokeResponse(
                                id: req.id,
                                ok: false,
                                error: MoltbotNodeError(
                                    code: .unavailable,
                                    message: "UNAVAILABLE: node not ready"))
                        }
                        return await self.handleInvoke(req)
                    })

                // Connection succeeded - reset attempt counter and wait before checking again
                attempt = 0
                try? await Task.sleep(nanoseconds: 1_000_000_000)

            } catch {
                if Task.isCancelled { break }
                attempt += 1
                await MainActor.run {
                    self.updatePairingPending(for: .node, reason: error.localizedDescription)
                    self.nodeConnected = false
                    self.updateGatewayConnectionStatus(reason: error.localizedDescription)
                }

                // Exponential backoff
                let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(attempt)))
                try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
            }
        }

        // Cleanup on task cancellation
        await self.nodeSession.disconnect()
        await MainActor.run {
            self.nodeConnected = false
            self.setPairingPending(for: .node, pending: false)
            self.updateGatewayConnectionStatus()
        }
    }

    private func updateGatewayConnectionStatus(reason: String? = nil) {
        let trimmedReason = (reason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        switch (self.operatorConnected, self.nodeConnected) {
        case (true, true):
            self.gatewayStatusText = "Connected (operator + node)"
        case (true, false):
            self.gatewayStatusText = "Connected (operator only)"
        case (false, true):
            self.gatewayStatusText = "Connected (node only)"
        case (false, false):
            if trimmedReason.isEmpty {
                self.gatewayStatusText = "Disconnected"
            } else {
                self.gatewayStatusText = "Disconnected: \(trimmedReason)"
            }
        }
    }

    private func setPairingPending(for role: ConnectionRole, pending: Bool) {
        switch role {
        case .operator:
            self.operatorPairingPending = pending
        case .node:
            self.nodePairingPending = pending
        }
    }

    private func clearPairingPending() {
        self.operatorPairingPending = false
        self.nodePairingPending = false
    }

    private func updatePairingPending(for role: ConnectionRole, reason: String) {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            self.setPairingPending(for: role, pending: false)
            return
        }
        let lower = trimmed.lowercased()
        let pending = lower.contains("pairing") || lower.contains("approval")
        self.setPairingPending(for: role, pending: pending)
    }

    private func startPairingEventSync() async {
        self.pairingEventTask?.cancel()
        let myDeviceId = DeviceIdentityStore.loadOrCreate().deviceId
        self.pairingEventTask = Task { [weak self] in
            guard let self else { return }
            let stream = await self.gateway.subscribeServerEvents(bufferingNewest: 200)
            for await evt in stream {
                if Task.isCancelled { return }
                await self.handlePairingEvent(evt, myDeviceId: myDeviceId)
            }
        }
    }

    private func handlePairingEvent(_ evt: EventFrame, myDeviceId: String) async {
        // Handle device.pair.requested: set pairing pending for the role
        // Handle device.pair.resolved: clear pairing pending for the role
        switch evt.event {
        case "device.pair.requested":
            guard let payload = evt.payload else { return }
            struct RequestedPayload: Decodable {
                var deviceId: String
                var role: String?
            }
            guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: RequestedPayload.self) else { return }
            guard decoded.deviceId == myDeviceId else { return }
            let role = self.parsePairingRole(decoded.role)
            await MainActor.run {
                self.setPairingPendingFromEvent(role: role, pending: true)
            }
        case "device.pair.resolved":
            guard let payload = evt.payload else { return }
            struct ResolvedPayload: Decodable {
                var deviceId: String
                var decision: String?
            }
            guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: ResolvedPayload.self) else { return }
            guard decoded.deviceId == myDeviceId else { return }
            // On resolution (approved or rejected), clear the pending state.
            // The role isn't always in resolved events, so clear both for this device.
            await MainActor.run {
                self.operatorPairingPending = false
                self.nodePairingPending = false
            }
        default:
            break
        }
    }

    private func parsePairingRole(_ roleString: String?) -> ConnectionRole? {
        guard let role = roleString?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else {
            return nil
        }
        switch role {
        case "operator": return .operator
        case "node": return .node
        default: return nil
        }
    }

    private func setPairingPendingFromEvent(role: ConnectionRole?, pending: Bool) {
        // If role is known, set just that role. Otherwise set both.
        switch role {
        case .operator:
            self.operatorPairingPending = pending
        case .node:
            self.nodePairingPending = pending
        case nil:
            self.operatorPairingPending = pending
            self.nodePairingPending = pending
        }
    }

    func disconnectGateway() {
        self.operatorTask?.cancel()
        self.operatorTask = nil
        self.nodeTask?.cancel()
        self.nodeTask = nil
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        self.pairingEventTask?.cancel()
        self.pairingEventTask = nil
        Task {
            await self.gateway.disconnect()
            await self.nodeSession.disconnect()
        }
        self.gatewayStatusText = "Offline"
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = nil
        self.operatorConnected = false
        self.nodeConnected = false
        self.clearPairingPending()
        self.seamColorHex = nil
        if !SessionKey.isCanonicalMainSessionKey(self.mainSessionKey) {
            self.mainSessionKey = "main"
            self.talkMode.updateMainSessionKey(self.mainSessionKey)
        }
        self.showLocalCanvasOnDisconnect()
    }

    private func applyMainSessionKey(_ key: String?) {
        let trimmed = (key ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let current = self.mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if SessionKey.isCanonicalMainSessionKey(current) { return }
        if trimmed == current { return }
        self.mainSessionKey = trimmed
        self.talkMode.updateMainSessionKey(trimmed)
    }

    var seamColor: Color {
        Self.color(fromHex: self.seamColorHex) ?? Self.defaultSeamColor
    }

    private static let defaultSeamColor = Color(red: 79 / 255.0, green: 122 / 255.0, blue: 154 / 255.0)

    private static func color(fromHex raw: String?) -> Color? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hex = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
    }

    private func refreshBrandingFromGateway() async {
        do {
            let res = try await self.gateway.request(method: "config.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return }
            guard let config = json["config"] as? [String: Any] else { return }
            let ui = config["ui"] as? [String: Any]
            let raw = (ui?["seamColor"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let session = config["session"] as? [String: Any]
            let mainKey = SessionKey.normalizeMainKey(session?["mainKey"] as? String)
            await MainActor.run {
                self.seamColorHex = raw.isEmpty ? nil : raw
                if !SessionKey.isCanonicalMainSessionKey(self.mainSessionKey) {
                    self.mainSessionKey = mainKey
                    self.talkMode.updateMainSessionKey(mainKey)
                }
            }
        } catch {
            // ignore
        }
    }

    func setGlobalWakeWords(_ words: [String]) async {
        let sanitized = VoiceWakePreferences.sanitizeTriggerWords(words)

        struct Payload: Codable {
            var triggers: [String]
        }
        let payload = Payload(triggers: sanitized)
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else { return }

        do {
            _ = try await self.gateway.request(method: "voicewake.set", paramsJSON: json, timeoutSeconds: 12)
        } catch {
            // Best-effort only.
        }
    }

    private func startVoiceWakeSync() async {
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = Task { [weak self] in
            guard let self else { return }

            await self.refreshWakeWordsFromGateway()

            let stream = await self.gateway.subscribeServerEvents(bufferingNewest: 200)
            for await evt in stream {
                if Task.isCancelled { return }
                guard evt.event == "voicewake.changed" else { continue }
                guard let payload = evt.payload else { continue }
                struct Payload: Decodable { var triggers: [String] }
                guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: Payload.self) else { continue }
                let triggers = VoiceWakePreferences.sanitizeTriggerWords(decoded.triggers)
                VoiceWakePreferences.saveTriggerWords(triggers)
            }
        }
    }

    private func refreshWakeWordsFromGateway() async {
        do {
            let data = try await self.gateway.request(method: "voicewake.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: data) else { return }
            VoiceWakePreferences.saveTriggerWords(triggers)
        } catch {
            // Best-effort only.
        }
    }

    func sendVoiceTranscript(text: String, sessionKey: String?) async throws {
        if await !self.isGatewayConnected() {
            throw NSError(domain: "Gateway", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "Gateway not connected",
            ])
        }
        struct Payload: Codable {
            var text: String
            var sessionKey: String?
        }
        let payload = Payload(text: text, sessionKey: sessionKey)
        let data = try JSONEncoder().encode(payload)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode voice transcript payload as UTF-8",
            ])
        }
        await self.nodeSession.sendEvent(event: "voice.transcript", payloadJSON: json)
    }

    func handleDeepLink(url: URL) async {
        guard let route = DeepLinkParser.parse(url) else { return }

        switch route {
        case let .agent(link):
            await self.handleAgentDeepLink(link, originalURL: url)
        }
    }

    private func handleAgentDeepLink(_ link: AgentDeepLink, originalURL: URL) async {
        let message = link.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }

        if message.count > 20000 {
            self.screen.errorText = "Deep link too large (message exceeds 20,000 characters)."
            return
        }

        guard await self.isGatewayConnected() else {
            self.screen.errorText = "Gateway not connected (cannot forward deep link)."
            return
        }

        do {
            try await self.sendAgentRequest(link: link)
            self.screen.errorText = nil
        } catch {
            self.screen.errorText = "Agent request failed: \(error.localizedDescription)"
        }
    }

    private func sendAgentRequest(link: AgentDeepLink) async throws {
        if link.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NSError(domain: "DeepLink", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "invalid agent message",
            ])
        }

        // iOS gateway forwards to the gateway; no local auth prompts here.
        // (Key-based unattended auth is handled on macOS for moltbot:// links.)
        let data = try JSONEncoder().encode(link)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode agent request payload as UTF-8",
            ])
        }
        await self.nodeSession.sendEvent(event: "agent.request", payloadJSON: json)
    }

    private func isGatewayConnected() async -> Bool {
        self.operatorConnected
    }

    private func handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        let command = req.command

        if self.isBackgrounded, self.isBackgroundRestricted(command) {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(
                    code: .backgroundUnavailable,
                    message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground"))
        }

        if command.hasPrefix("camera."), !self.isCameraEnabled() {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(
                    code: .unavailable,
                    message: "CAMERA_DISABLED: enable Camera in iOS Settings → Camera → Allow Camera"))
        }

        do {
            switch command {
            case MoltbotLocationCommand.get.rawValue:
                return try await self.handleLocationInvoke(req)
            case MoltbotCanvasCommand.present.rawValue,
                 MoltbotCanvasCommand.hide.rawValue,
                 MoltbotCanvasCommand.navigate.rawValue,
                 MoltbotCanvasCommand.evalJS.rawValue,
                 MoltbotCanvasCommand.snapshot.rawValue:
                return try await self.handleCanvasInvoke(req)
            case MoltbotCanvasA2UICommand.reset.rawValue,
                 MoltbotCanvasA2UICommand.push.rawValue,
                 MoltbotCanvasA2UICommand.pushJSONL.rawValue:
                return try await self.handleCanvasA2UIInvoke(req)
            case MoltbotCameraCommand.list.rawValue,
                 MoltbotCameraCommand.snap.rawValue,
                 MoltbotCameraCommand.clip.rawValue:
                return try await self.handleCameraInvoke(req)
            case MoltbotScreenCommand.record.rawValue:
                return try await self.handleScreenRecordInvoke(req)
            default:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: MoltbotNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
            }
        } catch {
            if command.hasPrefix("camera.") {
                let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.showCameraHUD(text: text, kind: .error, autoHideSeconds: 2.2)
            }
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(code: .unavailable, message: error.localizedDescription))
        }
    }

    private func isBackgroundRestricted(_ command: String) -> Bool {
        command.hasPrefix("canvas.") || command.hasPrefix("camera.") || command.hasPrefix("screen.")
    }

    private func handleLocationInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let mode = self.locationMode()
        guard mode != .off else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(
                    code: .unavailable,
                    message: "LOCATION_DISABLED: enable Location in Settings"))
        }
        if self.isBackgrounded, mode != .always {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(
                    code: .backgroundUnavailable,
                    message: "LOCATION_BACKGROUND_UNAVAILABLE: background location requires Always"))
        }
        let params = (try? Self.decodeParams(MoltbotLocationGetParams.self, from: req.paramsJSON)) ??
            MoltbotLocationGetParams()
        let desired = params.desiredAccuracy ??
            (self.isLocationPreciseEnabled() ? .precise : .balanced)
        let status = self.locationService.authorizationStatus()
        if status != .authorizedAlways, status != .authorizedWhenInUse {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: grant Location permission"))
        }
        if self.isBackgrounded, status != .authorizedAlways {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: enable Always for background access"))
        }
        let location = try await self.locationService.currentLocation(
            params: params,
            desiredAccuracy: desired,
            maxAgeMs: params.maxAgeMs,
            timeoutMs: params.timeoutMs)
        let isPrecise = self.locationService.accuracyAuthorization() == .fullAccuracy
        let payload = MoltbotLocationPayload(
            lat: location.coordinate.latitude,
            lon: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy,
            altitudeMeters: location.verticalAccuracy >= 0 ? location.altitude : nil,
            speedMps: location.speed >= 0 ? location.speed : nil,
            headingDeg: location.course >= 0 ? location.course : nil,
            timestamp: ISO8601DateFormatter().string(from: location.timestamp),
            isPrecise: isPrecise,
            source: nil)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleCanvasInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case MoltbotCanvasCommand.present.rawValue:
            let params = (try? Self.decodeParams(MoltbotCanvasPresentParams.self, from: req.paramsJSON)) ??
                MoltbotCanvasPresentParams()
            let url = params.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if url.isEmpty {
                self.screen.showDefaultCanvas()
            } else {
                self.screen.navigate(to: url)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case MoltbotCanvasCommand.hide.rawValue:
            return BridgeInvokeResponse(id: req.id, ok: true)
        case MoltbotCanvasCommand.navigate.rawValue:
            let params = try Self.decodeParams(MoltbotCanvasNavigateParams.self, from: req.paramsJSON)
            self.screen.navigate(to: params.url)
            return BridgeInvokeResponse(id: req.id, ok: true)
        case MoltbotCanvasCommand.evalJS.rawValue:
            let params = try Self.decodeParams(MoltbotCanvasEvalParams.self, from: req.paramsJSON)
            let result = try await self.screen.eval(javaScript: params.javaScript)
            let payload = try Self.encodePayload(["result": result])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case MoltbotCanvasCommand.snapshot.rawValue:
            let params = try? Self.decodeParams(MoltbotCanvasSnapshotParams.self, from: req.paramsJSON)
            let format = params?.format ?? .jpeg
            let maxWidth: CGFloat? = {
                if let raw = params?.maxWidth, raw > 0 { return CGFloat(raw) }
                // Keep default snapshots comfortably below the gateway client's maxPayload.
                // For full-res, clients should explicitly request a larger maxWidth.
                return switch format {
                case .png: 900
                case .jpeg: 1600
                }
            }()
            let base64 = try await self.screen.snapshotBase64(
                maxWidth: maxWidth,
                format: format,
                quality: params?.quality)
            let payload = try Self.encodePayload([
                "format": format == .jpeg ? "jpeg" : "png",
                "base64": base64,
            ])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCanvasA2UIInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let command = req.command
        switch command {
        case MoltbotCanvasA2UICommand.reset.rawValue:
            guard let a2uiUrl = await self.resolveA2UIHostURL() else {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: MoltbotNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host"))
            }
            self.screen.navigate(to: a2uiUrl)
            if await !self.screen.waitForA2UIReady(timeoutMs: 5000) {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: MoltbotNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable"))
            }

            let json = try await self.screen.eval(javaScript: """
            (() => {
              if (!globalThis.clawdbotA2UI) return JSON.stringify({ ok: false, error: "missing moltbotA2UI" });
              return JSON.stringify(globalThis.clawdbotA2UI.reset());
            })()
            """)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case MoltbotCanvasA2UICommand.push.rawValue, MoltbotCanvasA2UICommand.pushJSONL.rawValue:
            let messages: [MoltbotKit.AnyCodable]
            if command == MoltbotCanvasA2UICommand.pushJSONL.rawValue {
                let params = try Self.decodeParams(MoltbotCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                messages = try MoltbotCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
            } else {
                do {
                    let params = try Self.decodeParams(MoltbotCanvasA2UIPushParams.self, from: req.paramsJSON)
                    messages = params.messages
                } catch {
                    // Be forgiving: some clients still send JSONL payloads to `canvas.a2ui.push`.
                    let params = try Self.decodeParams(MoltbotCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                    messages = try MoltbotCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
                }
            }

            guard let a2uiUrl = await self.resolveA2UIHostURL() else {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: MoltbotNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host"))
            }
            self.screen.navigate(to: a2uiUrl)
            if await !self.screen.waitForA2UIReady(timeoutMs: 5000) {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: MoltbotNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable"))
            }

            let messagesJSON = try MoltbotCanvasA2UIJSONL.encodeMessagesJSONArray(messages)
            let js = """
            (() => {
              try {
                if (!globalThis.clawdbotA2UI) return JSON.stringify({ ok: false, error: "missing moltbotA2UI" });
                const messages = \(messagesJSON);
                return JSON.stringify(globalThis.clawdbotA2UI.applyMessages(messages));
              } catch (e) {
                return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
              }
            })()
            """
            let resultJSON = try await self.screen.eval(javaScript: js)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: resultJSON)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCameraInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case MoltbotCameraCommand.list.rawValue:
            let devices = await self.camera.listDevices()
            struct Payload: Codable {
                var devices: [CameraController.CameraDeviceInfo]
            }
            let payload = try Self.encodePayload(Payload(devices: devices))
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case MoltbotCameraCommand.snap.rawValue:
            self.showCameraHUD(text: "Taking photo…", kind: .photo)
            self.triggerCameraFlash()
            let params = (try? Self.decodeParams(MoltbotCameraSnapParams.self, from: req.paramsJSON)) ??
                MoltbotCameraSnapParams()
            let res = try await self.camera.snap(params: params)

            struct Payload: Codable {
                var format: String
                var base64: String
                var width: Int
                var height: Int
            }
            let payload = try Self.encodePayload(Payload(
                format: res.format,
                base64: res.base64,
                width: res.width,
                height: res.height))
            self.showCameraHUD(text: "Photo captured", kind: .success, autoHideSeconds: 1.6)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case MoltbotCameraCommand.clip.rawValue:
            let params = (try? Self.decodeParams(MoltbotCameraClipParams.self, from: req.paramsJSON)) ??
                MoltbotCameraClipParams()

            let suspended = (params.includeAudio ?? true) ? self.voiceWake.suspendForExternalAudioCapture() : false
            defer { self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: suspended) }

            self.showCameraHUD(text: "Recording…", kind: .recording)
            let res = try await self.camera.clip(params: params)

            struct Payload: Codable {
                var format: String
                var base64: String
                var durationMs: Int
                var hasAudio: Bool
            }
            let payload = try Self.encodePayload(Payload(
                format: res.format,
                base64: res.base64,
                durationMs: res.durationMs,
                hasAudio: res.hasAudio))
            self.showCameraHUD(text: "Clip captured", kind: .success, autoHideSeconds: 1.8)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: MoltbotNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleScreenRecordInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = (try? Self.decodeParams(MoltbotScreenRecordParams.self, from: req.paramsJSON)) ??
            MoltbotScreenRecordParams()
        if let format = params.format, format.lowercased() != "mp4" {
            throw NSError(domain: "Screen", code: 30, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: screen format must be mp4",
            ])
        }
        // Status pill mirrors screen recording state so it stays visible without overlay stacking.
        self.screenRecordActive = true
        defer { self.screenRecordActive = false }
        let path = try await self.screenRecorder.record(
            screenIndex: params.screenIndex,
            durationMs: params.durationMs,
            fps: params.fps,
            includeAudio: params.includeAudio,
            outPath: nil)
        defer { try? FileManager().removeItem(atPath: path) }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        struct Payload: Codable {
            var format: String
            var base64: String
            var durationMs: Int?
            var fps: Double?
            var screenIndex: Int?
            var hasAudio: Bool
        }
        let payload = try Self.encodePayload(Payload(
            format: "mp4",
            base64: data.base64EncodedString(),
            durationMs: params.durationMs,
            fps: params.fps,
            screenIndex: params.screenIndex,
            hasAudio: params.includeAudio ?? true))
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

}

private extension NodeAppModel {
    func locationMode() -> MoltbotLocationMode {
        let raw = UserDefaults.standard.string(forKey: "location.enabledMode") ?? "off"
        return MoltbotLocationMode(rawValue: raw) ?? .off
    }

    func isLocationPreciseEnabled() -> Bool {
        if UserDefaults.standard.object(forKey: "location.preciseEnabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "location.preciseEnabled")
    }

    static func decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        guard let json, let data = json.data(using: .utf8) else {
            throw NSError(domain: "Gateway", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(type, from: data)
    }

    static func encodePayload(_ obj: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(obj)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode payload as UTF-8",
            ])
        }
        return json
    }

    func isCameraEnabled() -> Bool {
        // Default-on: if the key doesn't exist yet, treat it as enabled.
        if UserDefaults.standard.object(forKey: "camera.enabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "camera.enabled")
    }

    func triggerCameraFlash() {
        self.cameraFlashNonce &+= 1
    }

    func showCameraHUD(text: String, kind: CameraHUDKind, autoHideSeconds: Double? = nil) {
        self.cameraHUDDismissTask?.cancel()

        withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
            self.cameraHUDText = text
            self.cameraHUDKind = kind
        }

        guard let autoHideSeconds else { return }
        self.cameraHUDDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(autoHideSeconds * 1_000_000_000))
            withAnimation(.easeOut(duration: 0.25)) {
                self.cameraHUDText = nil
                self.cameraHUDKind = nil
            }
        }
    }
}

#if DEBUG
extension NodeAppModel {
    func _test_handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        await self.handleInvoke(req)
    }

    static func _test_decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        try self.decodeParams(type, from: json)
    }

    static func _test_encodePayload(_ obj: some Encodable) throws -> String {
        try self.encodePayload(obj)
    }

    func _test_isCameraEnabled() -> Bool {
        self.isCameraEnabled()
    }

    func _test_triggerCameraFlash() {
        self.triggerCameraFlash()
    }

    func _test_showCameraHUD(text: String, kind: CameraHUDKind, autoHideSeconds: Double? = nil) {
        self.showCameraHUD(text: text, kind: kind, autoHideSeconds: autoHideSeconds)
    }

    func _test_handleCanvasA2UIAction(body: [String: Any]) async {
        await self.handleCanvasA2UIAction(body: body)
    }

    func _test_resolveA2UIHostURL() async -> String? {
        await self.resolveA2UIHostURL()
    }

    func _test_showLocalCanvasOnDisconnect() {
        self.showLocalCanvasOnDisconnect()
    }

    func _test_setPairingPending(role: ConnectionRole, pending: Bool) {
        self.setPairingPending(for: role, pending: pending)
    }

    func _test_clearPairingPending() {
        self.clearPairingPending()
    }

    func _test_updatePairingPending(role: ConnectionRole, reason: String) {
        self.updatePairingPending(for: role, reason: reason)
    }

    func _test_handlePairingEvent(_ evt: EventFrame, myDeviceId: String) async {
        await self.handlePairingEvent(evt, myDeviceId: myDeviceId)
    }
}
#endif
