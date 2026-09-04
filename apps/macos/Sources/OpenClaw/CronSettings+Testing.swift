import SwiftUI

#if DEBUG
struct CronSettings_Previews: PreviewProvider {
    static var previews: some View {
        let store = CronJobsStore(isPreview: true)
        store.seedPreviewJobs(
            [
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
                        deliver: nil,
                        channel: nil,
                        to: nil,
                        bestEffortDeliver: nil),
                    delivery: CronDelivery(mode: .announce, channel: "last", to: nil, bestEffort: true),
                    state: CronJobState(
                        nextRunAtMs: Int(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000),
                        runningAtMs: nil,
                        lastRunAtMs: nil,
                        lastStatus: nil,
                        lastError: nil,
                        lastDurationMs: nil)),
            ],
            selectedJobID: "job-1",
            enabled: true)
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
        return CronSettings(store: store, channelsStore: ChannelsStore(isPreview: true))
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
