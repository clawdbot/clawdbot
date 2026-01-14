import SwiftUI

#if DEBUG
struct CronSettings_Previews: PreviewProvider {
    static var previews: some View {
        let store = CronJobsStore(isPreview: true)
        store.jobs = [
            CronJob(
                id: "job-1",
                agentId: "ops",
                name: "Daily summary",
                description: nil,
                enabled: true,
                deleteAfterRun: nil,
                createdAtMs: 0,
                updatedAtMs: 0,
                schedule: .every(everyMs: 86_400_000, anchorMs: nil),
                sessionTarget: .isolated,
                wakeMode: .now,
                payload: .agentTurn(
                    message: "Summarize inbox",
                    thinking: "low",
                    timeoutSeconds: 600,
                    deliver: true,
                    provider: "last",
                    to: nil,
                    bestEffortDeliver: true),
                isolation: CronIsolation(postToMainPrefix: "Cron"),
                state: CronJobState(
                    nextRunAtMs: Int(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000),
                    runningAtMs: nil,
                    lastRunAtMs: nil,
                    lastStatus: nil,
                    lastError: nil,
                    lastDurationMs: nil)),
        ]
        store.selectedJobId = "job-1"
        store.runEntries = [
            CronRunLogEntry(
                ts: Int(Date().timeIntervalSince1970 * 1000),
                jobId: "job-1",
                action: "finished",
                status: "ok",
                error: nil,
                summary: "All good.",
                runAtMs: nil,
                durationMs: 1234,
                nextRunAtMs: nil),
        ]
        return CronSettings(store: store)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}

@MainActor
extension CronSettings {
    static func exerciseForTesting() {
        let store = CronJobsStore(isPreview: true)
        store.schedulerEnabled = false
        store.schedulerStorePath = "/tmp/clawdbot-cron-store.json"

        let job = CronJob(
            id: "job-1",
            agentId: "ops",
            name: "Daily summary",
            description: "Summary job",
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_100_000,
            schedule: .cron(expr: "0 8 * * *", tz: "UTC"),
            sessionTarget: .isolated,
            wakeMode: .nextHeartbeat,
            payload: .agentTurn(
                message: "Summarize",
                thinking: "low",
                timeoutSeconds: 120,
                deliver: true,
                provider: "whatsapp",
                to: "+15551234567",
                bestEffortDeliver: true),
            isolation: CronIsolation(postToMainPrefix: "[cron] "),
            state: CronJobState(
                nextRunAtMs: 1_700_000_200_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: "ok",
                lastError: nil,
                lastDurationMs: 1200))

        let run = CronRunLogEntry(
            ts: 1_700_000_050_000,
            jobId: job.id,
            action: "finished",
            status: "ok",
            error: nil,
            summary: "done",
            runAtMs: 1_700_000_050_000,
            durationMs: 1200,
            nextRunAtMs: 1_700_000_200_000)

        store.jobs = [job]
        store.selectedJobId = job.id
        store.runEntries = [run]

        let view = CronSettings(store: store)
        _ = view.body
        _ = view.jobRow(job)
        _ = view.jobContextMenu(job)
        _ = view.detailHeader(job)
        _ = view.detailCard(job)
        _ = view.runHistoryCard(job)
        _ = view.runRow(run)
        _ = view.payloadSummary(job.payload)
        _ = view.scheduleSummary(job.schedule)
        _ = view.statusTint(job.state.lastStatus)
        _ = view.nextRunLabel(Date())
        _ = view.formatDuration(ms: 1234)
    }
}
#endif
