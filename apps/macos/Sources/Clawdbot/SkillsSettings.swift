import MoltbotProtocol
import Observation
import SwiftUI

struct SkillsSettings: View {
    @Bindable var state: AppState
    @State private var model = SkillsSettingsModel()
    @State private var envEditor: EnvEditorState?
    @State private var filter: SkillsFilter = .all

    init(state: AppState = AppStateStore.shared, model: SkillsSettingsModel = SkillsSettingsModel()) {
        self.state = state
        self._model = State(initialValue: model)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.header
            self.statusBanner
            self.skillsList
            Spacer(minLength: 0)
        }
        .task { await self.model.refresh() }
        .sheet(item: self.$envEditor) { editor in
            EnvEditorView(editor: editor) { value in
                Task {
                    await self.model.updateEnv(
                        skillKey: editor.skillKey,
                        envKey: editor.envKey,
                        value: value,
                        isPrimary: editor.isPrimary)
                }
            }
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Skills")
                    .font(.headline)
                Text("Skills are enabled when requirements are met (binaries, env, config).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if self.model.isLoading {
                ProgressView()
            } else {
                Button {
                    Task { await self.model.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .help("Refresh")
            }
            self.headerFilter
        }
    }

    @ViewBuilder
    private var statusBanner: some View {
        if let error = self.model.error {
            Text(error)
                .font(.footnote)
                .foregroundStyle(.orange)
        } else if let message = self.model.statusMessage {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var skillsList: some View {
        if self.model.skills.isEmpty {
            Text("No skills reported yet.")
                .foregroundStyle(.secondary)
        } else {
            List {
                ForEach(self.filteredSkills) { skill in
                    SkillRow(
                        skill: skill,
                        isBusy: self.model.isBusy(skill: skill),
                        connectionMode: self.state.connectionMode,
                        onToggleEnabled: { enabled in
                            Task { await self.model.setEnabled(skillKey: skill.skillKey, enabled: enabled) }
                        },
                        onInstall: { option, target in
                            Task { await self.model.install(skill: skill, option: option, target: target) }
                        },
                        onSetEnv: { envKey, isPrimary in
                            self.envEditor = EnvEditorState(
                                skillKey: skill.skillKey,
                                skillName: skill.name,
                                envKey: envKey,
                                isPrimary: isPrimary)
                        })
                }
                if !self.model.skills.isEmpty, self.filteredSkills.isEmpty {
                    Text("No skills match this filter.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .listStyle(.inset)
        }
    }

    private var headerFilter: some View {
        Picker("Filter", selection: self.$filter) {
            ForEach(SkillsFilter.allCases) { filter in
                Text(filter.title)
                    .tag(filter)
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .frame(width: 160, alignment: .trailing)
    }

    private var filteredSkills: [SkillStatus] {
        self.model.skills.filter { skill in
            switch self.filter {
            case .all:
                true
            case .ready:
                !skill.disabled && skill.eligible
            case .needsSetup:
                !skill.disabled && !skill.eligible
            case .disabled:
                skill.disabled
            }
        }
    }
}

private enum SkillsFilter: String, CaseIterable, Identifiable {
    case all
    case ready
    case needsSetup
    case disabled

    var id: String { self.rawValue }

    var title: String {
        switch self {
        case .all:
            "All"
        case .ready:
            "Ready"
        case .needsSetup:
            "Needs Setup"
        case .disabled:
            "Disabled"
        }
    }
}

private enum InstallTarget: String, CaseIterable {
    case gateway
    case local
}

private struct SkillRow: View {
    let skill: SkillStatus
    let isBusy: Bool
    let connectionMode: AppState.ConnectionMode
    let onToggleEnabled: (Bool) -> Void
    let onInstall: (SkillInstallOption, InstallTarget) -> Void
    let onSetEnv: (String, Bool) -> Void

    private var missingBins: [String] { self.skill.missing.bins }
    private var missingEnv: [String] { self.skill.missing.env }
    private var missingConfig: [String] { self.skill.missing.config }

    init(
        skill: SkillStatus,
        isBusy: Bool,
        connectionMode: AppState.ConnectionMode,
        onToggleEnabled: @escaping (Bool) -> Void,
        onInstall: @escaping (SkillInstallOption, InstallTarget) -> Void,
        onSetEnv: @escaping (String, Bool) -> Void)
    {
        self.skill = skill
        self.isBusy = isBusy
        self.connectionMode = connectionMode
        self.onToggleEnabled = onToggleEnabled
        self.onInstall = onInstall
        self.onSetEnv = onSetEnv
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(self.skill.emoji ?? "✨")
                .font(.title2)

            VStack(alignment: .leading, spacing: 6) {
                Text(self.skill.name)
                    .font(.headline)
                Text(self.skill.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                self.metaRow

                if self.skill.disabled {
                    Text("Disabled in config")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if !self.requirementsMet, self.shouldShowMissingSummary {
                    self.missingSummary
                }

                if !self.skill.configChecks.isEmpty {
                    self.configChecksView
                }

                if !self.missingEnv.isEmpty {
                    self.envActionRow
                }
            }

            Spacer(minLength: 0)

            self.trailingActions
        }
        .padding(.vertical, 6)
    }

    private var sourceLabel: String {
        switch self.skill.source {
        case "moltbot-bundled":
            "Bundled"
        case "moltbot-managed":
            "Managed"
        case "moltbot-workspace":
            "Workspace"
        case "moltbot-extra":
            "Extra"
        default:
            self.skill.source
        }
    }

    private var metaRow: some View {
        HStack(spacing: 10) {
            SkillTag(text: self.sourceLabel)
            if let url = self.homepageUrl {
                Link(destination: url) {
                    Label("Website", systemImage: "link")
                        .font(.caption2.weight(.semibold))
                }
                .buttonStyle(.link)
            }
            Spacer(minLength: 0)
        }
    }

    private var homepageUrl: URL? {
        guard let raw = self.skill.homepage?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        guard !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { !self.skill.disabled },
            set: { self.onToggleEnabled($0) })
    }

    @ViewBuilder
    private var missingSummary: some View {
        VStack(alignment: .leading, spacing: 4) {
            if self.shouldShowMissingBins {
                Text("Missing binaries: \(self.missingBins.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !self.missingEnv.isEmpty {
                Text("Missing env: \(self.missingEnv.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !self.missingConfig.isEmpty {
                Text("Requires config: \(self.missingConfig.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var configChecksView: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(self.skill.configChecks) { check in
                HStack(spacing: 6) {
                    Image(systemName: check.satisfied ? "checkmark.circle" : "xmark.circle")
                        .foregroundStyle(check.satisfied ? .green : .secondary)
                    Text(check.path)
                        .font(.caption)
                    Text(self.formatConfigValue(check.value))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var envActionRow: some View {
        HStack(spacing: 8) {
            ForEach(self.missingEnv, id: \.self) { envKey in
                let isPrimary = envKey == self.skill.primaryEnv
                Button(isPrimary ? "Set API Key" : "Set \(envKey)") {
                    self.onSetEnv(envKey, isPrimary)
                }
                .buttonStyle(.bordered)
                .disabled(self.isBusy)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var trailingActions: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if !self.installOptions.isEmpty {
                ForEach(self.installOptions, id: \.id) { (option: SkillInstallOption) in
                    HStack(spacing: 6) {
                        if self.showGatewayInstall {
                            Button("Install on Gateway") { self.onInstall(option, .gateway) }
                                .buttonStyle(.borderedProminent)
                                .disabled(self.isBusy)
                        }
                        if self.showGatewayInstall {
                            Button("Install on This Mac") { self.onInstall(option, .local) }
                                .buttonStyle(.bordered)
                                .disabled(self.isBusy)
                                .help(
                                    self.localInstallNeedsSwitch
                                        ? "Switches to Local mode to install on this Mac."
                                        : "")
                        } else {
                            Button("Install on This Mac") { self.onInstall(option, .local) }
                                .buttonStyle(.borderedProminent)
                                .disabled(self.isBusy)
                                .help(
                                    self.localInstallNeedsSwitch
                                        ? "Switches to Local mode to install on this Mac."
                                        : "")
                        }
                    }
                }
            } else {
                Toggle("", isOn: self.enabledBinding)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .disabled(self.isBusy || !self.requirementsMet)
            }

            if self.isBusy {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    private var installOptions: [SkillInstallOption] {
        guard !self.missingBins.isEmpty else { return [] }
        let missing = Set(self.missingBins)
        return self.skill.install.filter { option in
            if option.bins.isEmpty { return true }
            return !missing.isDisjoint(with: option.bins)
        }
    }

    private var requirementsMet: Bool {
        self.missingBins.isEmpty && self.missingEnv.isEmpty && self.missingConfig.isEmpty
    }

    private var shouldShowMissingBins: Bool {
        !self.missingBins.isEmpty && self.installOptions.isEmpty
    }

    private var shouldShowMissingSummary: Bool {
        self.shouldShowMissingBins ||
            !self.missingEnv.isEmpty ||
            !self.missingConfig.isEmpty
    }

    private var showGatewayInstall: Bool {
        self.connectionMode == .remote
    }

    private var localInstallNeedsSwitch: Bool {
        self.connectionMode != .local
    }

    private func formatConfigValue(_ value: AnyCodable?) -> String {
        guard let value else { return "" }
        switch value.value {
        case let bool as Bool:
            return bool ? "true" : "false"
        case let int as Int:
            return String(int)
        case let double as Double:
            return String(double)
        case let string as String:
            return string
        default:
            return ""
        }
    }
}

private struct SkillTag: View {
    let text: String

    var body: some View {
        Text(self.text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.12))
            .clipShape(Capsule())
    }
}

private struct EnvEditorState: Identifiable {
    let skillKey: String
    let skillName: String
    let envKey: String
    let isPrimary: Bool

    var id: String { "\(self.skillKey)::\(self.envKey)" }
}

private struct EnvEditorView: View {
    let editor: EnvEditorState
    let onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var value: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(self.title)
                .font(.headline)
            Text(self.subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            SecureField(self.editor.envKey, text: self.$value)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Cancel") { self.dismiss() }
                Spacer()
                Button("Save") {
                    self.onSave(self.value)
                    self.dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 420)
    }

    private var title: String {
        self.editor.isPrimary ? "Set API Key" : "Set Environment Variable"
    }

    private var subtitle: String {
        "Skill: \(self.editor.skillName)"
    }
}

@MainActor
@Observable
final class SkillsSettingsModel {
    var skills: [SkillStatus] = []
    var isLoading = false
    var error: String?
    var statusMessage: String?
    private var busySkills: Set<String> = []

    func isBusy(skill: SkillStatus) -> Bool {
        self.busySkills.contains(skill.skillKey)
    }

    func refresh() async {
        guard !self.isLoading else { return }
        self.isLoading = true
        self.error = nil
        do {
            let report = try await GatewayConnection.shared.skillsStatus()
            self.skills = report.skills.sorted { $0.name < $1.name }
        } catch {
            self.error = error.localizedDescription
        }
        self.isLoading = false
    }

    fileprivate func install(skill: SkillStatus, option: SkillInstallOption, target: InstallTarget) async {
        await self.withBusy(skill.skillKey) {
            do {
                if target == .local, AppStateStore.shared.connectionMode != .local {
                    AppStateStore.shared.connectionMode = .local
                    self.statusMessage = "Switched to Local mode to install on this Mac"
                }
                let result = try await GatewayConnection.shared.skillsInstall(
                    name: skill.name,
                    installId: option.id,
                    timeoutMs: 300_000)
                self.statusMessage = result.message
            } catch {
                self.statusMessage = error.localizedDescription
            }
            await self.refresh()
        }
    }

    func setEnabled(skillKey: String, enabled: Bool) async {
        await self.withBusy(skillKey) {
            do {
                _ = try await GatewayConnection.shared.skillsUpdate(
                    skillKey: skillKey,
                    enabled: enabled)
                self.statusMessage = enabled ? "Skill enabled" : "Skill disabled"
            } catch {
                self.statusMessage = error.localizedDescription
            }
            await self.refresh()
        }
    }

    func updateEnv(skillKey: String, envKey: String, value: String, isPrimary: Bool) async {
        await self.withBusy(skillKey) {
            do {
                if isPrimary {
                    _ = try await GatewayConnection.shared.skillsUpdate(
                        skillKey: skillKey,
                        apiKey: value)
                    self.statusMessage = "Saved API key"
                } else {
                    _ = try await GatewayConnection.shared.skillsUpdate(
                        skillKey: skillKey,
                        env: [envKey: value])
                    self.statusMessage = "Saved \(envKey)"
                }
            } catch {
                self.statusMessage = error.localizedDescription
            }
            await self.refresh()
        }
    }

    private func withBusy(_ id: String, _ work: @escaping () async -> Void) async {
        self.busySkills.insert(id)
        defer { self.busySkills.remove(id) }
        await work()
    }
}

#if DEBUG
struct SkillsSettings_Previews: PreviewProvider {
    static var previews: some View {
        SkillsSettings(state: .preview)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}

extension SkillsSettings {
    static func exerciseForTesting() {
        let skill = SkillStatus(
            name: "Test Skill",
            description: "Test description",
            source: "moltbot-bundled",
            filePath: "/tmp/skills/test",
            baseDir: "/tmp/skills",
            skillKey: "test",
            primaryEnv: "API_KEY",
            emoji: "🧪",
            homepage: "https://example.com",
            always: false,
            disabled: false,
            eligible: false,
            requirements: SkillRequirements(bins: ["python3"], env: ["API_KEY"], config: ["skills.test"]),
            missing: SkillMissing(bins: ["python3"], env: ["API_KEY"], config: ["skills.test"]),
            configChecks: [
                SkillStatusConfigCheck(path: "skills.test", value: AnyCodable(false), satisfied: false),
            ],
            install: [
                SkillInstallOption(id: "brew", kind: "brew", label: "brew install python", bins: ["python3"]),
            ])

        let row = SkillRow(
            skill: skill,
            isBusy: false,
            connectionMode: .remote,
            onToggleEnabled: { _ in },
            onInstall: { _, _ in },
            onSetEnv: { _, _ in })
        _ = row.body

        _ = SkillTag(text: "Bundled").body

        let editor = EnvEditorView(
            editor: EnvEditorState(
                skillKey: "test",
                skillName: "Test Skill",
                envKey: "API_KEY",
                isPrimary: true),
            onSave: { _ in })
        _ = editor.body
    }

    mutating func setFilterForTesting(_ rawValue: String) {
        guard let filter = SkillsFilter(rawValue: rawValue) else { return }
        self.filter = filter
    }
}
#endif
