import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    var cronStatusCard: some View {
        ProCard(radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Scheduler")
                        .font(OpenClawType.headline)
                    Spacer()
                    ProValuePill(
                        value: self.overview?.cronStatus?.enabled == true ? "on" : "off",
                        color: self.cronColor)
                }
                HStack(spacing: 10) {
                    let jobCount = self.overview?.cronStatus?.jobs
                        ?? self.overview?.cronJobs.count
                        ?? 0
                    self.detailMetric(label: "Automations", value: "\(jobCount)")
                    self.detailMetric(label: "Next", value: self.cronNextRunLabel)
                }
                if let cronActionStatusText {
                    Text(cronActionStatusText)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var cronNextRunLabel: String {
        guard let nextWakeAtMs = overview?.cronStatus?.nextwakeatms else { return "none" }
        return Self.relativeTime(fromMilliseconds: nextWakeAtMs)
    }

    func cronJobsList(limit: Int?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Automations")
            self.automationListControls
            ProCard(padding: 0, radius: AgentLayout.cardRadius) {
                let jobs = self.filteredAutomationJobs
                let visible = limit.map { Array(jobs.prefix($0)) } ?? jobs
                if visible.isEmpty {
                    self.emptyAutomationFilterRow
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
        (overview?.cronJobs ?? [])
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

    var filteredAutomationJobs: [CronJob] {
        let query = automationQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.sortedCronJobs.filter { job in
            let matchesStatus = switch self.automationListFilter {
            case .all: true
            case .active: job.enabled
            case .paused: !job.enabled
            }
            let matchesQuery = query.isEmpty || [
                job.name,
                job.description,
                self.cronScheduleSummary(job),
            ]
                .compactMap(\.self)
                .contains { $0.localizedCaseInsensitiveContains(query) }
            return matchesStatus && matchesQuery
        }
    }

    var automationListControls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 9) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search automations", text: self.$automationQuery)
                    .font(OpenClawType.body)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            Picker(selection: self.$automationListFilter) {
                ForEach(AutomationListFilter.allCases) { filter in
                    Text(filter.title)
                        .font(OpenClawType.captionSemiBold)
                        .tag(filter)
                }
            } label: {
                Text("Automation status")
                    .font(OpenClawType.captionSemiBold)
            }
            .pickerStyle(.segmented)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var emptyAutomationFilterRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "line.3.horizontal.decrease.circle", color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.sortedCronJobs.isEmpty ? "No automations yet" : "No matching automations")
                    .font(OpenClawType.subheadSemiBold)
                Text(self.sortedCronJobs.isEmpty
                    ? "Scheduled work created on the gateway will appear here."
                    : "Try another search or status filter.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    func cronJobDetailRow(_ job: CronJob) -> some View {
        let pendingRunID = pendingCronRuns.runID(for: job.id)
        let busy = cronActionBusyIDs.contains(job.id) || pendingRunID != nil
        return HStack(alignment: .top, spacing: 12) {
            ProIconBadge(
                systemName: job.enabled ? "clock.arrow.circlepath" : "pause.circle",
                color: job.enabled ? OpenClawBrand.accent : .secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(job.name)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Text(self.cronJobDetail(job))
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(self.cronScheduleSummary(job))
                    .font(OpenClawType.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    Button {
                        guard let sourceGatewayID = self.overview?.gatewayID else { return }
                        self.presentAutomationEditor(
                            job: job,
                            sourceGatewayID: sourceGatewayID)
                    } label: {
                        Label("Edit", systemImage: "slider.horizontal.3")
                            .font(OpenClawType.captionSemiBold)
                    }

                    Button {
                        Task { await self.runCronJob(job) }
                    } label: {
                        Label("Run", systemImage: "play.fill")
                            .font(OpenClawType.captionSemiBold)
                    }
                    .disabled(busy || !self.liveGatewayConnected || !self.appModel.hasOperatorAdminScope)

                    Button {
                        Task { await self.setCronJob(job, enabled: !job.enabled) }
                    } label: {
                        Label(job.enabled ? "Pause" : "Enable", systemImage: job.enabled ? "pause.fill" : "checkmark")
                            .font(OpenClawType.captionSemiBold)
                    }
                    .disabled(busy || !self.liveGatewayConnected || !self.appModel.hasOperatorAdminScope)
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
                    .font(OpenClawType.caption2SemiBold)
                    .foregroundStyle(job.enabled ? OpenClawBrand.accent : .secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    @MainActor
    func runCronJob(_ job: CronJob) async {
        guard let sourceGatewayID = self.overview?.gatewayID else { return }
        await self.runCronAction(job) {
            let systemInfoData = try await self.requestAutomationGateway(
                method: "system.info",
                paramsJSON: Self.automationParams([:]),
                sourceGatewayID: sourceGatewayID)
            let processInstanceID = try JSONDecoder()
                .decode(SystemInfoResult.self, from: systemInfoData)
                .processinstanceid
            var runParams: [String: Any] = ["id": job.id, "mode": "force"]
            // Shipped Gateways predate process identity. Without it, preserve Run Now
            // and hold the reservation until exact history, route change, or app reset.
            if let processInstanceID {
                runParams["expectedProcessInstanceId"] = processInstanceID
            }
            let data = try await self.requestAutomationGateway(
                method: "cron.run",
                paramsJSON: Self.automationParams(runParams),
                sourceGatewayID: sourceGatewayID)
            let result = try JSONDecoder().decode(AgentAutomationRunResult.self, from: data)
            guard result.ok else { throw AgentAutomationEditError.invalidResponse }
            if result.ran == false, result.enqueued != true {
                return Self.cronRunSkipMessage(result.reason)
            }
            guard result.ran == true || result.enqueued == true else {
                throw AgentAutomationEditError.invalidResponse
            }
            if result.enqueued == true, result.runId == nil {
                throw AgentAutomationEditError.invalidResponse
            }
            if let runID = result.runId {
                self.reservePendingCronRun(
                    jobID: job.id,
                    runID: runID,
                    processInstanceID: result.processInstanceId ?? processInstanceID,
                    sourceGatewayID: sourceGatewayID)
                self.presentAutomationEditor(
                    job: job,
                    sourceGatewayID: sourceGatewayID)
                return String(
                    format: String(localized: "Tracking %@ in run history."),
                    job.name)
            }
            return String(format: String(localized: "Ran %@. Open Edit for run history."), job.name)
        }
    }

    @MainActor
    func presentAutomationEditor(job: CronJob, sourceGatewayID: String) {
        // Keep the tapped snapshot while the sheet is open. Overview refreshes may
        // temporarily omit cron jobs, but must not blank an active editor or lose run tracking.
        self.automationEditorSelection = AutomationEditorSelection(
            initialJob: job,
            sourceGatewayID: sourceGatewayID)
    }

    @MainActor
    func setCronJob(_ job: CronJob, enabled: Bool) async {
        guard let sourceGatewayID = self.overview?.gatewayID else { return }
        await self.runCronAction(job) {
            _ = try await self.requestAutomationGateway(
                method: "cron.update",
                paramsJSON: buildAgentAutomationEnabledParams(job: job, enabled: enabled),
                sourceGatewayID: sourceGatewayID)
            return String(
                format: enabled
                    ? String(localized: "Enabled %@.")
                    : String(localized: "Paused %@."),
                job.name)
        }
    }

    @MainActor
    func runCronAction(
        _ job: CronJob,
        action: () async throws -> String) async
    {
        guard liveGatewayConnected, appModel.hasOperatorAdminScope else { return }
        // The view's disabled state can lag a rapid second tap. Main-actor insertion
        // is the admission gate that prevents duplicate mutation and run RPCs.
        guard pendingCronRuns.runID(for: job.id) == nil else { return }
        guard cronActionBusyIDs.insert(job.id).inserted else { return }
        cronActionStatusText = nil
        defer { self.cronActionBusyIDs.remove(job.id) }
        do {
            cronActionStatusText = try await action()
            await refreshOverview(force: true)
        } catch {
            cronActionStatusText = Self.skillMutationMessage(error)
        }
    }

    @MainActor
    func reservePendingCronRun(
        jobID: String,
        runID: String,
        processInstanceID: String?,
        sourceGatewayID: String)
    {
        guard self.pendingCronRuns.reserve(jobID: jobID, runID: runID) else { return }
        // cron.run acknowledges before lane admission. Parent-owned tracking keeps
        // the job reserved when the detail sheet disappears, preventing a second run.
        Task {
            await self.trackPendingCronRun(
                jobID: jobID,
                runID: runID,
                processInstanceID: processInstanceID,
                sourceGatewayID: sourceGatewayID)
        }
    }

    @MainActor
    private func trackPendingCronRun(
        jobID: String,
        runID: String,
        processInstanceID: String?,
        sourceGatewayID: String) async
    {
        var attempt = 0
        while self.pendingCronRuns.runID(for: jobID) == runID {
            do {
                let data = try await self.requestAutomationGateway(
                    method: "cron.runs",
                    paramsJSON: Self.automationParams([
                        "id": jobID,
                        "runId": runID,
                        "limit": 1,
                        "sortDir": "desc",
                    ]),
                    sourceGatewayID: sourceGatewayID)
                let entries = try JSONDecoder().decode(AgentAutomationRunsResponse.self, from: data).entries
                if entries.contains(where: { $0.runid == runID }) {
                    self.pendingCronRuns.release(jobID: jobID, runID: runID)
                    await self.refreshOverview(force: true)
                    return
                }
            } catch {
                guard self.keepPendingCronRunOnRequestFailure(
                    jobID: jobID,
                    runID: runID,
                    sourceGatewayID: sourceGatewayID)
                else { return }
            }
            if let processInstanceID {
                do {
                    let systemInfoData = try await self.requestAutomationGateway(
                        method: "system.info",
                        paramsJSON: Self.automationParams([:]),
                        sourceGatewayID: sourceGatewayID)
                    let currentInstanceID = try JSONDecoder()
                        .decode(SystemInfoResult.self, from: systemInfoData)
                        .processinstanceid
                    guard currentInstanceID == processInstanceID else {
                        // A queued continuation cannot survive a process restart. The
                        // enqueue response binds this exact per-start identity atomically.
                        self.releaseUnconfirmedPendingCronRun(jobID: jobID, runID: runID)
                        return
                    }
                } catch {
                    guard self.keepPendingCronRunOnRequestFailure(
                        jobID: jobID,
                        runID: runID,
                        sourceGatewayID: sourceGatewayID)
                    else { return }
                }
            }
            attempt += 1
            do {
                try await Task.sleep(for: .seconds(attempt < 120 ? 1 : 10))
            } catch {
                return
            }
        }
    }

    @MainActor
    private func keepPendingCronRunOnRequestFailure(
        jobID: String,
        runID: String,
        sourceGatewayID: String) -> Bool
    {
        guard self.appModel.connectedGatewayID == nil ||
            self.appModel.connectedGatewayID == sourceGatewayID
        else {
            self.pendingCronRuns.release(jobID: jobID, runID: runID)
            self.cronActionStatusText = AgentAutomationEditError.gatewayChanged.localizedDescription
            return false
        }
        return true
    }

    @MainActor
    private func releaseUnconfirmedPendingCronRun(jobID: String, runID: String) {
        guard self.pendingCronRuns.runID(for: jobID) == runID else { return }
        self.pendingCronRuns.release(jobID: jobID, runID: runID)
        self.cronActionStatusText = AgentAutomationEditError.invalidResponse.localizedDescription
    }

    @MainActor
    func requestAutomationGateway(
        method: String,
        paramsJSON: String,
        sourceGatewayID: String) async throws -> Data
    {
        guard let route = await appModel.operatorSession.currentRoute(ifGatewayID: sourceGatewayID),
              appModel.connectedGatewayID == sourceGatewayID
        else {
            throw AgentAutomationEditError.gatewayChanged
        }
        let data = try await appModel.operatorSession.request(
            method: method,
            paramsJSON: paramsJSON,
            timeoutSeconds: 20,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
        guard await appModel.operatorSession.currentRoute() == route else {
            throw AgentAutomationEditError.gatewayChangedAfterDispatch
        }
        return data
    }

    static func automationParams(_ value: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard let text = String(data: data, encoding: .utf8) else {
            throw AgentAutomationEditError.invalidResponse
        }
        return text
    }

    static func cronRunSkipMessage(_ reason: String?) -> String {
        switch reason {
        case "not-due": String(localized: "This automation is not due yet.")
        case "already-running": String(localized: "This automation is already running.")
        case "restart-recovery-pending": String(localized: "Gateway restart recovery is still in progress.")
        case "invalid-spec": String(localized: "This automation has an invalid configuration.")
        case "stopped": String(localized: "The automation scheduler is stopped.")
        default: String(localized: "The Gateway did not start this automation.")
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
