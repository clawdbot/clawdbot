import SwiftUI
import Testing
@testable import Clawdbot

@Suite(.serialized)
@MainActor
struct CronJobEditorSmokeTests {
    @Test func statusPillBuildsBody() {
        _ = StatusPill(text: "ok", tint: .green).body
        _ = StatusPill(text: "disabled", tint: .secondary).body
    }

    @Test func cronJobEditorBuildsBodyForNewJob() {
        let view = CronJobEditor(
            job: nil,
            isSaving: .constant(false),
            error: .constant(nil),
            onCancel: {},
            onSave: { _ in })
        _ = view.body
    }

    @Test func cronJobEditorBuildsBodyForExistingJob() {
        let job = CronJob(
            id: "job-1",
            name: "Daily summary",
            enabled: true,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
            schedule: .every(everyMs: 3_600_000, anchorMs: 1_700_000_000_000),
            sessionTarget: .isolated,
            wakeMode: .nextHeartbeat,
            payload: .agentTurn(
                message: "Summarize the last day",
                thinking: "low",
                timeoutSeconds: 120,
                deliver: true,
                provider: "whatsapp",
                to: "+15551234567",
                bestEffortDeliver: true),
            isolation: CronIsolation(postToMainPrefix: "Cron"),
            state: CronJobState(
                nextRunAtMs: 1_700_000_100_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: "ok",
                lastError: nil,
                lastDurationMs: 1000))

        let view = CronJobEditor(
            job: job,
            isSaving: .constant(false),
            error: .constant(nil),
            onCancel: {},
            onSave: { _ in })
        _ = view.body
    }

    @Test func cronJobEditorExercisesBuilders() {
        var view = CronJobEditor(
            job: nil,
            isSaving: .constant(false),
            error: .constant(nil),
            onCancel: {},
            onSave: { _ in })
        view.exerciseForTesting()
    }
}
