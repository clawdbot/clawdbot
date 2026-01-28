import SwiftUI

extension CronSettings {
    func jobRow(_ job: CronJob) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(job.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if !job.enabled {
                    StatusPill(text: "disabled", tint: .secondary)
                } else if let next = job.nextRunDate {
                    StatusPill(text: self.nextRunLabel(next), tint: .secondary)
                } else {
                    StatusPill(text: "no next run", tint: .secondary)
                }
            }
            HStack(spacing: 6) {
                StatusPill(text: job.sessionTarget.rawValue, tint: .secondary)
                StatusPill(text: job.wakeMode.rawValue, tint: .secondary)
                if let agentId = job.agentId, !agentId.isEmpty {
                    StatusPill(text: "agent \(agentId)", tint: .secondary)
                }
                if let status = job.state.lastStatus {
                    StatusPill(text: status, tint: status == "ok" ? .green : .orange)
                }
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    func jobContextMenu(_ job: CronJob) -> some View {
        Button("Run now") { Task { await self.store.runJob(id: job.id, force: true) } }
        if job.sessionTarget == .isolated {
            Button("Open transcript") {
                WebChatManager.shared.show(sessionKey: "cron:\(job.id)")
            }
        }
        Divider()
        Button(job.enabled ? "Disable" : "Enable") {
            Task { await self.store.setJobEnabled(id: job.id, enabled: !job.enabled) }
        }
        Button("Edit…") {
            self.editingJob = job
            self.editorError = nil
            self.showEditor = true
        }
        Divider()
        Button("Delete…", role: .destructive) {
            self.confirmDelete = job
        }
    }

    func detailHeader(_ job: CronJob) -> some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(job.displayName)
                    .font(.title3.weight(.semibold))
                Text(job.id)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            HStack(spacing: 8) {
                Toggle("Enabled", isOn: Binding(
                    get: { job.enabled },
                    set: { enabled in Task { await self.store.setJobEnabled(id: job.id, enabled: enabled) } }))
                    .toggleStyle(.switch)
                    .labelsHidden()
                Button("Run") { Task { await self.store.runJob(id: job.id, force: true) } }
                    .buttonStyle(.borderedProminent)
                if job.sessionTarget == .isolated {
                    Button("Transcript") {
                        WebChatManager.shared.show(sessionKey: "cron:\(job.id)")
                    }
                    .buttonStyle(.bordered)
                }
                Button("Edit") {
                    self.editingJob = job
                    self.editorError = nil
                    self.showEditor = true
                }
                .buttonStyle(.bordered)
            }
        }
    }

    func detailCard(_ job: CronJob) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            LabeledContent("Schedule") { Text(self.scheduleSummary(job.schedule)).font(.callout) }
            if case .at = job.schedule, job.deleteAfterRun == true {
                LabeledContent("Auto-delete") { Text("after success") }
            }
            if let desc = job.description, !desc.isEmpty {
                LabeledContent("Description") { Text(desc).font(.callout) }
            }
            if let agentId = job.agentId, !agentId.isEmpty {
                LabeledContent("Agent") { Text(agentId) }
            }
            LabeledContent("Session") { Text(job.sessionTarget.rawValue) }
            LabeledContent("Wake") { Text(job.wakeMode.rawValue) }
            LabeledContent("Next run") {
                if let date = job.nextRunDate {
                    Text(date.formatted(date: .abbreviated, time: .standard))
                } else {
                    Text("—").foregroundStyle(.secondary)
                }
            }
            LabeledContent("Last run") {
                if let date = job.lastRunDate {
                    Text("\(date.formatted(date: .abbreviated, time: .standard)) · \(relativeAge(from: date))")
                } else {
                    Text("—").foregroundStyle(.secondary)
                }
            }
            if let status = job.state.lastStatus {
                LabeledContent("Last status") { Text(status) }
            }
            if let err = job.state.lastError, !err.isEmpty {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
            }
            self.payloadSummary(job.payload)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.secondary.opacity(0.06))
        .cornerRadius(8)
    }

    func runHistoryCard(_ job: CronJob) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Run history")
                    .font(.headline)
                Spacer()
                Button {
                    Task { await self.store.refreshRuns(jobId: job.id) }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(self.store.isLoadingRuns)
            }

            if self.store.isLoadingRuns {
                ProgressView().controlSize(.small)
            }

            if self.store.runEntries.isEmpty {
                Text("No run log entries yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(self.store.runEntries) { entry in
                        self.runRow(entry)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.secondary.opacity(0.06))
        .cornerRadius(8)
    }

    func runRow(_ entry: CronRunLogEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                StatusPill(text: entry.status ?? "unknown", tint: self.statusTint(entry.status))
                Text(entry.date.formatted(date: .abbreviated, time: .standard))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let ms = entry.durationMs {
                    Text("\(ms)ms")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            if let summary = entry.summary, !summary.isEmpty {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(2)
            }
            if let error = entry.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }

    func payloadSummary(_ payload: CronPayload) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Payload")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            switch payload {
            case let .systemEvent(text):
                Text(text)
                    .font(.callout)
                    .textSelection(.enabled)
            case let .agentTurn(message, thinking, timeoutSeconds, deliver, provider, to, _):
                VStack(alignment: .leading, spacing: 4) {
                    Text(message)
                        .font(.callout)
                        .textSelection(.enabled)
                    HStack(spacing: 8) {
                        if let thinking, !thinking.isEmpty { StatusPill(text: "think \(thinking)", tint: .secondary) }
                        if let timeoutSeconds { StatusPill(text: "\(timeoutSeconds)s", tint: .secondary) }
                        if deliver ?? false {
                            StatusPill(text: "deliver", tint: .secondary)
                            if let provider, !provider.isEmpty { StatusPill(text: provider, tint: .secondary) }
                            if let to, !to.isEmpty { StatusPill(text: to, tint: .secondary) }
                        }
                    }
                }
            }
        }
    }
}
