import Foundation
import Testing
@testable import Clawdbot

@Suite struct HealthStoreStateTests {
    @Test @MainActor func linkedProviderProbeFailureDegradesState() async throws {
        let snap = HealthSnapshot(
            ok: true,
            ts: 0,
            durationMs: 1,
            providers: [
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
                        webhook: nil
                    ),
                    lastProbeAt: 0
                ),
            ],
            providerOrder: ["whatsapp"],
            providerLabels: ["whatsapp": "WhatsApp"],
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: [])
        )

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        switch store.state {
        case .degraded(let message):
            #expect(!message.isEmpty)
        default:
            Issue.record("Expected degraded state when probe fails for linked provider")
        }

        #expect(store.summaryLine.contains("probe degraded"))
    }
}

