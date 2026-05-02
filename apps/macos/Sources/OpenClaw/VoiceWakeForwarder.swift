import Foundation
import OSLog

enum VoiceWakeForwarder {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "voicewake.forward")

    static func prefixedTranscript(_ transcript: String, machineName: String? = nil) -> String {
        let resolvedMachine = machineName
            .flatMap { name -> String? in
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            ?? Host.current().localizedName
            ?? ProcessInfo.processInfo.hostName

        let safeMachine = resolvedMachine.isEmpty ? "this Mac" : resolvedMachine
        return """
        User talked via voice recognition on \(safeMachine) - repeat prompt first \
        + remember some words might be incorrectly transcribed.

        \(transcript)
        """
    }

    enum VoiceWakeForwardError: LocalizedError, Equatable {
        case rpcFailed(String)

        var errorDescription: String? {
            switch self {
            case let .rpcFailed(message): message
            }
        }
    }

    struct ForwardOptions {
        var sessionKey: String = "main"
        var thinking: String = "low"
        var deliver: Bool = true
        var to: String?
        var channel: GatewayAgentChannel = .webchat
        var voiceWakeTrigger: String?
    }

    private struct SessionListResponse: Decodable {
        let sessions: [SessionRouteEntry]
    }

    struct SessionRouteEntry: Decodable, Equatable {
        let key: String
        let channel: String?
        let lastChannel: String?
        let lastTo: String?
        let deliveryContext: DeliveryContext?
    }

    struct DeliveryContext: Decodable, Equatable {
        let channel: String?
        let to: String?
    }

    static func selectedSessionOptions(voiceWakeTrigger: String? = nil) async -> ForwardOptions {
        let activeSessionKey = await MainActor.run { WebChatManager.shared.activeSessionKey }
        let sessionKey: String = if let activeSessionKey = activeSessionKey?.trimmingCharacters(
            in: .whitespacesAndNewlines),
            !activeSessionKey.isEmpty
        {
            activeSessionKey
        } else {
            await GatewayConnection.shared.mainSessionKey()
        }

        let routeEntry = await self.loadSessionRouteEntry(sessionKey: sessionKey)
        return self.forwardOptions(
            sessionKey: sessionKey,
            routeEntry: routeEntry,
            voiceWakeTrigger: voiceWakeTrigger)
    }

    static func forwardOptions(
        sessionKey: String,
        routeEntry: SessionRouteEntry?,
        voiceWakeTrigger: String? = nil) -> ForwardOptions
    {
        let parsedRoute = self.parseSessionKeyRoute(sessionKey)
        let channelRaw = self.firstNonEmpty(
            routeEntry?.deliveryContext?.channel,
            routeEntry?.lastChannel,
            routeEntry?.channel,
            parsedRoute?.channel)
        let channel = channelRaw
            .flatMap { GatewayAgentChannel(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }
            ?? .webchat
        let to = self.firstNonEmpty(
            routeEntry?.deliveryContext?.to,
            routeEntry?.lastTo,
            parsedRoute?.to)

        return ForwardOptions(
            sessionKey: sessionKey,
            thinking: "low",
            deliver: true,
            to: to,
            channel: channel,
            voiceWakeTrigger: voiceWakeTrigger)
    }

    @discardableResult
    static func forwardToSelectedSession(
        transcript: String,
        voiceWakeTrigger: String? = nil) async -> Result<Void, VoiceWakeForwardError>
    {
        let options = await self.selectedSessionOptions(voiceWakeTrigger: voiceWakeTrigger)
        return await self.forward(transcript: transcript, options: options)
    }

    @discardableResult
    static func forward(
        transcript: String,
        options: ForwardOptions = ForwardOptions()) async -> Result<Void, VoiceWakeForwardError>
    {
        let payload = Self.prefixedTranscript(transcript)
        let deliver = options.channel.shouldDeliver(options.deliver)
        let result = await GatewayConnection.shared.sendAgent(GatewayAgentInvocation(
            message: payload,
            sessionKey: options.sessionKey,
            thinking: options.thinking,
            deliver: deliver,
            to: options.to,
            channel: options.channel,
            voiceWakeTrigger: options.voiceWakeTrigger))

        if result.ok {
            self.logger.info("voice wake forward ok")
            return .success(())
        }

        let message = result.error ?? "agent rpc unavailable"
        self.logger.error("voice wake forward failed: \(message, privacy: .public)")
        return .failure(.rpcFailed(message))
    }

    static func checkConnection() async -> Result<Void, VoiceWakeForwardError> {
        let status = await GatewayConnection.shared.status()
        if status.ok { return .success(()) }
        return .failure(.rpcFailed(status.error ?? "agent rpc unreachable"))
    }

    private static func loadSessionRouteEntry(sessionKey: String) async -> SessionRouteEntry? {
        do {
            let data = try await GatewayConnection.shared.request(
                method: "sessions.list",
                params: [
                    "includeGlobal": AnyCodable(false),
                    "includeUnknown": AnyCodable(false),
                    "limit": AnyCodable(500),
                ],
                timeoutMs: 10000)
            let response = try JSONDecoder().decode(SessionListResponse.self, from: data)
            return response.sessions.first {
                $0.key.trimmingCharacters(in: .whitespacesAndNewlines)
                    .caseInsensitiveCompare(sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame
            }
        } catch {
            self.logger.debug(
                "voice wake selected route lookup failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private static func parseSessionKeyRoute(_ sessionKey: String) -> (channel: String, to: String?)? {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let rawParts = trimmed.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
        let body: [String] = if rawParts.count >= 3, rawParts[0].caseInsensitiveCompare("agent") == .orderedSame {
            Array(rawParts.dropFirst(2))
        } else {
            rawParts
        }
        guard body.count >= 3 else { return nil }
        let kind = body[1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard kind == "direct" || kind == "group" || kind == "channel" else { return nil }
        let channel = body[0].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !channel.isEmpty else { return nil }
        let to = body.dropFirst(2)
            .joined(separator: ":")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (channel: channel, to: to.isEmpty ? nil : to)
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        for value in values {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let trimmed, !trimmed.isEmpty {
                return trimmed
            }
        }
        return nil
    }
}
