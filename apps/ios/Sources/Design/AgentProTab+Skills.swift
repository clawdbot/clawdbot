import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    var skillsPolicyControls: some View {
        ProCard(radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(self.activeAgentName)
                            .font(.headline)
                        Text(self.skillPolicySummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    ProValuePill(
                        value: self.agentSkillFilter == nil ? "all" : "\(self.agentSkillFilter?.count ?? 0)",
                        color: OpenClawBrand.accent)
                }

                HStack(spacing: 8) {
                    Button("Enable All") {
                        Task { await self.enableAllSkills() }
                    }
                    .disabled(self.skillMutationBusy)

                    Button("Disable All", role: .destructive) {
                        Task { await self.disableAllSkills() }
                    }
                    .disabled(self.skillMutationBusy)

                    Button("Reset") {
                        Task { await self.resetSkillPolicy() }
                    }
                    .disabled(self.skillMutationBusy || self.agentSkillFilter == nil)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                if let skillMutationStatusText {
                    Text(skillMutationStatusText)
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.accent)
                }
                if let skillMutationErrorText {
                    Text(skillMutationErrorText)
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var skillsFilterField: some View {
        ProCard(padding: 10, radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextField("Search skills", text: self.$skillFilter)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.subheadline)
                    if !self.skillFilter.isEmpty {
                        Button {
                            self.skillFilter = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                Picker("Status", selection: self.$skillStatusFilter) {
                    ForEach(SkillStatusFilter.allCases) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var clawHubSearchCard: some View {
        ProCard(radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    ProIconBadge(systemName: "square.and.arrow.down", color: OpenClawBrand.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Install Skills")
                            .font(.headline)
                        Text("Search ClawHub and install into this workspace.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Button {
                        Task { await self.searchClawHubSkills() }
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(self.clawHubLoading || !self.gatewayConnected)
                    .accessibilityLabel("Search ClawHub")
                }

                TextField("Search ClawHub", text: self.$clawHubQuery)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.subheadline)
                    .submitLabel(.search)
                    .onSubmit {
                        Task { await self.searchClawHubSkills() }
                    }

                if self.clawHubLoading {
                    ProgressView()
                        .controlSize(.small)
                }
                if let clawHubErrorText {
                    Text(clawHubErrorText)
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
                if !self.clawHubResults.isEmpty {
                    VStack(spacing: 0) {
                        let results = Array(self.clawHubResults.prefix(8))
                        ForEach(Array(results.enumerated()), id: \.element.slug) { index, result in
                            self.clawHubResultRow(result)
                            if index < results.count - 1 {
                                Divider().padding(.leading, 42)
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    func clawHubResultRow(_ result: ClawHubSearchResultLite) -> some View {
        let installing = self.clawHubInstallSlug == result.slug
        return HStack(alignment: .top, spacing: 10) {
            ProIconBadge(systemName: "sparkles", color: OpenClawBrand.accent)
            VStack(alignment: .leading, spacing: 3) {
                Text(result.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(result.summary ?? result.slug)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Button {
                Task { await self.installClawHubSkill(result) }
            } label: {
                Image(systemName: installing ? "hourglass" : "square.and.arrow.down")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(installing || !self.skillConfigBusyKeys.isEmpty)
            .accessibilityLabel("Install \(result.displayName)")
        }
        .padding(.vertical, 10)
    }

    var skillsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Installed Skills")
            ProCard(padding: 0, radius: AgentLayout.cardRadius) {
                let skills = self.filteredSkills
                if skills.isEmpty {
                    self.emptyDetailRow(
                        icon: "sparkles",
                        title: self.gatewayConnected ? "No skills found" : "Skills unavailable",
                        detail: self.gatewayConnected
                            ? "Try a different search or refresh from the gateway."
                            : "Connect a gateway to load workspace skills.")
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(skills.enumerated()), id: \.element.name) { index, skill in
                            self.skillRow(skill)
                            if index < skills.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    var activeAgentName: String {
        if let agent = self.appModel.gatewayAgents.first(where: { $0.id == self.activeAgentID }) {
            return self.agentName(for: agent)
        }
        return self.activeAgentID
    }

    var agentSkillFilter: Set<String>? {
        self.overview?.agentSkillFilter.map { Set($0) }
    }

    var skillPolicySummary: String {
        guard self.gatewayConnected else { return "Connect a gateway to edit skills." }
        guard let filter = self.agentSkillFilter else {
            return "All available skills are allowed for this agent."
        }
        if filter.isEmpty {
            return "No skills are allowed for this agent."
        }
        return "\(filter.count) skills are allowed for this agent."
    }

    var skillMutationBusy: Bool {
        !self.skillMutationBusyKeys.isEmpty
    }

    var filteredSkills: [SkillStatusEntryLite] {
        let skills = self.overview?.skills?.skills ?? []
        let filter = self.skillFilter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return skills
            .filter { skill in
                self.matchesSkillStatusFilter(skill)
            }
            .filter { skill in
                guard !filter.isEmpty else { return true }
                return [
                    skill.name,
                    skill.description,
                    skill.source,
                ].compactMap(\.self)
                    .joined(separator: " ")
                    .lowercased()
                    .contains(filter)
            }
            .sorted(by: self.sortSkills)
    }

    func matchesSkillStatusFilter(_ skill: SkillStatusEntryLite) -> Bool {
        switch self.skillStatusFilter {
        case .all:
            true
        case .enabled:
            self.skillStatus(skill).text == "enabled"
        case .off:
            !self.isSkillAllowed(skill) || skill.blockedByAgentFilter == true
        case .setup:
            skill.hasMissingRequirements
        case .blocked:
            skill.blockedByAllowlist == true
        }
    }

    func sortSkills(_ lhs: SkillStatusEntryLite, _ rhs: SkillStatusEntryLite) -> Bool {
        let lhsEnabled = self.isSkillAllowed(lhs)
        let rhsEnabled = self.isSkillAllowed(rhs)
        if lhsEnabled != rhsEnabled { return lhsEnabled && !rhsEnabled }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }

    func skillRow(_ skill: SkillStatusEntryLite) -> some View {
        let status = self.skillStatus(skill)
        let busy = self.skillMutationBusyKeys.contains(skill.name)
        return HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: self.isSkillAllowed(skill) ? "checkmark.circle" : "nosign", color: status.color)
            VStack(alignment: .leading, spacing: 4) {
                Text(skill.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.normalized(skill.description) ?? self.normalized(skill.source) ?? "Workspace skill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let missing = skill.missingSummary {
                    Text("Missing: \(missing)")
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                        .lineLimit(1)
                }
                if let install = skill.installSummary {
                    Text("Setup: \(install)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                self.skillToggle(skill, title: status.text)
                HStack(spacing: 6) {
                    if self.canInstallSkillRequirements(skill) {
                        Button {
                            Task { await self.installSkillRequirements(skill) }
                        } label: {
                            Image(systemName: "wrench.and.screwdriver")
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                        .disabled(self.isSkillConfigBusy(skill))
                        .accessibilityLabel("Set up \(skill.displayName)")
                    }
                    Button {
                        self.openSkillEditor(skill)
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .accessibilityLabel("Edit \(skill.displayName)")
                }
                Text(busy ? "saving" : status.text)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(status.color)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    func skillToggle(_ skill: SkillStatusEntryLite, title: String) -> some View {
        Toggle(
            title,
            isOn: Binding(
                get: { self.isSkillAllowed(skill) },
                set: { enabled in
                    Task { await self.setSkillAllowed(skill, enabled: enabled) }
                }))
                .labelsHidden()
                .disabled(self.skillMutationBusy)
                .toggleStyle(.switch)
                .controlSize(.mini)
    }

    func isSkillAllowed(_ skill: SkillStatusEntryLite) -> Bool {
        guard let filter = self.agentSkillFilter else { return true }
        return filter.contains(skill.name)
    }

    func isSkillConfigBusy(_ skill: SkillStatusEntryLite) -> Bool {
        self.skillConfigBusyKeys.contains(skill.effectiveSkillKey)
            || self.clawHubInstallSlug != nil
    }

    func canInstallSkillRequirements(_ skill: SkillStatusEntryLite) -> Bool {
        skill.install?.first?.id?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            && !skill.missingBins.isEmpty
    }

    func skillByKey(_ key: String) -> SkillStatusEntryLite? {
        (self.overview?.skills?.skills ?? []).first { skill in
            skill.effectiveSkillKey == key || skill.name == key
        }
    }

    func openSkillEditor(_ skill: SkillStatusEntryLite) {
        self.skillEditorSelection = SkillEditorSelection(id: skill.effectiveSkillKey)
    }

    func skillAPIKeyBinding(for skill: SkillStatusEntryLite) -> Binding<String> {
        Binding(
            get: { self.skillAPIKeyDrafts[skill.effectiveSkillKey] ?? "" },
            set: { self.skillAPIKeyDrafts[skill.effectiveSkillKey] = $0 })
    }

    var missingSkillEditorSheet: some View {
        NavigationStack {
            ContentUnavailableView("Skill unavailable", systemImage: "sparkles")
                .navigationTitle("Skill")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") {
                            self.skillEditorSelection = nil
                        }
                    }
                }
        }
    }

    func skillEditorSheet(_ skill: SkillStatusEntryLite) -> some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        self.skillEditorHeader(skill)
                        self.skillEditorControls(skill)
                        self.skillEditorSetup(skill)
                        self.skillEditorMetadata(skill)
                    }
                    .padding(.vertical, 18)
                }
            }
            .navigationTitle(skill.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        self.skillEditorSelection = nil
                    }
                }
            }
        }
    }

    func skillEditorHeader(_ skill: SkillStatusEntryLite) -> some View {
        let status = self.skillStatus(skill)
        return ProCard(radius: AgentLayout.cardRadius) {
            HStack(spacing: 12) {
                ProIconBadge(
                    systemName: skill.isGloballyEnabled ? "checkmark.circle" : "pause.circle",
                    color: status.color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(skill.displayName)
                        .font(.headline)
                    Text(self.normalized(skill.description) ?? self.normalized(skill.source) ?? "Workspace skill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                Spacer(minLength: 8)
                ProValuePill(value: status.text, color: status.color)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    func skillEditorControls(_ skill: SkillStatusEntryLite) -> some View {
        ProCard(radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Toggle(
                    "Enabled globally",
                    isOn: Binding(
                        get: { skill.isGloballyEnabled },
                        set: { enabled in
                            Task { await self.updateSkillGlobalEnabled(skill, enabled: enabled) }
                        }))
                        .disabled(self.isSkillConfigBusy(skill))

                if let primaryEnv = skill.primaryEnv, !primaryEnv.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("API key")
                            .font(.subheadline.weight(.semibold))
                        SecureField(primaryEnv, text: self.skillAPIKeyBinding(for: skill))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button {
                            Task { await self.saveSkillAPIKey(skill) }
                        } label: {
                            Label("Save key", systemImage: "key")
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(self.isSkillConfigBusy(skill))
                        if let homepage = skill.homepageURL {
                            Link("Get key", destination: homepage)
                                .font(.caption)
                        }
                    }
                }

                if let message = self.skillConfigMessages[skill.effectiveSkillKey] {
                    Text(message.text)
                        .font(.caption2)
                        .foregroundStyle(message.kind == .success ? OpenClawBrand.accent : OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    func skillEditorSetup(_ skill: SkillStatusEntryLite) -> some View {
        ProCard(radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Setup")
                    .font(.headline)
                if let missing = skill.missingSummary {
                    Text("Missing: \(missing)")
                        .font(.caption)
                        .foregroundStyle(OpenClawBrand.warn)
                } else {
                    Text("No missing requirements reported.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let install = skill.install?.first {
                    Button {
                        Task { await self.installSkillRequirements(skill) }
                    } label: {
                        Label(install.label, systemImage: "wrench.and.screwdriver")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(self.isSkillConfigBusy(skill) || install.id == nil)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    func skillEditorMetadata(_ skill: SkillStatusEntryLite) -> some View {
        ProCard(radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 8) {
                self.detailMetric(label: "Key", value: skill.effectiveSkillKey)
                self.detailMetric(label: "Source", value: self.normalized(skill.source) ?? "unknown")
                if let filePath = self.normalized(skill.filePath) {
                    Text(filePath)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @MainActor
    func setSkillAllowed(_ skill: SkillStatusEntryLite, enabled: Bool) async {
        let allNames = self.allSkillNames
        guard !allNames.isEmpty else { return }
        let base = self.agentSkillFilter ?? Set(allNames)
        var next = base
        if enabled {
            next.insert(skill.name)
        } else {
            next.remove(skill.name)
        }
        await self.patchAgentSkills(Array(next).sorted(), busyKey: skill.name)
    }

    @MainActor
    func enableAllSkills() async {
        let allNames = self.allSkillNames
        guard !allNames.isEmpty else { return }
        await self.patchAgentSkills(allNames, busyKey: "__all__")
    }

    @MainActor
    func disableAllSkills() async {
        await self.patchAgentSkills([], busyKey: "__all__")
    }

    @MainActor
    func resetSkillPolicy() async {
        await self.patchAgentSkills(nil, busyKey: "__all__")
    }

    var allSkillNames: [String] {
        (self.overview?.skills?.skills ?? [])
            .map(\.name)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted()
    }

    @MainActor
    func patchAgentSkills(_ skills: [String]?, busyKey: String) async {
        guard self.gatewayConnected else { return }
        self.skillMutationBusyKeys.insert(busyKey)
        self.skillMutationErrorText = nil
        self.skillMutationStatusText = nil
        defer { self.skillMutationBusyKeys.remove(busyKey) }

        do {
            let config = try await self.requestConfigSnapshot()
            guard let baseHash = self.normalized(config.hash) else {
                throw SkillMutationError.missingConfigHash
            }
            if skills == nil,
               config.agentConfig(id: self.activeAgentID) == nil
            {
                self.skillMutationStatusText = "This agent already inherits the default skill policy."
                return
            }

            let raw = try Self.agentSkillsPatchRaw(agentId: self.activeAgentID, skills: skills)
            let params = ConfigPatchParams(raw: raw, baseHash: baseHash)
            let data = try JSONEncoder().encode(params)
            guard let json = String(data: data, encoding: .utf8) else {
                throw SkillMutationError.invalidPatchPayload
            }
            _ = try await self.appModel.operatorSession.request(
                method: "config.patch",
                paramsJSON: json,
                timeoutSeconds: 20)
            self.skillMutationStatusText = skills == nil ? "Skill policy reset." : "Skill policy saved."
            await self.appModel.refreshGatewayOverviewIfConnected()
            await self.refreshOverview(force: true)
        } catch {
            self.skillMutationErrorText = Self.skillMutationMessage(error)
        }
    }

    @MainActor
    func updateSkillGlobalEnabled(_ skill: SkillStatusEntryLite, enabled: Bool) async {
        await self.runSkillConfigMutation(skill) {
            let params = SkillUpdateParams(skillKey: skill.effectiveSkillKey, enabled: enabled)
            _ = try await self.requestGateway(method: "skills.update", params: params, timeoutSeconds: 20)
            return enabled ? "Skill enabled." : "Skill disabled."
        }
    }

    @MainActor
    func saveSkillAPIKey(_ skill: SkillStatusEntryLite) async {
        await self.runSkillConfigMutation(skill) {
            let apiKey = self.skillAPIKeyDrafts[skill.effectiveSkillKey] ?? ""
            let params = SkillUpdateParams(skillKey: skill.effectiveSkillKey, apiKey: apiKey)
            _ = try await self.requestGateway(method: "skills.update", params: params, timeoutSeconds: 20)
            self.skillAPIKeyDrafts[skill.effectiveSkillKey] = ""
            return apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "API key cleared."
                : "API key saved."
        }
    }

    @MainActor
    func installSkillRequirements(_ skill: SkillStatusEntryLite) async {
        guard let installId = skill.install?.first?.id?.trimmingCharacters(in: .whitespacesAndNewlines),
              !installId.isEmpty
        else { return }
        await self.runSkillConfigMutation(skill) {
            let params = SkillInstallParams(name: skill.name, installId: installId, timeoutMs: 120_000)
            let data = try await self.requestGateway(
                method: "skills.install",
                params: params,
                timeoutSeconds: 125)
            return (try? JSONDecoder().decode(SkillInstallResultLite.self, from: data).message) ?? "Installed."
        }
    }

    @MainActor
    func installClawHubSkill(_ result: ClawHubSearchResultLite) async {
        guard self.gatewayConnected else { return }
        self.clawHubInstallSlug = result.slug
        self.clawHubErrorText = nil
        defer { self.clawHubInstallSlug = nil }
        do {
            let params = ClawHubInstallParams(slug: result.slug)
            _ = try await self.requestGateway(method: "skills.install", params: params, timeoutSeconds: 125)
            await self.appModel.refreshGatewayOverviewIfConnected()
            await self.refreshOverview(force: true)
        } catch {
            self.clawHubErrorText = Self.skillMutationMessage(error)
        }
    }

    @MainActor
    func searchClawHubSkills() async {
        guard self.gatewayConnected else { return }
        self.clawHubLoading = true
        self.clawHubErrorText = nil
        defer { self.clawHubLoading = false }
        do {
            let query = self.clawHubQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            let params = ClawHubSearchParams(query: query.isEmpty ? nil : query, limit: 20)
            let data = try await self.requestGateway(method: "skills.search", params: params, timeoutSeconds: 20)
            self.clawHubResults = try JSONDecoder().decode(ClawHubSearchResponseLite.self, from: data).results
        } catch {
            self.clawHubErrorText = Self.skillMutationMessage(error)
        }
    }

    @MainActor
    func runSkillConfigMutation(
        _ skill: SkillStatusEntryLite,
        action: () async throws -> String) async
    {
        let key = skill.effectiveSkillKey
        self.skillConfigBusyKeys.insert(key)
        self.skillConfigMessages[key] = nil
        defer { self.skillConfigBusyKeys.remove(key) }

        do {
            let message = try await action()
            self.skillConfigMessages[key] = SkillEditorMessage(kind: .success, text: message)
            await self.appModel.refreshGatewayOverviewIfConnected()
            await self.refreshOverview(force: true)
        } catch {
            self.skillConfigMessages[key] = SkillEditorMessage(
                kind: .error,
                text: Self.skillMutationMessage(error))
        }
    }

    func requestGateway(
        method: String,
        params: some Encodable,
        timeoutSeconds: Int) async throws -> Data
    {
        let data = try JSONEncoder().encode(params)
        guard let json = String(data: data, encoding: .utf8) else {
            throw SkillMutationError.invalidPatchPayload
        }
        return try await self.appModel.operatorSession.request(
            method: method,
            paramsJSON: json,
            timeoutSeconds: timeoutSeconds)
    }

    func requestConfigSnapshot() async throws -> ConfigSnapshotLite {
        let data = try await self.appModel.operatorSession.request(
            method: "config.get",
            paramsJSON: "{}",
            timeoutSeconds: 12)
        return try JSONDecoder().decode(ConfigSnapshotLite.self, from: data)
    }

    static func agentSkillsPatchRaw(agentId: String, skills: [String]?) throws -> String {
        let skillValue: Any = skills ?? NSNull()
        let patch: [String: Any] = [
            "agents": [
                "list": [
                    [
                        "id": agentId,
                        "skills": skillValue,
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: patch, options: [.sortedKeys])
        guard let raw = String(data: data, encoding: .utf8) else {
            throw SkillMutationError.invalidPatchPayload
        }
        return raw
    }

    static func skillMutationMessage(_ error: Error) -> String {
        if let gatewayError = error as? GatewayResponseError {
            let lower = gatewayError.message.lowercased()
            if lower.contains("operator.admin") || lower.contains("unauthorized") {
                return "This gateway connection cannot edit config yet. Reconnect with admin scope."
            }
            return gatewayError.message
        }
        return error.localizedDescription
    }

    func skillStatus(_ skill: SkillStatusEntryLite) -> (text: String, color: Color) {
        if !self.isSkillAllowed(skill) {
            return ("off", .secondary)
        }
        if skill.blockedByAllowlist == true {
            return ("blocked", .secondary)
        }
        if skill.blockedByAgentFilter == true {
            return ("off", .secondary)
        }
        if skill.disabled == true {
            return ("disabled", .secondary)
        }
        if skill.hasMissingRequirements {
            return ("setup", OpenClawBrand.warn)
        }
        return ("enabled", OpenClawBrand.accent)
    }
}
