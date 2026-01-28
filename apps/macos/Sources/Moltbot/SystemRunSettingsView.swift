import Foundation
import Observation
import SwiftUI

struct SystemRunSettingsView: View {
    @State private var model = ExecApprovalsSettingsModel()
    @State private var tab: ExecApprovalsSettingsTab = .policy
    @State private var newPattern: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                Text("Exec approvals")
                    .font(.body)
                Spacer(minLength: 0)
                Picker("Agent", selection: Binding(
                    get: { self.model.selectedAgentId },
                    set: { self.model.selectAgent($0) }))
                {
                    ForEach(self.model.agentPickerIds, id: \.self) { id in
                        Text(self.model.label(for: id)).tag(id)
                    }
                }
                .pickerStyle(.menu)
                .frame(width: 180, alignment: .trailing)
            }

            Picker("", selection: self.$tab) {
                ForEach(ExecApprovalsSettingsTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 320)

            if self.tab == .policy {
                self.policyView
            } else {
                self.allowlistView
            }
        }
        .task { await self.model.refresh() }
        .onChange(of: self.tab) { _, _ in
            Task { await self.model.refreshSkillBins() }
        }
    }

    private var policyView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("", selection: Binding(
                get: { self.model.security },
                set: { self.model.setSecurity($0) }))
            {
                ForEach(ExecSecurity.allCases) { security in
                    Text(security.title).tag(security)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)

            Picker("", selection: Binding(
                get: { self.model.ask },
                set: { self.model.setAsk($0) }))
            {
                ForEach(ExecAsk.allCases) { ask in
                    Text(ask.title).tag(ask)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)

            Picker("", selection: Binding(
                get: { self.model.askFallback },
                set: { self.model.setAskFallback($0) }))
            {
                ForEach(ExecSecurity.allCases) { mode in
                    Text("Fallback: \(mode.title)").tag(mode)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)

            Text(self.scopeMessage)
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var allowlistView: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Auto-allow skill CLIs", isOn: Binding(
                get: { self.model.autoAllowSkills },
                set: { self.model.setAutoAllowSkills($0) }))

            if self.model.autoAllowSkills, !self.model.skillBins.isEmpty {
                Text("Skill CLIs: \(self.model.skillBins.joined(separator: ", "))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if self.model.isDefaultsScope {
                Text("Allowlists are per-agent. Select an agent to edit its allowlist.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 8) {
                    TextField("Add allowlist pattern (case-insensitive globs)", text: self.$newPattern)
                        .textFieldStyle(.roundedBorder)
                    Button("Add") {
                        let pattern = self.newPattern.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !pattern.isEmpty else { return }
                        self.model.addEntry(pattern)
                        self.newPattern = ""
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.newPattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if self.model.entries.isEmpty {
                    Text("No allowlisted commands yet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(self.model.entries, id: \.id) { entry in
                            ExecAllowlistRow(
                                entry: Binding(
                                    get: { self.model.entry(for: entry.id) ?? entry },
                                    set: { self.model.updateEntry($0, id: entry.id) }),
                                onRemove: { self.model.removeEntry(id: entry.id) })
                        }
                    }
                }
            }
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

    var id: String { self.rawValue }

    var title: String {
        switch self {
        case .policy: "Access"
        case .allowlist: "Allowlist"
        }
    }
}

struct ExecAllowlistRow: View {
    @Binding var entry: ExecAllowlistEntry
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
        .onAppear {
            self.draftPattern = self.entry.pattern
        }
    }

    private var patternBinding: Binding<String> {
        Binding(
            get: { self.draftPattern.isEmpty ? self.entry.pattern : self.draftPattern },
            set: { newValue in
                self.draftPattern = newValue
                self.entry.pattern = newValue
            })
    }
}

@MainActor
@Observable
final class ExecApprovalsSettingsModel {
    private static let defaultsScopeId = "__defaults__"
    var agentIds: [String] = []
    var selectedAgentId: String = "main"
    var defaultAgentId: String = "main"
    var security: ExecSecurity = .deny
    var ask: ExecAsk = .onMiss
    var askFallback: ExecSecurity = .deny
    var autoAllowSkills = false
    var entries: [ExecAllowlistEntry] = []
    var skillBins: [String] = []

    var agentPickerIds: [String] {
        [Self.defaultsScopeId] + self.agentIds
    }

    var isDefaultsScope: Bool {
        self.selectedAgentId == Self.defaultsScopeId
    }

    func label(for id: String) -> String {
        if id == Self.defaultsScopeId { return "Defaults" }
        return id
    }

    func refresh() async {
        await self.refreshAgents()
        self.loadSettings(for: self.selectedAgentId)
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
            if !seen.insert(trimmed).inserted { continue }
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
        self.loadSettings(for: id)
        Task { await self.refreshSkillBins() }
    }

    func loadSettings(for agentId: String) {
        if agentId == Self.defaultsScopeId {
            let defaults = ExecApprovalsStore.resolveDefaults()
            self.security = defaults.security
            self.ask = defaults.ask
            self.askFallback = defaults.askFallback
            self.autoAllowSkills = defaults.autoAllowSkills
            self.entries = []
            return
        }
        let resolved = ExecApprovalsStore.resolve(agentId: agentId)
        self.security = resolved.agent.security
        self.ask = resolved.agent.ask
        self.askFallback = resolved.agent.askFallback
        self.autoAllowSkills = resolved.agent.autoAllowSkills
        self.entries = resolved.allowlist
            .sorted { $0.pattern.localizedCaseInsensitiveCompare($1.pattern) == .orderedAscending }
    }

    func setSecurity(_ security: ExecSecurity) {
        self.security = security
        if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.security = security
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.security = security
            }
        }
        self.syncQuickMode()
    }

    func setAsk(_ ask: ExecAsk) {
        self.ask = ask
        if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.ask = ask
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.ask = ask
            }
        }
        self.syncQuickMode()
    }

    func setAskFallback(_ mode: ExecSecurity) {
        self.askFallback = mode
        if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.askFallback = mode
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.askFallback = mode
            }
        }
    }

    func setAutoAllowSkills(_ enabled: Bool) {
        self.autoAllowSkills = enabled
        if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.autoAllowSkills = enabled
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.autoAllowSkills = enabled
            }
        }
        Task { await self.refreshSkillBins(force: enabled) }
    }

    func addEntry(_ pattern: String) {
        guard !self.isDefaultsScope else { return }
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.entries.append(ExecAllowlistEntry(pattern: trimmed, lastUsedAt: nil))
        ExecApprovalsStore.updateAllowlist(agentId: self.selectedAgentId, allowlist: self.entries)
    }

    func updateEntry(_ entry: ExecAllowlistEntry, id: UUID) {
        guard !self.isDefaultsScope else { return }
        guard let index = self.entries.firstIndex(where: { $0.id == id }) else { return }
        self.entries[index] = entry
        ExecApprovalsStore.updateAllowlist(agentId: self.selectedAgentId, allowlist: self.entries)
    }

    func removeEntry(id: UUID) {
        guard !self.isDefaultsScope else { return }
        guard let index = self.entries.firstIndex(where: { $0.id == id }) else { return }
        self.entries.remove(at: index)
        ExecApprovalsStore.updateAllowlist(agentId: self.selectedAgentId, allowlist: self.entries)
    }

    func entry(for id: UUID) -> ExecAllowlistEntry? {
        self.entries.first(where: { $0.id == id })
    }

    func refreshSkillBins(force: Bool = false) async {
        guard self.autoAllowSkills else {
            self.skillBins = []
            return
        }
        let bins = await SkillBinsCache.shared.currentBins(force: force)
        self.skillBins = bins.sorted()
    }

    private func syncQuickMode() {
        if self.isDefaultsScope {
            AppStateStore.shared.execApprovalMode = ExecApprovalQuickMode.from(security: self.security, ask: self.ask)
            return
        }
        if self.selectedAgentId == self.defaultAgentId || self.agentIds.count <= 1 {
            AppStateStore.shared.execApprovalMode = ExecApprovalQuickMode.from(security: self.security, ask: self.ask)
        }
    }
}
