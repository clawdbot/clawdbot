import Foundation
import Observation
import SwiftUI

struct ExecApprovalsSettings: View {
    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 18) {
                SettingsPageHeader(
                    title: "Exec Approvals",
                    subtitle: "Control how agent shell commands are approved on this Mac.")

                SystemRunSettingsView()
            }
            .settingsDetailContent()
        }
    }
}

struct SystemRunSettingsView: View {
    @State private var model = ExecApprovalsSettingsModel()
    @State private var tab: ExecApprovalsSettingsTab = .policy
    @State private var newPattern: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if self.model.policyAvailable {
                self.summaryPanel

                Picker("", selection: self.$tab) {
                    ForEach(ExecApprovalsSettingsTab.allCases) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 280)

                if let mutationErrorMessage = self.model.mutationErrorMessage {
                    Text(mutationErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }

                if self.tab == .policy {
                    self.policyView
                } else {
                    self.allowlistView
                }
            } else if self.model.readErrorMessage != nil {
                self.unavailablePanel
            } else {
                self.loadingPanel
            }
        }
        .task { await self.model.refresh() }
        .onChange(of: self.tab) { _, _ in
            Task { await self.model.refreshSkillBins() }
        }
    }

    private var loadingPanel: some View {
        SettingsCardGroup("Exec Approvals") {
            SettingsCardRow(
                title: "Loading settings…",
                subtitle: "Reading the persisted policy.",
                showsDivider: false)
            {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    private var unavailablePanel: some View {
        SettingsCardGroup("Exec Approvals Unavailable") {
            SettingsCardRow(
                title: "Settings could not be read",
                subtitle: self.model.readErrorMessage.map(SettingsTextValue.verbatim) ??
                    "Retry to load the persisted policy.",
                showsDivider: false)
            {
                Button("Retry") {
                    Task { await self.model.retryUnavailableSettings(maxAttempts: 1) }
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var summaryPanel: some View {
        HStack(alignment: .center, spacing: 18) {
            ZStack {
                Circle()
                    .fill(self.model.security.tint.opacity(0.22))
                Image(systemName: self.model.security.systemImage)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(self.model.security.tint)
            }
            .frame(width: 58, height: 58)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(self.model.security.summaryTitle)
                        .font(.headline)
                    StatusPill(
                        text: self.model.isDefaultsScope ? "defaults" : self.model.selectedAgentId,
                        tint: .secondary)
                }
                Text(self.model.security.summarySubtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 18)

            VStack(alignment: .trailing, spacing: 6) {
                Text("Scope")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Picker("Scope", selection: Binding(
                    get: { self.model.selectedAgentId },
                    set: { self.model.selectAgent($0) }))
                {
                    ForEach(self.model.agentPickerIds, id: \.self) { id in
                        Text(self.model.label(for: id)).tag(id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(width: 190, alignment: .trailing)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.34), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(.white.opacity(0.06))
        }
    }

    private var policyView: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsCardGroup("Policy") {
                SettingsCardRow(
                    title: "Command access",
                    subtitle: .localized(self.model.security.policyDescription))
                {
                    Picker("Command access", selection: Binding(
                        get: { self.model.security },
                        set: { self.model.setSecurity($0) }))
                    {
                        ForEach(ExecSecurity.allCases) { security in
                            Text(security.title).tag(security)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(width: 170)
                }

                SettingsCardRow(
                    title: "Prompt behavior",
                    subtitle: .localized(self.model.ask.policyDescription))
                {
                    Picker("Prompt behavior", selection: Binding(
                        get: { self.model.ask },
                        set: { self.model.setAsk($0) }))
                    {
                        ForEach(ExecAsk.allCases) { ask in
                            Text(ask.title).tag(ask)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(width: 210)
                }

                SettingsCardRow(
                    title: "Fallback when unreachable",
                    subtitle: "Used when the companion UI cannot display an approval prompt.",
                    showsDivider: false)
                {
                    Picker("Fallback", selection: Binding(
                        get: { self.model.askFallback },
                        set: { self.model.setAskFallback($0) }))
                    {
                        ForEach(ExecSecurity.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(width: 170)
                }
            }

            Text(self.scopeMessage)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var allowlistView: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsCardGroup("Automatic Trust") {
                SettingsCardToggleRow(
                    title: "Auto-allow skill CLIs",
                    subtitle: "Let bundled skill command-line tools run without prompting.",
                    binding: Binding(
                        get: { self.model.autoAllowSkills },
                        set: { self.model.setAutoAllowSkills($0) }),
                    showsDivider: self.model.autoAllowSkills && !self.model.skillBins.isEmpty)

                if self.model.autoAllowSkills, !self.model.skillBins.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Trusted skill binaries")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                        LazyVGrid(
                            columns: [GridItem(.adaptive(minimum: 78), spacing: 6, alignment: .leading)],
                            alignment: .leading,
                            spacing: 6)
                        {
                            ForEach(self.model.skillBins, id: \.self) { bin in
                                StatusPill(text: bin, tint: .secondary)
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                }
            }

            if self.model.isDefaultsScope {
                self.defaultsAllowlistEmptyState
            } else {
                SettingsCardGroup("Add Command") {
                    SettingsCardRow(
                        title: "Pattern",
                        subtitle: "Bare names match PATH commands. Use a path glob for a specific binary.",
                        showsDivider: false)
                    {
                        HStack(spacing: 8) {
                            TextField("rg or /opt/homebrew/bin/*", text: self.$newPattern)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 260)
                                .onSubmit { self.addPatternIfValid() }
                            Button("Add") {
                                self.addPatternIfValid()
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!self.model.isValidPattern(self.newPattern))
                        }
                    }
                }

                if self.model.entries.isEmpty {
                    self.emptyAllowlistState
                } else {
                    SettingsCardGroup("Allowed Commands") {
                        ForEach(self.model.entries, id: \.id) { entry in
                            ExecAllowlistRow(
                                entry: entry,
                                showsDivider: entry.id != self.model.entries.last?.id,
                                onPatternChange: { pattern in
                                    self.model.updateEntry(pattern: pattern, id: entry.id)
                                },
                                onRemove: { self.model.removeEntry(id: entry.id) })
                        }
                    }
                }
            }
        }
    }

    private var defaultsAllowlistEmptyState: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text("Allowlists are per-agent")
                    .font(.callout.weight(.semibold))
                Text("Select an agent scope above to add trusted commands.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.26), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var emptyAllowlistState: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text("No trusted commands yet")
                    .font(.callout.weight(.semibold))
                Text("Commands that miss the allowlist follow the prompt and fallback policy above.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: "terminal")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.26), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func addPatternIfValid() {
        if self.model.addEntry(self.newPattern) {
            self.newPattern = ""
        }
    }

    private var scopeMessage: String {
        if self.model.isDefaultsScope {
            return "Defaults apply when an agent has no overrides. " +
                "Ask controls prompt behavior; fallback is used when no companion UI is reachable."
        }
        return "Security controls whether system.run can execute on this Mac when paired as a node. " +
            "Ask controls prompt behavior; fallback is used when no companion UI is reachable."
    }
}

private enum ExecApprovalsSettingsTab: String, CaseIterable, Identifiable {
    case policy
    case allowlist

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .policy: "Access"
        case .allowlist: "Allowlist"
        }
    }
}

struct ExecAllowlistRow: View {
    let entry: ExecAllowlistEntry
    var showsDivider = true
    let onPatternChange: (String) -> String
    let onRemove: () -> Void
    @State private var draftPattern: String = ""

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField("Pattern", text: self.patternBinding)
                    .textFieldStyle(.roundedBorder)

                Button(role: .destructive) {
                    self.onRemove()
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }

            if let lastUsedAt = self.entry.lastUsedAt {
                let date = Date(timeIntervalSince1970: lastUsedAt / 1000.0)
                Text("Last used \(Self.relativeFormatter.localizedString(for: date, relativeTo: Date()))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let lastUsedCommand = self.entry.lastUsedCommand, !lastUsedCommand.isEmpty {
                Text("Last command: \(lastUsedCommand)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let lastResolvedPath = self.entry.lastResolvedPath, !lastResolvedPath.isEmpty {
                Text("Resolved path: \(lastResolvedPath)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .overlay(alignment: .bottom) {
            if self.showsDivider {
                Divider()
                    .padding(.leading, 14)
            }
        }
        .onAppear {
            self.draftPattern = self.entry.pattern
        }
        .onChange(of: self.entry.pattern) { _, pattern in
            self.draftPattern = pattern
        }
    }

    private var patternBinding: Binding<String> {
        Binding(
            get: { self.draftPattern.isEmpty ? self.entry.pattern : self.draftPattern },
            set: { newValue in
                self.draftPattern = newValue
                self.draftPattern = self.onPatternChange(newValue)
            })
    }
}

extension ExecSecurity {
    fileprivate var tint: Color {
        switch self {
        case .deny: .red
        case .allowlist: .orange
        case .full: .green
        }
    }

    fileprivate var systemImage: String {
        switch self {
        case .deny: "hand.raised.fill"
        case .allowlist: "checklist.checked"
        case .full: "bolt.shield.fill"
        }
    }

    fileprivate var summaryTitle: String {
        switch self {
        case .deny: "Shell commands blocked"
        case .allowlist: "Trusted commands can run"
        case .full: "Shell commands allowed"
        }
    }

    fileprivate var summarySubtitle: String {
        switch self {
        case .deny: "system.run requests are denied unless the policy changes."
        case .allowlist: "Known commands can run; new commands use the prompt policy."
        case .full: "Agents can run shell commands on this Mac without allowlist checks."
        }
    }

    fileprivate var policyDescription: String {
        switch self {
        case .deny: "Block agent shell commands on this Mac."
        case .allowlist: "Allow trusted command patterns and handle misses with prompts."
        case .full: "Allow shell commands without checking the allowlist."
        }
    }
}

extension ExecAsk {
    fileprivate var policyDescription: String {
        switch self {
        case .off: "Never show approval prompts."
        case .onMiss: "Ask only when a command is not trusted yet."
        case .always: "Ask before every shell command."
        }
    }
}

@MainActor
@Observable
final class ExecApprovalsSettingsModel {
    private static let defaultsScopeId = "__defaults__"
    private static let readUnavailableMessage = "Exec approval settings are unavailable. Retry to refresh."
    @ObservationIgnored private let resolveApprovalsAsync:
        @MainActor (String) async -> Result<ExecApprovalsResolved, ExecApprovalsReadError>
    @ObservationIgnored private let resolveDefaultsAsync:
        @MainActor () async -> Result<ExecApprovalsResolvedDefaults, ExecApprovalsReadError>
    @ObservationIgnored private let readRetryDelay: Duration
    @ObservationIgnored private let automaticReadRetryAttempts: Int
    @ObservationIgnored private var readRetryTask: Task<Void, Never>?
    @ObservationIgnored private var readGeneration = 0
    var agentIds: [String] = []
    var selectedAgentId: String = "main"
    var defaultAgentId: String = "main"
    var security: ExecSecurity = .deny
    var ask: ExecAsk = .onMiss
    var askFallback: ExecSecurity = .deny
    var autoAllowSkills = false
    var entries: [ExecAllowlistEntry] = []
    var skillBins: [String] = []
    var policyLoadState: ExecApprovalsPolicyLoadState = .loading
    var mutationErrorMessage: String?

    var policyAvailable: Bool {
        self.policyLoadState.isAvailable
    }

    var readErrorMessage: String? {
        self.policyLoadState.errorMessage
    }

    var agentPickerIds: [String] {
        [Self.defaultsScopeId] + self.agentIds
    }

    var isDefaultsScope: Bool {
        self.selectedAgentId == Self.defaultsScopeId
    }

    init(
        resolveApprovalsAsync: @escaping @MainActor (String) async -> Result<
            ExecApprovalsResolved,
            ExecApprovalsReadError,
        > = {
            await ExecApprovalsStore.resolveAsyncResult(agentId: $0)
        },
        resolveDefaultsAsync: @escaping @MainActor () async -> Result<
            ExecApprovalsResolvedDefaults,
            ExecApprovalsReadError,
        > = {
            await ExecApprovalsStore.resolveDefaultsAsyncResult()
        },
        readRetryDelay: Duration = .milliseconds(250),
        automaticReadRetryAttempts: Int = 5)
    {
        self.resolveApprovalsAsync = resolveApprovalsAsync
        self.resolveDefaultsAsync = resolveDefaultsAsync
        self.readRetryDelay = readRetryDelay
        self.automaticReadRetryAttempts = automaticReadRetryAttempts
    }

    func label(for id: String) -> String {
        if id == Self.defaultsScopeId {
            return "Defaults"
        }
        return id
    }

    func refresh() async {
        await self.refreshAgents()
        await self.loadSettings(for: self.selectedAgentId)
        await self.refreshSkillBins()
    }

    func refreshAgents() async {
        let root = await ConfigStore.load()
        let agents = root["agents"] as? [String: Any]
        let list = agents?["list"] as? [[String: Any]] ?? []
        var ids: [String] = []
        var seen = Set<String>()
        var defaultId: String?
        for entry in list {
            guard let raw = entry["id"] as? String else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if !seen.insert(trimmed).inserted {
                continue
            }
            ids.append(trimmed)
            if (entry["default"] as? Bool) == true, defaultId == nil {
                defaultId = trimmed
            }
        }
        if ids.isEmpty {
            ids = ["main"]
            defaultId = "main"
        } else if defaultId == nil {
            defaultId = ids.first
        }
        self.agentIds = ids
        self.defaultAgentId = defaultId ?? "main"
        if self.selectedAgentId == Self.defaultsScopeId {
            return
        }
        if !self.agentIds.contains(self.selectedAgentId) {
            self.selectedAgentId = self.defaultAgentId
        }
    }

    func selectAgent(_ id: String) {
        self.selectedAgentId = id
        self.mutationErrorMessage = nil
        let task = self.startSettingsRead(for: id)
        Task { [weak self] in
            await task.value
            guard let self, self.selectedAgentId == id, self.policyAvailable else { return }
            await self.refreshSkillBins()
        }
    }

    func loadSettings(for agentId: String) async {
        let task = self.startSettingsRead(for: agentId)
        await task.value
    }

    func retryUnavailableSettings(maxAttempts: Int) async {
        let task = self.startSettingsRead(
            for: self.selectedAgentId,
            maxAttempts: maxAttempts)
        await task.value
    }

    func waitForPendingSettingsRead() async {
        await self.readRetryTask?.value
    }

    private func apply(defaults: ExecApprovalsResolvedDefaults) {
        self.security = defaults.security
        self.ask = defaults.ask
        self.askFallback = defaults.askFallback
        self.autoAllowSkills = defaults.autoAllowSkills
        self.entries = []
        self.finishSettingsRead()
    }

    private func apply(resolved: ExecApprovalsResolved) {
        self.security = resolved.agent.security
        self.ask = resolved.agent.ask
        self.askFallback = resolved.agent.askFallback
        self.autoAllowSkills = resolved.agent.autoAllowSkills
        self.entries = resolved.allowlist
            .sorted { $0.pattern.localizedCaseInsensitiveCompare($1.pattern) == .orderedAscending }
        self.finishSettingsRead()
    }

    private func finishSettingsRead() {
        self.policyLoadState = .available
        self.mutationErrorMessage = nil
    }

    @discardableResult
    private func startSettingsRead(
        for agentId: String,
        maxAttempts: Int? = nil,
        showLoading: Bool = true) -> Task<Void, Never>
    {
        self.readGeneration += 1
        let generation = self.readGeneration
        self.readRetryTask?.cancel()
        if showLoading {
            self.policyLoadState = .loading
        }
        let task = Task { [weak self] in
            guard let self else { return }
            await self.performSettingsReadRetries(
                for: agentId,
                maxAttempts: maxAttempts ?? self.automaticReadRetryAttempts + 1,
                generation: generation)
        }
        self.readRetryTask = task
        return task
    }

    private func performSettingsReadRetries(
        for agentId: String,
        maxAttempts: Int,
        generation: Int) async
    {
        guard self.readGeneration == generation else { return }
        guard maxAttempts > 0 else {
            self.policyLoadState = .unavailable(Self.readUnavailableMessage)
            return
        }
        for attempt in 0..<maxAttempts {
            if attempt > 0 {
                do {
                    try await Task.sleep(for: self.readRetryDelay)
                } catch {
                    return
                }
            }
            guard self.readGeneration == generation, self.selectedAgentId == agentId else { return }
            if await self.loadSettingsOnceAsync(
                for: agentId,
                generation: generation)
            {
                return
            }
        }
        guard self.readGeneration == generation else { return }
        self.policyLoadState = .unavailable(Self.readUnavailableMessage)
    }

    private func loadSettingsOnceAsync(
        for agentId: String,
        generation: Int) async -> Bool
    {
        if agentId == Self.defaultsScopeId {
            let result = await self.resolveDefaultsAsync()
            guard self.readGeneration == generation, self.selectedAgentId == agentId else { return false }
            guard case let .success(defaults) = result else { return false }
            self.apply(defaults: defaults)
            return true
        }

        let result = await self.resolveApprovalsAsync(agentId)
        guard self.readGeneration == generation, self.selectedAgentId == agentId else { return false }
        guard case let .success(resolved) = result else { return false }
        self.apply(resolved: resolved)
        return true
    }

    func setSecurity(_ security: ExecSecurity) {
        let result = if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.security = security
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.security = security
            }
        }
        self.finishMutation(result) {
            self.security = security
        }
    }

    func setAsk(_ ask: ExecAsk) {
        let result = if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.ask = ask
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.ask = ask
            }
        }
        self.finishMutation(result) {
            self.ask = ask
        }
    }

    func setAskFallback(_ mode: ExecSecurity) {
        let result = if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.askFallback = mode
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.askFallback = mode
            }
        }
        self.finishMutation(result) {
            self.askFallback = mode
        }
    }

    func setAutoAllowSkills(_ enabled: Bool) {
        let result = if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.autoAllowSkills = enabled
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.autoAllowSkills = enabled
            }
        }
        if self.finishMutation(result, applyPersisted: {
            self.autoAllowSkills = enabled
        }) {
            Task { [weak self] in
                guard let self else { return }
                await self.waitForPendingSettingsRead()
                await self.refreshSkillBins(force: enabled)
            }
        }
    }

    @discardableResult
    func addEntry(_ pattern: String) -> Bool {
        guard !self.isDefaultsScope else { return false }
        let result = ExecApprovalsStore.addAllowlistEntry(
            agentId: self.selectedAgentId,
            pattern: pattern)
        return self.finishMutation(result, showLoading: true)
    }

    @discardableResult
    func updateEntry(pattern: String, id: String) -> String {
        guard !self.isDefaultsScope, let current = self.entry(for: id) else { return pattern }
        let normalizedPattern: String
        switch ExecApprovalHelpers.validateAllowlistPattern(pattern) {
        case let .valid(value):
            normalizedPattern = value
        case let .invalid(reason):
            self.mutationErrorMessage = reason.message
            return current.pattern
        }
        let result = ExecApprovalsStore.updateAllowlistEntry(
            agentId: self.selectedAgentId,
            id: id,
            pattern: normalizedPattern)
        guard self.finishMutation(result, applyPersisted: {
            guard let index = self.entries.firstIndex(where: { $0.id == id }) else { return }
            self.entries[index].pattern = normalizedPattern
        }) else { return current.pattern }
        return normalizedPattern
    }

    func removeEntry(id: String) {
        guard !self.isDefaultsScope else { return }
        guard self.entries.contains(where: { $0.id == id }) else { return }
        let result = ExecApprovalsStore.removeAllowlistEntry(agentId: self.selectedAgentId, id: id)
        self.finishMutation(result) {
            self.entries.removeAll(where: { $0.id == id })
        }
    }

    func entry(for id: String) -> ExecAllowlistEntry? {
        self.entries.first(where: { $0.id == id })
    }

    func isValidPattern(_ pattern: String) -> Bool {
        ExecApprovalHelpers.isValidAllowlistPattern(pattern)
    }

    func refreshSkillBins(force: Bool = false) async {
        guard self.autoAllowSkills else {
            self.skillBins = []
            return
        }
        let bins = await SkillBinsCache.shared.currentBins(force: force)
        self.skillBins = bins.sorted()
    }

    @discardableResult
    private func finishMutation(
        _ result: Result<Void, ExecApprovalsMutationError>,
        showLoading: Bool = false,
        applyPersisted: () -> Void = {}) -> Bool
    {
        switch result {
        case .success:
            applyPersisted()
            self.mutationErrorMessage = nil
            if self.isDefaultsScope {
                AppStateStore.shared.retryExecApprovalModeRead()
            }
            self.startSettingsRead(for: self.selectedAgentId, showLoading: showLoading)
            return true
        case let .failure(error):
            self.mutationErrorMessage = error.message
            return false
        }
    }
}
