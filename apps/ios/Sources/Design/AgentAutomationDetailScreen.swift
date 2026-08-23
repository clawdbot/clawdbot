import OpenClawKit
import OpenClawProtocol
import SwiftUI

private enum AgentAutomationDetailSection: String, CaseIterable, Identifiable {
    case settings
    case history

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .settings: String(localized: "Settings")
        case .history: String(localized: "History")
        }
    }
}

private struct AgentAutomationNotice {
    enum Tone: Equatable {
        case success
        case warning
        case error

        var color: Color {
            switch self {
            case .success: OpenClawBrand.accent
            case .warning: .orange
            case .error: .red
            }
        }
    }

    let tone: Tone
    let title: String
    let message: String
}

struct AgentAutomationDetailScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss

    @State private var job: CronJob
    @State private var draft: AgentAutomationDraft?
    @State private var runs: [CronRunLogEntry] = []
    @State private var selectedSection: AgentAutomationDetailSection = .settings
    @State private var loading = false
    @State private var actionName: String?
    @State private var notice: AgentAutomationNotice?
    @State private var confirmDelete = false

    private let sourceGatewayID: String
    private let pendingRunRegistry: AgentAutomationPendingRunRegistry
    private let onRunQueued: (String, String?) -> Void
    private let onChanged: () -> Void

    init(
        initialJob: CronJob,
        sourceGatewayID: String,
        pendingRunRegistry: AgentAutomationPendingRunRegistry,
        onRunQueued: @escaping (String, String?) -> Void,
        onChanged: @escaping () -> Void)
    {
        self._job = State(initialValue: initialJob)
        self._draft = State(initialValue: AgentAutomationDraft(job: initialJob))
        self.sourceGatewayID = sourceGatewayID
        self.pendingRunRegistry = pendingRunRegistry
        self.onRunQueued = onRunQueued
        self.onChanged = onChanged
    }

    var body: some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        self.summaryCard
                        self.sectionPicker
                        if let notice {
                            self.noticeCard(notice)
                        }
                        if self.selectedSection == .settings {
                            self.settingsContent
                        } else {
                            self.historyContent
                        }
                    }
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                if self.loading, self.draft == nil {
                    ProgressView()
                        .controlSize(.large)
                }
            }
            .navigationTitle("Automation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        self.dismiss()
                    } label: {
                        Text("Close")
                            .font(OpenClawType.subheadSemiBold)
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await self.reload() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(self.loading || self.isBusy)
                    .accessibilityLabel("Refresh automation")
                }
            }
        }
        .font(OpenClawType.body)
        .presentationDetents([.large])
        .interactiveDismissDisabled(self.isBusy)
        .task { await self.initialLoad() }
        .confirmationDialog(
            "Delete this automation?",
            isPresented: self.$confirmDelete,
            titleVisibility: .visible)
        {
            Button(role: .destructive) {
                Task { await self.deleteAutomation() }
            } label: {
                Text("Delete Automation")
                    .font(OpenClawType.subheadSemiBold)
            }
            Button(role: .cancel) {} label: {
                Text("Cancel")
                    .font(OpenClawType.subheadSemiBold)
            }
        } message: {
            Text("This permanently removes the automation and its schedule from the Gateway.")
                .font(OpenClawType.caption)
        }
    }

    private var isBusy: Bool {
        self.actionName != nil
    }

    private var pendingRunID: String? {
        self.pendingRunRegistry.runID(for: self.job.id)
    }

    private var canAdmin: Bool {
        self.appModel.hasOperatorAdminScope
    }

    private var hasUnsavedChanges: Bool {
        guard let draft else { return false }
        return agentAutomationHasSemanticChanges(job: self.job, draft: draft)
    }

    private var summaryCard: some View {
        ProCard(radius: OpenClawProMetric.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    ProIconBadge(
                        systemName: self.job.enabled ? "clock.arrow.circlepath" : "pause.circle.fill",
                        color: self.job.enabled ? OpenClawBrand.accent : .secondary)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(self.job.name)
                            .font(OpenClawType.headline)
                            .lineLimit(2)
                        Text(self.scheduleSummary)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    ProValuePill(
                        value: self.job.enabled ? String(localized: "active") : String(localized: "paused"),
                        color: self.job.enabled ? OpenClawBrand.accent : .secondary)
                }
                HStack(spacing: 8) {
                    self.summaryMetric(
                        title: String(localized: "Next run"),
                        value: Self.relativeTime(self.job.nextrunatms ?? self.stateMilliseconds("nextRunAtMs")))
                    self.summaryMetric(
                        title: String(localized: "Last run"),
                        value: Self.relativeTime(self.job.lastrunatms ?? self.stateMilliseconds("lastRunAtMs")))
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func summaryMetric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(OpenClawType.caption2SemiBold)
                .foregroundStyle(.secondary)
            Text(value)
                .font(OpenClawType.subheadSemiBold)
                .lineLimit(1)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var sectionPicker: some View {
        Picker("Automation detail", selection: self.$selectedSection) {
            ForEach(AgentAutomationDetailSection.allCases) { section in
                Text(section.title)
                    .font(OpenClawType.captionSemiBold)
                    .tag(section)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @ViewBuilder
    private var settingsContent: some View {
        if let draftBinding = Binding(self.$draft) {
            Group {
                self.identityCard(draftBinding)
                self.scheduleCard(draftBinding)
                self.actionCard(draftBinding)
                self.executionCard(draftBinding)
            }
            .disabled(self.loading || self.isBusy)
            self.managementCard(draftBinding)
                .disabled(self.loading || self.isBusy)
        } else {
            self.messageCard(
                icon: "exclamationmark.triangle.fill",
                color: .orange,
                title: String(localized: "Editing unavailable"),
                message: AgentAutomationEditError.invalidModel.localizedDescription)
        }
    }

    private func identityCard(_ draft: Binding<AgentAutomationDraft>) -> some View {
        self.cardSection(title: String(localized: "Details"), icon: "text.alignleft") {
            self.labeledField(
                String(localized: "Name"),
                text: draft.name,
                prompt: String(localized: "Automation name"))
            self.labeledField(
                String(localized: "Description"),
                text: draft.description,
                prompt: String(localized: "Optional context"),
                axis: .vertical)
        }
    }

    private func scheduleCard(_ draft: Binding<AgentAutomationDraft>) -> some View {
        self.cardSection(title: String(localized: "Schedule"), icon: "calendar.badge.clock") {
            Text(draft.wrappedValue.schedule.kindLabel)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(OpenClawBrand.accent)
            self.scheduleFields(draft)
            if case .at = draft.wrappedValue.schedule {
                Toggle(isOn: draft.deleteAfterRun) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Delete after successful run")
                            .font(OpenClawType.subheadSemiBold)
                        Text("Useful for one-time automations.")
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(OpenClawBrand.accent)
            }
        }
    }

    @ViewBuilder
    private func scheduleFields(_ draft: Binding<AgentAutomationDraft>) -> some View {
        switch draft.wrappedValue.schedule {
        case .at:
            self.labeledField(
                String(localized: "ISO date and time"),
                text: self.scheduleBinding(draft, keyPath: \.at),
                prompt: "2030-01-15T09:00:00Z")
        case .every:
            self.labeledField(
                String(localized: "Interval (milliseconds)"),
                text: self.scheduleBinding(draft, keyPath: \.everyMs),
                prompt: "86400000",
                keyboard: .numberPad)
            self.labeledField(
                String(localized: "Anchor (milliseconds)"),
                text: self.scheduleBinding(draft, keyPath: \.anchorMs),
                prompt: String(localized: "Optional"),
                keyboard: .numberPad)
        case .cron:
            self.labeledField(
                String(localized: "Cron expression"),
                text: self.scheduleBinding(draft, keyPath: \.expression),
                prompt: "0 9 * * 1-5")
            self.labeledField(
                String(localized: "Time zone"),
                text: self.scheduleBinding(draft, keyPath: \.timezone),
                prompt: "America/Los_Angeles")
            self.labeledField(
                String(localized: "Stagger (milliseconds)"),
                text: self.scheduleBinding(draft, keyPath: \.staggerMs),
                prompt: String(localized: "Optional"),
                keyboard: .numberPad)
        case .onExit:
            self.labeledField(
                String(localized: "Command to watch"),
                text: self.scheduleBinding(draft, keyPath: \.command),
                prompt: "pnpm build")
            self.labeledField(
                String(localized: "Working directory"),
                text: self.scheduleBinding(draft, keyPath: \.cwd),
                prompt: String(localized: "Optional"))
        }
    }

    private func actionCard(_ draft: Binding<AgentAutomationDraft>) -> some View {
        self.cardSection(title: String(localized: "Action"), icon: "bolt.fill") {
            Text(draft.wrappedValue.payload.kindLabel)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(OpenClawBrand.accent)
            self.payloadFields(draft)
        }
    }

    @ViewBuilder
    private func payloadFields(_ draft: Binding<AgentAutomationDraft>) -> some View {
        switch draft.wrappedValue.payload {
        case .systemEvent:
            self.labeledField(
                String(localized: "Event text"),
                text: self.payloadBinding(draft, keyPath: \.text),
                prompt: String(localized: "What should the agent know?"),
                axis: .vertical)
        case .agentTurn:
            self.labeledField(
                String(localized: "Message"),
                text: self.payloadBinding(draft, keyPath: \.message),
                prompt: String(localized: "What should the agent do?"),
                axis: .vertical)
            self.labeledField(
                String(localized: "Model"),
                text: self.payloadBinding(draft, keyPath: \.model),
                prompt: String(localized: "Gateway default"))
            self.labeledField(
                String(localized: "Thinking"),
                text: self.payloadBinding(draft, keyPath: \.thinking),
                prompt: String(localized: "Gateway default"))
        case .command:
            self.labeledField(
                String(localized: "Arguments (JSON array)"),
                text: self.payloadBinding(draft, keyPath: \.argvJSON),
                prompt: #"["openclaw","status"]"#,
                axis: .vertical)
            self.labeledField(
                String(localized: "Working directory"),
                text: self.payloadBinding(draft, keyPath: \.cwd),
                prompt: String(localized: "Optional"))
        }
    }

    private func executionCard(_ draft: Binding<AgentAutomationDraft>) -> some View {
        self.cardSection(title: String(localized: "Execution"), icon: "scope") {
            self.labeledField(
                String(localized: "Session target"),
                text: draft.sessionTarget,
                prompt: "main, isolated, current, or session:<id>")
            self.labeledField(
                String(localized: "Wake mode"),
                text: draft.wakeMode,
                prompt: "now or next-heartbeat")
            if self.job.delivery != nil || self.job.failurealert != nil {
                Text("Delivery and failure routing remain visible and editable in the Control UI.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func managementCard(_ draft: Binding<AgentAutomationDraft>) -> some View {
        self.cardSection(title: String(localized: "Manage"), icon: "slider.horizontal.3") {
            if !self.canAdmin {
                Text("Admin scope is required to change, run, or delete automations.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                self.actionButton(
                    title: String(localized: "Save"),
                    icon: "checkmark.circle.fill",
                    prominent: true,
                    enabled: self.canAdmin && self.hasUnsavedChanges && !self.isBusy)
                {
                    Task { await self.save(draft.wrappedValue) }
                }
                self.actionButton(
                    title: self.pendingRunID == nil ? String(localized: "Run Now") : String(localized: "Running"),
                    icon: self.pendingRunID == nil ? "play.fill" : "hourglass",
                    enabled: self.canAdmin && !self.hasUnsavedChanges && !self.isBusy && self.pendingRunID == nil)
                {
                    Task { await self.runNow() }
                }
            }
            HStack(spacing: 8) {
                self.actionButton(
                    title: self.job.enabled ? String(localized: "Pause") : String(localized: "Enable"),
                    icon: self.job.enabled ? "pause.fill" : "checkmark",
                    enabled: self.canAdmin && !self.hasUnsavedChanges && !self.isBusy)
                {
                    Task { await self.setEnabled(!self.job.enabled) }
                }
                self.actionButton(
                    title: String(localized: "Delete"),
                    icon: "trash",
                    role: .destructive,
                    enabled: self.canAdmin && !self.isBusy)
                {
                    self.confirmDelete = true
                }
            }
            if let actionName {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(actionName)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if self.hasUnsavedChanges {
                Text("Save or discard edits before running, pausing, or enabling this automation.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var historyContent: some View {
        ProSectionHeader(
            title: "Recent runs",
            actionTitle: self.loading ? "Loading" : "Refresh",
            action: self.loading ? nil : { Task { await self.loadHistory() } })
        if self.runs.isEmpty {
            self.messageCard(
                icon: "clock.badge.questionmark",
                color: .secondary,
                title: String(localized: "No runs yet"),
                message: String(localized: "Completed runs and delivery outcomes will appear here."))
        } else {
            ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
                VStack(spacing: 0) {
                    ForEach(Array(self.runs.enumerated()), id: \.offset) { index, run in
                        self.historyRow(run)
                        if index < self.runs.count - 1 {
                            Divider().padding(.leading, 58)
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private func cardSection(
        title: String,
        icon: String,
        @ViewBuilder content: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: .verbatim(title))
            ProCard(radius: OpenClawProMetric.cardRadius) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 9) {
                        Image(systemName: icon)
                            .foregroundStyle(OpenClawBrand.accent)
                        Text(title)
                            .font(OpenClawType.subheadSemiBold)
                    }
                    content()
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private func labeledField(
        _ title: String,
        text: Binding<String>,
        prompt: String,
        axis: Axis = .horizontal,
        keyboard: UIKeyboardType = .default) -> some View
    {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
            TextField(prompt, text: text, axis: axis)
                .font(OpenClawType.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
                .lineLimit(axis == .vertical ? 2...5 : 1...1)
                .padding(.horizontal, 11)
                .padding(.vertical, 10)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    @ViewBuilder
    private func actionButton(
        title: String,
        icon: String,
        prominent: Bool = false,
        role: ButtonRole? = nil,
        enabled: Bool,
        action: @escaping () -> Void) -> some View
    {
        if prominent {
            Button(role: role, action: action) {
                Label(title, systemImage: icon)
                    .font(OpenClawType.captionSemiBold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(OpenClawBrand.accent)
            .disabled(!enabled)
        } else {
            Button(role: role, action: action) {
                Label(title, systemImage: icon)
                    .font(OpenClawType.captionSemiBold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(!enabled)
        }
    }

    private func messageCard(icon: String, color: Color, title: String, message: String) -> some View {
        ProCard(radius: OpenClawProMetric.cardRadius) {
            HStack(alignment: .top, spacing: 12) {
                ProIconBadge(systemName: icon, color: color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(OpenClawType.subheadSemiBold)
                    Text(message)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func noticeCard(_ notice: AgentAutomationNotice) -> some View {
        self.messageCard(
            icon: notice.tone == .success ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
            color: notice.tone.color,
            title: notice.title,
            message: notice.message)
    }

    private var scheduleSummary: String {
        guard let schedule = AgentAutomationValue.object(self.job.schedule),
              let kind = AgentAutomationValue.string(schedule["kind"])
        else { return String(localized: "Schedule configured") }
        switch kind {
        case "at": return AgentAutomationValue.string(schedule["at"]) ?? String(localized: "One time")
        case "every":
            return AgentAutomationValue.int(schedule["everyMs"])
                .map { String(format: String(localized: "Every %@"), Self.duration($0)) }
                ?? String(localized: "Interval")
        case "cron": return AgentAutomationValue.string(schedule["expr"]).map { "Cron \($0)" } ?? "Cron"
        case "on-exit": return String(localized: "After command exits")
        default: return kind
        }
    }

    private func stateMilliseconds(_ key: String) -> Int? {
        AgentAutomationValue.int(self.job.state[key])
    }

    private func scheduleBinding(
        _ draft: Binding<AgentAutomationDraft>,
        keyPath: WritableKeyPath<AgentAutomationScheduleDraft.Fields, String>) -> Binding<String>
    {
        Binding(
            get: { draft.wrappedValue.schedule.fields[keyPath: keyPath] },
            set: { value in
                var fields = draft.wrappedValue.schedule.fields
                fields[keyPath: keyPath] = value
                draft.wrappedValue.schedule = fields.schedule(matching: draft.wrappedValue.schedule)
            })
    }

    private func payloadBinding(
        _ draft: Binding<AgentAutomationDraft>,
        keyPath: WritableKeyPath<AgentAutomationPayloadDraft.Fields, String>) -> Binding<String>
    {
        Binding(
            get: { draft.wrappedValue.payload.fields[keyPath: keyPath] },
            set: { value in
                var fields = draft.wrappedValue.payload.fields
                fields[keyPath: keyPath] = value
                draft.wrappedValue.payload = fields.payload(matching: draft.wrappedValue.payload)
            })
    }

    @MainActor
    private func reload() async {
        guard !self.hasUnsavedChanges || self.draft == nil else {
            self.notice = AgentAutomationNotice(
                tone: .warning,
                title: String(localized: "Unsaved changes"),
                message: String(localized: "Save or close this automation before refreshing."))
            return
        }
        let draftAtStart = self.draft
        self.loading = true
        defer { self.loading = false }
        do {
            let route = try await self.gatewayRoute()
            let data = try await self.request(
                method: "cron.get",
                paramsJSON: Self.params(["id": self.job.id]),
                timeoutSeconds: 20,
                route: route)
            let updated = try JSONDecoder().decode(CronJob.self, from: data)
            guard let updatedDraft = AgentAutomationDraft(job: updated) else {
                throw AgentAutomationEditError.invalidModel
            }
            guard self.draft == draftAtStart else {
                self.notice = AgentAutomationNotice(
                    tone: .warning,
                    title: String(localized: "Edits preserved"),
                    message: String(
                        localized: "Gateway data changed while you edited. Save will validate the current revision."))
                await self.loadHistory(route: route)
                return
            }
            self.job = updated
            self.draft = updatedDraft
            await self.loadHistory(route: route)
        } catch {
            self.showError(title: String(localized: "Could not load automation"), error: error)
        }
    }

    @MainActor
    private func loadHistory() async {
        self.loading = true
        defer { self.loading = false }
        do {
            let route = try await self.gatewayRoute()
            await self.loadHistory(route: route)
        } catch {
            self.showError(title: String(localized: "Could not load run history"), error: error)
        }
    }

    @MainActor
    private func loadHistory(route: GatewayNodeSessionRoute) async {
        do {
            let data = try await self.request(
                method: "cron.runs",
                paramsJSON: Self.params([
                    "id": self.job.id,
                    "limit": 25,
                    "sortDir": "desc",
                ]),
                timeoutSeconds: 20,
                route: route)
            self.runs = try JSONDecoder().decode(AgentAutomationRunsResponse.self, from: data).entries
        } catch {
            self.showError(title: String(localized: "Could not load run history"), error: error)
        }
    }

    @MainActor
    private func save(_ draft: AgentAutomationDraft) async {
        await self.performAction(String(localized: "Saving automation")) {
            let route = try await self.gatewayRoute()
            let paramsJSON = try buildAgentAutomationUpdateParams(job: self.job, draft: draft)
            let data = try await self.request(
                method: "cron.update",
                paramsJSON: paramsJSON,
                timeoutSeconds: 20,
                route: route)
            try self.applyUpdatedJob(JSONDecoder().decode(CronJob.self, from: data))
            self.notice = AgentAutomationNotice(
                tone: .success,
                title: String(localized: "Automation saved"),
                message: String(localized: "The Gateway accepted the latest revision."))
            self.onChanged()
        }
    }

    @MainActor
    private func setEnabled(_ enabled: Bool) async {
        await self
            .performAction(enabled ? String(localized: "Enabling automation") :
                String(localized: "Pausing automation"))
            {
                let route = try await self.gatewayRoute()
                let paramsJSON = try buildAgentAutomationEnabledParams(job: self.job, enabled: enabled)
                let data = try await self.request(
                    method: "cron.update",
                    paramsJSON: paramsJSON,
                    timeoutSeconds: 20,
                    route: route)
                try self.applyUpdatedJob(JSONDecoder().decode(CronJob.self, from: data))
                self.notice = AgentAutomationNotice(
                    tone: .success,
                    title: enabled ? String(localized: "Automation enabled") :
                        String(localized: "Automation paused"),
                    message: enabled
                        ? String(localized: "Future runs are active.")
                        : String(localized: "Future scheduled runs are paused."))
                self.onChanged()
            }
    }

    @MainActor
    private func runNow() async {
        guard self.pendingRunID == nil else { return }
        await self.performAction(String(localized: "Queueing run")) {
            let route = try await self.gatewayRoute()
            let systemInfoData = try await self.request(
                method: "system.info",
                paramsJSON: Self.params([:]),
                timeoutSeconds: 20,
                route: route)
            let processInstanceID = try JSONDecoder()
                .decode(SystemInfoResult.self, from: systemInfoData)
                .processinstanceid
            var runParams: [String: Any] = ["id": self.job.id, "mode": "force"]
            if let processInstanceID {
                runParams["expectedProcessInstanceId"] = processInstanceID
            }
            let data = try await self.request(
                method: "cron.run",
                paramsJSON: Self.params(runParams),
                timeoutSeconds: 20,
                route: route)
            let result = try JSONDecoder().decode(AgentAutomationRunResult.self, from: data)
            guard result.ok else {
                throw AgentAutomationEditError.invalidResponse
            }
            if result.ran == false, result.enqueued != true {
                self.notice = AgentAutomationNotice(
                    tone: .warning,
                    title: String(localized: "Run skipped"),
                    message: Self.runSkipMessage(result.reason))
                if agentAutomationRunSkipShouldRefresh(reason: result.reason) {
                    // Invalid-spec preflight persists diagnostics before returning.
                    // Refresh every projection so the actionable Gateway error is visible.
                    await self.reloadAfterRun(route: route)
                    await self.loadHistory(route: route)
                }
                return
            }
            guard result.ran == true || result.enqueued == true else {
                throw AgentAutomationEditError.invalidResponse
            }
            if result.enqueued == true, result.runId == nil {
                throw AgentAutomationEditError.invalidResponse
            }
            self.notice = AgentAutomationNotice(
                tone: .success,
                title: String(localized: "Run queued"),
                message: result.runId == nil
                    ? String(localized: "Refresh History to follow the result.")
                    : String(localized: "This run stays tracked until its exact result appears."))
            self.selectedSection = .history
            self.onChanged()
            if let runID = result.runId {
                self.onRunQueued(runID, result.processInstanceId ?? processInstanceID)
                Task { await self.trackRun(runID, route: route) }
            } else {
                await self.loadHistory(route: route)
            }
        }
    }

    @MainActor
    private func trackRun(_ runID: String, route: GatewayNodeSessionRoute) async {
        for _ in 0..<120 {
            guard self.pendingRunID == runID else { return }
            do {
                let data = try await self.request(
                    method: "cron.runs",
                    paramsJSON: Self.params([
                        "id": self.job.id,
                        "runId": runID,
                        "limit": 1,
                        "sortDir": "desc",
                    ]),
                    timeoutSeconds: 20,
                    route: route)
                let entries = try JSONDecoder().decode(AgentAutomationRunsResponse.self, from: data).entries
                guard self.pendingRunID == runID else { return }
                if let entry = entries.first(where: { $0.runid == runID }) {
                    self.pendingRunRegistry.release(jobID: self.job.id, runID: runID)
                    await self.loadHistory(route: route)
                    let outcome = agentAutomationRunOutcome(
                        status: AgentAutomationValue.string(entry.status),
                        error: entry.error)
                    if agentAutomationDeletesAfterSuccessfulRun(job: self.job, outcome: outcome) {
                        self.onChanged()
                        self.dismiss()
                        return
                    }
                    self.notice = Self.runNotice(entry)
                    await self.reloadAfterRun(route: route)
                    return
                }
            } catch {
                guard await self.appModel.operatorSession.currentRoute() == route else {
                    return
                }
            }
            try? await Task.sleep(for: .seconds(1))
        }
        guard self.pendingRunID == runID else { return }
        self.notice = AgentAutomationNotice(
            tone: .warning,
            title: String(localized: "Run still pending"),
            message: String(localized: "The Gateway has not reported a result yet. Refresh History later."))
    }

    private static func runNotice(_ entry: CronRunLogEntry) -> AgentAutomationNotice {
        let status = AgentAutomationValue.string(entry.status)
        let detail = [entry.error, entry.summary].compactMap { value -> String? in
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }.first
        switch agentAutomationRunOutcome(status: status, error: entry.error) {
        case .success:
            return AgentAutomationNotice(
                tone: .success,
                title: String(localized: "Run finished"),
                message: String(localized: "History now shows the completed result."))
        case .skipped:
            return AgentAutomationNotice(
                tone: .warning,
                title: String(localized: "Run skipped"),
                message: detail ?? String(localized: "The Gateway skipped this run. History shows the result."))
        case .failure:
            return AgentAutomationNotice(
                tone: .error,
                title: String(localized: "Run failed"),
                message: detail ?? String(localized: "History shows the failure details."))
        case .unknown:
            return AgentAutomationNotice(
                tone: .warning,
                title: String(localized: "Run result available"),
                message: detail ?? String(localized: "History shows the Gateway result."))
        }
    }

    @MainActor
    private func reloadAfterRun(route: GatewayNodeSessionRoute) async {
        defer { self.onChanged() }
        // A queued run can finish after the user starts editing. Keep that draft intact;
        // the revision-safe save path will report any real configuration conflict.
        guard !self.hasUnsavedChanges else { return }
        do {
            let data = try await self.request(
                method: "cron.get",
                paramsJSON: Self.params(["id": self.job.id]),
                timeoutSeconds: 20,
                route: route)
            try self.applyUpdatedJob(JSONDecoder().decode(CronJob.self, from: data))
        } catch {
            // History already contains the authoritative terminal result.
        }
    }

    @MainActor
    private func deleteAutomation() async {
        await self.performAction(String(localized: "Deleting automation")) {
            let route = try await self.gatewayRoute()
            _ = try await self.request(
                method: "cron.remove",
                paramsJSON: Self.params(["id": self.job.id]),
                timeoutSeconds: 20,
                route: route)
            self.onChanged()
            self.dismiss()
        }
    }

    @MainActor
    private func performAction(_ name: String, action: () async throws -> Void) async {
        guard self.canAdmin, self.actionName == nil else { return }
        self.actionName = name
        self.notice = nil
        defer { self.actionName = nil }
        do {
            try await action()
        } catch {
            self.showError(title: String(localized: "Automation action failed"), error: error)
        }
    }

    @MainActor
    private func applyUpdatedJob(_ updated: CronJob) throws {
        guard let updatedDraft = AgentAutomationDraft(job: updated) else {
            throw AgentAutomationEditError.invalidModel
        }
        self.job = updated
        self.draft = updatedDraft
    }

    @MainActor
    private func gatewayRoute() async throws -> GatewayNodeSessionRoute {
        guard let route = await self.appModel.operatorSession.currentRoute(ifGatewayID: self.sourceGatewayID),
              self.appModel.connectedGatewayID == self.sourceGatewayID
        else {
            throw AgentAutomationEditError.gatewayChanged
        }
        return route
    }

    private func request(
        method: String,
        paramsJSON: String,
        timeoutSeconds: Int,
        route: GatewayNodeSessionRoute) async throws -> Data
    {
        let data = try await self.appModel.operatorSession.request(
            method: method,
            paramsJSON: paramsJSON,
            timeoutSeconds: timeoutSeconds,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
        guard await self.appModel.operatorSession.currentRoute() == route else {
            throw AgentAutomationEditError.gatewayChangedAfterDispatch
        }
        return data
    }

    private static func params(_ value: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard let text = String(data: data, encoding: .utf8) else {
            throw AgentAutomationEditError.invalidResponse
        }
        return text
    }

    private static func runSkipMessage(_ reason: String?) -> String {
        switch reason {
        case "not-due": String(localized: "This automation is not due yet.")
        case "already-running": String(localized: "This automation is already running.")
        case "restart-recovery-pending": String(localized: "Gateway restart recovery is still in progress.")
        case "invalid-spec": String(localized: "This automation has an invalid configuration.")
        case "stopped": String(localized: "The automation scheduler is stopped.")
        default: String(localized: "The Gateway did not start this automation.")
        }
    }

    private static func relativeTime(_ milliseconds: Int?) -> String {
        guard let milliseconds else { return String(localized: "not scheduled") }
        return Date(timeIntervalSince1970: Double(milliseconds) / 1000)
            .formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    private static func duration(_ milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }
}

extension AgentAutomationDetailScreen {
    private func historyRow(_ run: CronRunLogEntry) -> some View {
        let status = AgentAutomationValue.string(run.status) ?? run.action
        let appearance: (icon: String, color: Color, messageColor: Color) = switch agentAutomationRunOutcome(
            status: status,
            error: run.error)
        {
        case .success: ("checkmark.circle.fill", OpenClawBrand.accent, .secondary)
        case .skipped: ("forward.end.circle.fill", .orange, .orange)
        case .failure: ("exclamationmark.triangle.fill", .red, .red)
        case .unknown: ("questionmark.circle.fill", .orange, .orange)
        }
        return HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: appearance.icon, color: appearance.color)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(status.capitalized)
                        .font(OpenClawType.subheadSemiBold)
                    Spacer()
                    Text(Self.relativeTime(run.runatms ?? run.ts))
                        .font(OpenClawType.caption2)
                        .foregroundStyle(.secondary)
                }
                if let message = run.error ?? run.summary {
                    Text(message)
                        .font(OpenClawType.caption)
                        .foregroundStyle(appearance.messageColor)
                        .lineLimit(3)
                }
                let details = [
                    run.durationms.map { Self.duration($0) },
                    run.model,
                    AgentAutomationValue.string(run.deliverystatus).map { "Delivery \($0)" },
                ].compactMap(\.self)
                if !details.isEmpty {
                    Text(details.joined(separator: " · "))
                        .font(OpenClawType.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(14)
    }

    @MainActor
    private func initialLoad() async {
        await self.reload()
        guard let runID = self.pendingRunID else { return }
        do {
            let route = try await self.gatewayRoute()
            await self.trackRun(runID, route: route)
        } catch {
            self.showError(title: String(localized: "Could not track queued run"), error: error)
        }
    }

    @MainActor
    private func showError(title: String, error: Error) {
        self.notice = AgentAutomationNotice(
            tone: .error,
            title: title,
            message: error.localizedDescription)
    }
}

extension AgentAutomationScheduleDraft {
    fileprivate struct Fields {
        var at = ""
        var everyMs = ""
        var anchorMs = ""
        var expression = ""
        var timezone = ""
        var staggerMs = ""
        var command = ""
        var cwd = ""

        func schedule(matching schedule: AgentAutomationScheduleDraft) -> AgentAutomationScheduleDraft {
            switch schedule {
            case .at: .at(at: self.at)
            case .every: .every(everyMs: self.everyMs, anchorMs: self.anchorMs)
            case .cron: .cron(expression: self.expression, timezone: self.timezone, staggerMs: self.staggerMs)
            case .onExit: .onExit(command: self.command, cwd: self.cwd)
            }
        }
    }

    fileprivate var fields: Fields {
        switch self {
        case let .at(at): Fields(at: at)
        case let .every(everyMs, anchorMs): Fields(everyMs: everyMs, anchorMs: anchorMs)
        case let .cron(expression, timezone, staggerMs):
            Fields(expression: expression, timezone: timezone, staggerMs: staggerMs)
        case let .onExit(command, cwd): Fields(command: command, cwd: cwd)
        }
    }
}

extension AgentAutomationPayloadDraft {
    fileprivate struct Fields {
        var text = ""
        var message = ""
        var model = ""
        var thinking = ""
        var argvJSON = ""
        var cwd = ""

        func payload(matching payload: AgentAutomationPayloadDraft) -> AgentAutomationPayloadDraft {
            switch payload {
            case .systemEvent: .systemEvent(text: self.text)
            case .agentTurn: .agentTurn(message: self.message, model: self.model, thinking: self.thinking)
            case .command: .command(argvJSON: self.argvJSON, cwd: self.cwd)
            }
        }
    }

    fileprivate var fields: Fields {
        switch self {
        case let .systemEvent(text): Fields(text: text)
        case let .agentTurn(message, model, thinking):
            Fields(message: message, model: model, thinking: thinking)
        case let .command(argvJSON, cwd): Fields(argvJSON: argvJSON, cwd: cwd)
        }
    }
}
