import Foundation
import OSLog

enum VoiceWakeForwarder {
    private static let logger = Logger(subsystem: "bot.molt", category: "voicewake.forward")

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

    struct ForwardOptions: Sendable {
        var sessionKey: String = "main"
        var thinking: String = "low"
        var deliver: Bool = true
        var to: String?
        var channel: GatewayAgentChannel = .last
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
            channel: options.channel))

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
}
