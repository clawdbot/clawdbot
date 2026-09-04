import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CronJobEditorSmokeTests {
    private func makeEditor(job: CronJob? = nil, channelsStore: ChannelsStore? = nil) -> CronJobEditor {
        CronJobEditor(
            job: job,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore ?? ChannelsStore(isPreview: true),
            onCancel: {},
            onSave: { _ in })
    }

    @Test func `cron job editor preserves advanced delivery routes`() {
        let channelsStore = ChannelsStore(isPreview: true)
        let job = CronJob(
            id: "job-1",
            agentId: "ops",
            name: "Daily summary",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
            schedule: .every(everyMs: 3_600_000, anchorMs: 1_700_000_000_000),
            sessionTarget: .isolated,
            wakeMode: .nextHeartbeat,
            payload: .agentTurn(
                message: "Summarize the last day",
                thinking: "low",
                timeoutSeconds: 120,
                deliver: nil,
                channel: nil,
                to: nil,
                bestEffortDeliver: nil),
            delivery: CronDelivery(
                mode: .announce,
                channel: "whatsapp",
                to: "+15551234567",
                bestEffort: true,
                threadId: AnyCodable(42),
                completionDestination: [
                    "mode": AnyCodable("webhook"),
                    "to": AnyCodable("https://example.test/complete"),
                ],
                failureDestination: [
                    "mode": AnyCodable("announce"),
                    "channel": AnyCodable("telegram"),
                    "to": AnyCodable("ops"),
                    "accountId": AnyCodable("alerts"),
                ]),
            state: CronJobState(
                nextRunAtMs: 1_700_000_100_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: "ok",
                lastError: nil,
                lastDurationMs: 1000))

        let view = self.makeEditor(job: job, channelsStore: channelsStore)
        let delivery = view.buildDelivery()
        #expect(delivery["threadId"] as? Int == 42)
        #expect((delivery["completionDestination"] as? [String: Any])?["to"] as? String ==
            "https://example.test/complete")
        #expect((delivery["failureDestination"] as? [String: Any])?["accountId"] as? String == "alerts")
    }

    @Test func `cron job editor includes delete after run for at schedule`() {
        let view = self.makeEditor()

        var root: [String: Any] = [:]
        view.applyDeleteAfterRun(to: &root, scheduleKind: CronJobEditor.ScheduleKind.at, deleteAfterRun: true)
        let raw = root["deleteAfterRun"] as? Bool
        #expect(raw == true)
    }
}
