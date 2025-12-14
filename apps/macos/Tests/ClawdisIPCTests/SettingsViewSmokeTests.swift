import SwiftUI
import Testing
@testable import Clawdis

@Suite(.serialized)
@MainActor
struct SettingsViewSmokeTests {
    @Test func cronSettingsBuildsBody() {
        let store = CronJobsStore(isPreview: true)
        store.schedulerEnabled = false
        store.schedulerStorePath = "/tmp/clawdis-cron-store.json"

        let job1 = CronJob(
            id: "job-1",
            name: "  Morning Check-in  ",
            enabled: true,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_100_000,
            schedule: .cron(expr: "0 8 * * *", tz: "UTC"),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: "ping"),
            isolation: nil,
            state: CronJobState(
                nextRunAtMs: 1_700_000_200_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: "ok",
                lastError: nil,
                lastDurationMs: 123))

        let job2 = CronJob(
            id: "job-2",
            name: nil,
            enabled: false,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_100_000,
            schedule: .every(everyMs: 30_000, anchorMs: nil),
            sessionTarget: .isolated,
            wakeMode: .nextHeartbeat,
            payload: .agentTurn(
                message: "hello",
                thinking: "low",
                timeoutSeconds: 30,
                deliver: true,
                channel: "sms",
                to: "+15551234567",
                bestEffortDeliver: true),
            isolation: CronIsolation(postToMainPrefix: "[cron] "),
            state: CronJobState(
                nextRunAtMs: nil,
                runningAtMs: nil,
                lastRunAtMs: nil,
                lastStatus: nil,
                lastError: nil,
                lastDurationMs: nil))

        store.jobs = [job1, job2]
        store.selectedJobId = job1.id
        store.runEntries = [
            CronRunLogEntry(
                ts: 1_700_000_050_000,
                jobId: job1.id,
                action: "finished",
                status: "ok",
                error: nil,
                summary: "ok",
                runAtMs: 1_700_000_050_000,
                durationMs: 123,
                nextRunAtMs: 1_700_000_200_000),
        ]

        let view = CronSettings(store: store)
        _ = view.body
    }

    @Test func configSettingsBuildsBody() {
        let view = ConfigSettings()
        _ = view.body
    }

    @Test func debugSettingsBuildsBody() {
        let view = DebugSettings()
        _ = view.body
    }

    @Test func voiceWakeSettingsBuildsBody() {
        let state = AppState(preview: true)
        let view = VoiceWakeSettings(state: state)
        _ = view.body
    }

    @Test func toolsSettingsBuildsBody() {
        let view = ToolsSettings()
        _ = view.body
    }
}

