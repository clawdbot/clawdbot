import Foundation
import Testing
@testable import Moltbot

@Suite struct HealthStoreStateTests {
    @Test @MainActor func linkedChannelProbeFailureDegradesState() async throws {
        let snap = HealthSnapshot(
            ok: true,
            ts: 0,
            durationMs: 1,
            channels: [
                "whatsapp": .init(
                    configured: true,
                    linked: true,
                    authAgeMs: 1,
                    probe: .init(
                        ok: false,
                        status: 503,
                        error: "gateway connect failed",
                        elapsedMs: 12,
                        bot: nil,
                        webhook: nil),
                    lastProbeAt: 0),
            ],
            channelOrder: ["whatsapp"],
            channelLabels: ["whatsapp": "WhatsApp"],
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: []))

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        switch store.state {
        case let .degraded(message):
            #expect(!message.isEmpty)
        default:
            Issue.record("Expected degraded state when probe fails for linked channel")
        }

        #expect(store.summaryLine.contains("probe degraded"))
    }
}
