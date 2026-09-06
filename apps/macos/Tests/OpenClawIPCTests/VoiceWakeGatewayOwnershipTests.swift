import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension VoiceWakeGlobalSettingsSyncTests {
    @Test(arguments: [false, true])
    func `new primary connection reloads its current voice wake triggers`(switchGateway: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let previous = AppStateStore.shared.swabbleTriggerWords
            defer { AppStateStore.shared.applyGlobalVoiceWakeTriggers(previous) }
            let port = LockIsolated(49260)
            let triggers = LockIsolated("gateway-a")
            let session = GatewayTestWebSocketSession {
                GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                    guard sendIndex > 0 else { return }
                    let data: Data
                    switch message {
                    case let .data(value): data = value
                    case let .string(value): data = Data(value.utf8)
                    @unknown default: return
                    }
                    guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let id = frame["id"] as? String,
                          let method = frame["method"] as? String
                    else { return }
                    let payload: String
                    if method == "voicewake.get" {
                        let value = triggers.value
                        payload = #"{"triggers":["\#(value)"]}"#
                    } else {
                        payload = #"{"ok":true}"#
                    }
                    let response = #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#
                    socket.emitReceiveSuccess(.data(Data(response.utf8)))
                })
            }
            let gateway = GatewayConnection(
                configProvider: {
                    (url: URL(string: "ws://127.0.0.1:\(port.value)")!, token: nil, password: nil)
                },
                sessionBox: WebSocketSessionBox(session: session))
            let sync = VoiceWakeGlobalSettingsSync(gateway: gateway)
            sync.start()
            do {
                try await self.waitUntil { AppStateStore.shared.swabbleTriggerWords == ["gateway-a"] }
                await gateway.shutdown()
                if switchGateway { port.setValue(49261) }
                triggers.setValue("gateway-b")
                _ = try await gateway.acquireServerLease()
                try await self.waitUntil { AppStateStore.shared.swabbleTriggerWords == ["gateway-b"] }
            } catch {
                sync.stop()
                await gateway.shutdown()
                throw error
            }
            sync.stop()
            await gateway.shutdown()
        }
    }

    private func waitUntil(_ predicate: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !predicate(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        try #require(predicate())
    }
}
