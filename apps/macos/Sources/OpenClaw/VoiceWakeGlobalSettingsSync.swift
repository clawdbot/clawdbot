import Foundation
import OpenClawKit
import OSLog

@MainActor
final class VoiceWakeGlobalSettingsSync {
    static let shared = VoiceWakeGlobalSettingsSync()

    private let logger = Logger(subsystem: "ai.openclaw", category: "voicewake.sync")
    private let gateway: GatewayConnection
    private var task: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?

    private struct VoiceWakePayload: Codable, Equatable {
        let triggers: [String]
    }

    init(gateway: GatewayConnection = .shared) {
        self.gateway = gateway
    }

    func start() {
        SimpleTaskSupport.start(task: &self.task) { @MainActor [weak self] in
            guard let self else { return }
            _ = try? await self.gateway.acquireServerLease()
            await GatewayPushSubscription
                .consume(connection: self.gateway, bufferingNewest: 200) { [weak self] delivery in
                    guard let self, delivery.isCurrent, let push = delivery.push else { return }
                    switch push {
                    case .snapshot, .seqGap:
                        self.refreshTask?.cancel()
                        self.refreshTask = Task { await self.refreshFromGateway(delivery: delivery) }
                    case let .event(event) where event.event == "voicewake.changed":
                        self.handle(push: push)
                    default:
                        break
                    }
                }
        }
    }

    func stop() {
        SimpleTaskSupport.stop(task: &self.task)
        SimpleTaskSupport.stop(task: &self.refreshTask)
    }

    private func refreshFromGateway(delivery: GatewayConnection.PushDelivery) async {
        do {
            let data = try await self.gateway.request(
                method: GatewayConnection.Method.voicewakeGet.rawValue,
                params: nil,
                ifCurrentServerLease: delivery.serverLease)
            guard !Task.isCancelled, delivery.isCurrent else { return }
            let payload = try JSONDecoder().decode(VoiceWakePayload.self, from: data)
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(payload.triggers)
        } catch {
            // Best-effort only.
        }
    }

    func handle(push: GatewayPush) {
        guard case let .event(evt) = push else { return }
        guard evt.event == "voicewake.changed" else { return }
        guard let payload = evt.payload else { return }
        do {
            let decoded = try GatewayPayloadDecoding.decode(payload, as: VoiceWakePayload.self)
            // A valid live update is newer than any snapshot read already in flight.
            self.refreshTask?.cancel()
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(decoded.triggers)
        } catch {
            self.logger.error("failed to decode voicewake.changed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
