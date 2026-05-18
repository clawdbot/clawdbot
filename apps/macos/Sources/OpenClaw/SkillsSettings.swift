import Observation
import OpenClawProtocol
import SwiftUI

struct SkillsSettings: View {
    @Bindable var state: AppState
    @State private var model = SkillsSettingsModel()
    @State private var envEditor: EnvEditorState?
    @State private var filter: SkillsFilter = .all
    @State private var didScheduleInitialRefresh = false

    init(state: AppState = AppStateStore.shared, model: SkillsSettingsModel = SkillsSettingsModel()) {
        self.state = state
        self._model = State(initialValue: model)
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                SettingsPageHeader(
                    title: "Skills",
                    subtitle: "Optional capabilities that become available when their requirements are met.")

                self.skillsSummaryPanel
                self.controlsCard
                self.statusBanner
                self.skillsList
                Spacer(minLength: 8)
            }
            .frame(maxWidth: 860, alignment: .leading)
            .padding(.trailing, SettingsLayout.scrollbarGutter)
            .padding(.vertical, 4)
        }
        .task {
            guard !self.didScheduleInitialRefresh else { return }
            self.didScheduleInitialRefresh = true
            await Task.yield()
            await self.model.refreshIfNeeded()
        }
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

    private var skillsSummaryPanel: some View {
        let total = self.model.skills.count
        let ready = self.model.skills.count(where: { !$0.disabled && $0.eligible })
        let needsSetup = self.model.skills.count(where: { !$0.disabled && !$0.eligible })

        return HStack(alignment: .center, spacing: 14) {
            ZStack {
                Circle()
                    .fill(Color.accentColor.opacity(0.18))
                Image(systemName: "sparkles")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
            }
            .frame(width: 46, height: 46)

            VStack(alignment: .leading, spacing: 4) {
                Text(total == 0 ? "Loading skills" : "\(ready) ready · \(needsSetup) need setup")
                    .font(.headline)
                Text("Enable ready skills, or install missing tools on the Gateway or this Mac.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 18)

            if total > 0 {
                Text("\(total)")
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.white.opacity(0.06))
        }
    }

    private var controlsCard: some View {
        SettingsCardGroup("Controls") {
            SettingsCardRow(
                title: "Skill catalog",
                subtitle: "Refresh after changing binaries, environment variables, or skill config.",
                showsDivider: false)
            {
                if self.model.isLoading {
                    ProgressView()
                        .controlSize(.small)
                }
                Button {
                    Task { await self.model.refresh(force: true) }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .help("Refresh")

                self.headerFilter
            }
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
            SettingsCardGroup("Skills") {
                SettingsCardRow(
                    title: self.model.isLoading ? "Loading…" : "No skills reported yet",
                    subtitle: self.model.isLoading ? "Reading the Gateway skill catalog." : nil,
                    showsDivider: false)
                {
                    if self.model.isLoading {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
            }
        } else {
            SettingsCardGroup("Skills") {
                LazyVStack(spacing: 0) {
                    ForEach(Array(self.filteredSkills.enumerated()), id: \.element.id) { index, skill in
                        SkillRow(
                            skill: skill,
                            isBusy: self.model.isBusy(skill: skill),
                            connectionMode: self.state.connectionMode,
                            showsDivider: index != self.filteredSkills.count - 1,
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
                                    isPrimary: isPrimary,
                                    homepage: skill.homepage)
                            })
                    }
                    if !self.model.skills.isEmpty, self.filteredSkills.isEmpty {
                        SettingsCardRow(
                            title: "No skills match this filter.",
                            showsDivider: false)
                        {
                            EmptyView()
                        }
                    }
                }
            }
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
        .frame(width: 150, alignment: .trailing)
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

    var id: String {
        self.rawValue
    }

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
    let showsDivider: Bool
    let onToggleEnabled: (Bool) -> Void
    let onInstall: (SkillInstallOption, InstallTarget) -> Void
    let onSetEnv: (String, Bool) -> Void
    @State private var isExpanded = false

    private var missingBins: [String] {
        self.skill.missing.bins
    }

    private var missingEnv: [String] {
        self.skill.missing.env
    }

    private var missingConfig: [String] {
        self.skill.missing.config
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Text(self.skill.emoji ?? "✨")
                    .font(.title3)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(self.skill.name)
                            .font(.headline)
                            .lineLimit(1)
                        SkillTag(text: self.statusLabel, color: self.statusColor)
                        SkillTag(text: self.sourceLabel)
                        if let url = self.homepageUrl {
                            Link(destination: url) {
                                Label("Website", systemImage: "link")
                                    .labelStyle(.iconOnly)
                                    .font(.caption)
                            }
                            .buttonStyle(.link)
                        }
                        Spacer(minLength: 0)
                    }

                    Text(self.skill.description)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(self.isExpanded ? 5 : 2)
                        .fixedSize(horizontal: false, vertical: true)

                    if self.shouldShowMissingSummary {
                        self.compactMissingSummary
                    }

                    if self.hasDetails {
                        DisclosureGroup(isExpanded: self.$isExpanded) {
                            VStack(alignment: .leading, spacing: 8) {
                                if self.shouldShowMissingSummary {
                                    self.missingSummary
                                }
                                if !self.skill.configChecks.isEmpty {
                                    self.configChecksView
                                }
                                if !self.missingEnv.isEmpty {
                                    self.envActionRow
                                }
                            }
                            .padding(.top, 6)
                        } label: {
                            Text("Details")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Spacer(minLength: 0)

                self.trailingActions
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            if self.showsDivider {
                Divider()
                    .padding(.leading, 54)
                    .padding(.trailing, 14)
            }
        }
    }

    private var statusLabel: String {
        if self.skill.disabled {
            return "Disabled"
        }
        return self.requirementsMet && self.skill.eligible ? "Ready" : "Needs setup"
    }

    private var statusColor: Color {
        if self.skill.disabled {
            return .secondary
        }
        return self.requirementsMet && self.skill.eligible ? .green : .orange
    }

    private var sourceLabel: String {
        switch self.skill.source {
        case "openclaw-bundled":
            "Bundled"
        case "openclaw-managed":
            "Managed"
        case "openclaw-workspace":
            "Workspace"
        case "openclaw-extra":
            "Extra"
        case "openclaw-plugin":
            "Plugin"
        default:
            self.skill.source
        }
    }

    private var hasDetails: Bool {
        self.shouldShowMissingSummary || !self.skill.configChecks.isEmpty || !self.missingEnv.isEmpty
    }

    private var compactMissingSummary: some View {
        HStack(spacing: 6) {
            Image(systemName: self.skill.disabled ? "pause.circle" : "exclamationmark.triangle")
                .foregroundStyle(self.statusColor)
            Text(self.compactMissingText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var compactMissingText: String {
        if self.skill.disabled {
            return "Disabled in config"
        }
        if !self.missingBins.isEmpty {
            return "Missing \(self.missingBins.prefix(2).joined(separator: ", "))"
        }
        if !self.missingEnv.isEmpty {
            return "Needs \(self.missingEnv.prefix(2).joined(separator: ", "))"
        }
        if !self.missingConfig.isEmpty {
            return "Needs config"
        }
        return "Needs setup"
    }

    private var homepageUrl: URL? {
        guard let raw = self.skill.homepage?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        guard
            !raw.isEmpty,
            let url = URL(string: raw),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https"
        else {
            return nil
        }
        return url
    }

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { !self.skill.disabled },
            set: { self.onToggleEnabled($0) })
    }

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
    var color: Color = .secondary

    var body: some View {
        Text(self.text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(self.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(self.color.opacity(0.12))
            .clipShape(Capsule())
    }
}

private struct EnvEditorState: Identifiable {
    let skillKey: String
    let skillName: String
    let envKey: String
    let isPrimary: Bool
    let homepage: String?

    var id: String {
        "\(self.skillKey)::\(self.envKey)"
    }
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
            if let homepageUrl = self.homepageUrl {
                Link("Get your key →", destination: homepageUrl)
                    .font(.caption)
            }
            SecureField(self.editor.envKey, text: self.$value)
                .textFieldStyle(.roundedBorder)
            Text("Saved to openclaw.json under skills.entries.\(self.editor.skillKey)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
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

    private var homepageUrl: URL? {
        guard let raw = self.editor.homepage?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        guard
            !raw.isEmpty,
            let url = URL(string: raw),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https"
        else {
            return nil
        }
        return url
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
    private var hasLoaded = false
    private var busySkills: Set<String> = []

    func isBusy(skill: SkillStatus) -> Bool {
        self.busySkills.contains(skill.skillKey)
    }

    func refreshIfNeeded() async {
        guard !self.hasLoaded else { return }
        await self.refresh()
    }

    func refresh(force: Bool = false) async {
        guard !self.isLoading else { return }
        if self.hasLoaded, !force {
            return
        }
        self.isLoading = true
        self.error = nil
        do {
            let report = try await GatewayConnection.shared.skillsStatus()
            self.skills = report.skills.sorted { $0.name < $1.name }
            self.hasLoaded = true
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
            await self.refresh(force: true)
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
            await self.refresh(force: true)
        }
    }

    func updateEnv(skillKey: String, envKey: String, value: String, isPrimary: Bool) async {
        await self.withBusy(skillKey) {
            do {
                if isPrimary {
                    _ = try await GatewayConnection.shared.skillsUpdate(
                        skillKey: skillKey,
                        apiKey: value)
                    self.statusMessage = "Saved API key — stored in openclaw.json (skills.entries.\(skillKey))"
                } else {
                    _ = try await GatewayConnection.shared.skillsUpdate(
                        skillKey: skillKey,
                        env: [envKey: value])
                    self.statusMessage = "Saved \(envKey) — stored in openclaw.json (skills.entries.\(skillKey).env)"
                }
            } catch {
                self.statusMessage = error.localizedDescription
            }
            await self.refresh(force: true)
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
            source: "openclaw-bundled",
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
            showsDivider: false,
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
                isPrimary: true,
                homepage: "https://example.com"),
            onSave: { _ in })
        _ = editor.body
    }

    mutating func setFilterForTesting(_ rawValue: String) {
        guard let filter = SkillsFilter(rawValue: rawValue) else { return }
        self.filter = filter
    }
}
#endif
