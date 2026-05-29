import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    var cronStatusCard: some View {
        ProCard(radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Scheduler")
                        .font(.headline)
                    Spacer()
                    ProValuePill(
                        value: self.overview?.cronStatus?.enabled == true ? "on" : "off",
                        color: self.cronColor)
                }
                HStack(spacing: 10) {
                    let jobCount = self.overview?.cronStatus?.jobs
                        ?? self.overview?.cronJobs.count
                        ?? 0
                    self.detailMetric(label: "Jobs", value: "\(jobCount)")
                    self.detailMetric(label: "Next", value: self.cronNextRunLabel)
                }
                if let cronActionStatusText {
                    Text(cronActionStatusText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var cronNextRunLabel: String {
        guard let nextWakeAtMs = self.overview?.cronStatus?.nextwakeatms else { return "none" }
        return Self.relativeTime(fromMilliseconds: nextWakeAtMs)
    }

    func cronJobsList(limit: Int?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Jobs")
            ProCard(padding: 0, radius: AgentLayout.cardRadius) {
                let jobs = self.sortedCronJobs
                let visible = limit.map { Array(jobs.prefix($0)) } ?? jobs
                if visible.isEmpty {
                    self.emptyCronRow
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(visible.enumerated()), id: \.element.id) { index, job in
                            self.cronJobDetailRow(job)
                            if index < visible.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    var sortedCronJobs: [CronJob] {
        (self.overview?.cronJobs ?? [])
            .sorted { lhs, rhs in
                let lhsNext = AgentProValueReader.intValue(lhs.state["nextRunAtMs"])
                let rhsNext = AgentProValueReader.intValue(rhs.state["nextRunAtMs"])
                switch (lhsNext, rhsNext) {
                case let (lhsNext?, rhsNext?): return lhsNext < rhsNext
                case (_?, nil): return true
                case (nil, _?): return false
                case (nil, nil): return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
                }
            }
    }

    func cronJobDetailRow(_ job: CronJob) -> some View {
        let busy = self.cronActionBusyIDs.contains(job.id)
        return HStack(alignment: .top, spacing: 12) {
            ProIconBadge(
                systemName: job.enabled ? "clock.arrow.circlepath" : "pause.circle",
                color: job.enabled ? OpenClawBrand.accent : .secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(job.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.cronJobDetail(job))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(self.cronScheduleSummary(job))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    Button {
                        Task { await self.runCronJob(job) }
                    } label: {
                        Label("Run", systemImage: "play.fill")
                    }
                    .disabled(busy || !self.gatewayConnected)

                    Button {
                        Task { await self.setCronJob(job, enabled: !job.enabled) }
                    } label: {
                        Label(job.enabled ? "Pause" : "Enable", systemImage: job.enabled ? "pause.fill" : "checkmark")
                    }
                    .disabled(busy || !self.gatewayConnected)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
            Spacer(minLength: 8)
            if busy {
                ProgressView()
                    .progressViewStyle(.circular)
                    .controlSize(.small)
            } else {
                Text(self.cronJobState(job))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(job.enabled ? OpenClawBrand.accent : .secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    @MainActor
    func runCronJob(_ job: CronJob) async {
        await self.runCronAction(job, success: "Queued \(job.name).") {
            let params = CronRunParams(id: job.id, mode: "force")
            _ = try await self.requestGateway(method: "cron.run", params: params, timeoutSeconds: 20)
        }
    }

    @MainActor
    func setCronJob(_ job: CronJob, enabled: Bool) async {
        await self.runCronAction(job, success: enabled ? "Enabled \(job.name)." : "Paused \(job.name).") {
            let params = CronUpdateParams(id: job.id, patch: CronUpdatePatch(enabled: enabled))
            _ = try await self.requestGateway(method: "cron.update", params: params, timeoutSeconds: 20)
        }
    }

    @MainActor
    func runCronAction(
        _ job: CronJob,
        success: String,
        action: () async throws -> Void) async
    {
        guard self.gatewayConnected else { return }
        self.cronActionBusyIDs.insert(job.id)
        self.cronActionStatusText = nil
        defer { self.cronActionBusyIDs.remove(job.id) }
        do {
            try await action()
            self.cronActionStatusText = success
            await self.refreshOverview(force: true)
        } catch {
            self.cronActionStatusText = Self.skillMutationMessage(error)
        }
    }

    func cronScheduleSummary(_ job: CronJob) -> String {
        guard let schedule = job.schedule.value as? [String: AnyCodable] else { return "Schedule configured" }
        if let expr = Self.stringValue(schedule["expr"]) {
            return "Cron \(expr)"
        }
        if let everyMs = AgentProValueReader.intValue(schedule["everyMs"]) {
            return "Every \(Self.duration(milliseconds: everyMs))"
        }
        if let kind = Self.stringValue(schedule["kind"]) {
            return kind
        }
        return "Schedule configured"
    }
}
