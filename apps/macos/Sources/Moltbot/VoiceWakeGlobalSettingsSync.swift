import MoltbotKit
import Foundation
import OSLog

@MainActor
final class VoiceWakeGlobalSettingsSync {
    static let shared = VoiceWakeGlobalSettingsSync()

    private let logger = Logger(subsystem: "bot.molt", category: "voicewake.sync")
    private var task: Task<Void, Never>?

    private struct VoiceWakePayload: Codable, Equatable {
        let triggers: [String]
    }

    func start() {
        guard self.task == nil else { return }
        self.task = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    try await GatewayConnection.shared.refresh()
                } catch {
                    // Not configured / not reachable yet.
                }

                await self.refreshFromGateway()

                let stream = await GatewayConnection.shared.subscribe(bufferingNewest: 200)
                for await push in stream {
                    if Task.isCancelled { return }
                    await self.handle(push: push)
                }

                // If the stream finishes (gateway shutdown / reconnect), loop and resubscribe.
                try? await Task.sleep(nanoseconds: 600_000_000)
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
    }

    private func refreshFromGateway() async {
        do {
            let triggers = try await GatewayConnection.shared.voiceWakeGetTriggers()
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(triggers)
        } catch {
            // Best-effort only.
        }
    }

    func handle(push: GatewayPush) async {
        guard case let .event(evt) = push else { return }
        guard evt.event == "voicewake.changed" else { return }
        guard let payload = evt.payload else { return }
        do {
            let decoded = try GatewayPayloadDecoding.decode(payload, as: VoiceWakePayload.self)
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(decoded.triggers)
        } catch {
            self.logger.error("failed to decode voicewake.changed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
