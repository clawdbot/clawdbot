import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    func agentName(for agent: AgentSummary) -> String {
        self.normalized(agent.name) ?? agent.id
    }

    func agentBadge(for agent: AgentSummary) -> String {
        if let identity = agent.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = self.normalized(emoji)
        {
            return normalizedEmoji
        }

        let words = self.agentName(for: agent)
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        return initials.isEmpty ? "OC" : initials.uppercased()
    }

    func agentTint(for agent: AgentSummary, state: AgentRosterState) -> Color {
        if agent.id == self.activeAgentID { return OpenClawBrand.accent }
        return state.color.opacity(0.62)
    }

    func agentDetail(for agent: AgentSummary) -> String {
        let parts = [
            self.normalized(agent.workspace),
            self.modelLabel(for: agent),
            agent.id == self.appModel.gatewayDefaultAgentId ? "default" : nil,
        ].compactMap(\.self)
        return parts.isEmpty ? agent.id : parts.joined(separator: " • ")
    }

    func agentSessionSummary(_ agent: AgentSummary) -> String {
        guard self.gatewayConnected else { return "0" }
        if agent.id == self.activeAgentID {
            return self.appModel.isOperatorGatewayConnected ? "1 running" : "0"
        }
        return "0"
    }

    func agentRuntimeSummary(_ agent: AgentSummary) -> String {
        if let runtime = agent.agentruntime,
           let id = runtime["id"]?.value as? String,
           let normalized = self.normalized(id)
        {
            return normalized
        }
        if let model = self.modelLabel(for: agent) {
            return Self.shortModelLabel(model)
        }
        return "default"
    }

    func agentRosterState(for agent: AgentSummary) -> AgentRosterState {
        guard self.gatewayConnected else { return .idle }
        if agent.id == self.activeAgentID { return .online }
        if self.cronJobsContain(agentID: agent.id) { return .busy }
        return .idle
    }

    func cronJobsContain(agentID: String) -> Bool {
        self.recentCronJobs.contains { job in
            self.normalized(job.agentid) == agentID && job.enabled
        }
    }

    func modelLabel(for agent: AgentSummary) -> String? {
        guard let model = agent.model else { return nil }
        for key in ["primary", "name", "id", "model"] {
            if let value = model[key]?.value as? String,
               let normalized = self.normalized(value)
            {
                return normalized
            }
        }
        return nil
    }

    static func shortModelLabel(_ model: String) -> String {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "default" }
        let leaf = trimmed.split(separator: "/").last.map(String.init) ?? trimmed
        return leaf
            .replacingOccurrences(of: "claude-", with: "")
            .replacingOccurrences(of: "gpt-", with: "")
    }

    func presenceLabel(_ entry: PresenceEntry) -> String? {
        self.normalized(entry.host)
            ?? self.normalized(entry.devicefamily)
            ?? self.normalized(entry.platform)
            ?? self.normalized(entry.mode)
    }

    func cronJobDetail(_ job: CronJob) -> String {
        if let nextRunAtMs = AgentProValueReader.intValue(job.state["nextRunAtMs"]) {
            return "Next \(Self.relativeTime(fromMilliseconds: nextRunAtMs))"
        }
        if let description = self.normalized(job.description) {
            return description
        }
        if let agentId = self.normalized(job.agentid) {
            return agentId
        }
        return job.id
    }

    func cronJobState(_ job: CronJob) -> String {
        if !job.enabled {
            return "paused"
        }
        if let status = Self.stringValue(job.state["lastStatus"]) ?? Self.stringValue(job.state["lastRunStatus"]) {
            return status
        }
        return "enabled"
    }

    @MainActor
    func refreshOverview(force: Bool) async {
        guard self.scenePhase == .active else { return }
        guard self.appModel.isOperatorGatewayConnected else {
            self.overview = nil
            self.overviewErrorText = nil
            self.overviewLoading = false
            return
        }
        if self.overviewLoading, force == false {
            return
        }

        self.overviewLoading = true
        self.overviewErrorText = nil
        defer { self.overviewLoading = false }

        let activeAgentID = self.activeAgentID
        let skillsParams = Self.agentScopedParams(agentId: activeAgentID)
        async let skills = self.requestOptional(
            SkillStatusReportLite.self,
            method: "skills.status",
            paramsJSON: skillsParams)
        async let config = self.requestOptional(ConfigSnapshotLite.self, method: "config.get")
        async let presence = self.requestOptional([PresenceEntry].self, method: "system-presence")
        async let cronStatus = self.requestOptional(CronStatusLite.self, method: "cron.status")
        async let cronJobs = self.requestOptional(
            CronJobsListLite.self,
            method: "cron.list",
            paramsJSON: "{\"includeDisabled\":true,\"limit\":8,\"sortBy\":\"nextRunAtMs\",\"sortDir\":\"asc\"}",
            timeoutSeconds: 12)
        async let dreaming = self.requestOptional(DreamingStatusEnvelope.self, method: "doctor.memory.status")
        async let dreamDiary = self.requestOptional(DreamDiaryLite.self, method: "doctor.memory.dreamDiary")
        async let usage = self.requestOptional(
            CostUsageSummaryLite.self,
            method: "usage.cost",
            paramsJSON: "{\"days\":31}",
            timeoutSeconds: 12)

        let loadedSkills = await skills
        let loadedConfig = await config
        let loadedPresence = await presence
        let loadedCronStatus = await cronStatus
        let loadedCronJobs = await cronJobs
        let loadedDreaming = await dreaming
        let loadedDreamDiary = await dreamDiary
        let loadedUsage = await usage
        let snapshot = AgentOverviewSnapshot(
            skills: loadedSkills,
            presence: loadedPresence ?? [],
            cronStatus: loadedCronStatus,
            cronJobs: loadedCronJobs?.jobs ?? [],
            dreaming: loadedDreaming?.dreaming,
            dreamDiary: loadedDreamDiary,
            usage: loadedUsage,
            activeAgentId: activeAgentID,
            agentSkillFilter: loadedSkills?.agentSkillFilter
                ?? loadedConfig?.effectiveSkillFilter(agentId: activeAgentID),
            loadedAt: Date())

        if snapshot.hasAnyLiveData {
            self.overview = snapshot
        } else {
            self.overview = snapshot
            self.overviewErrorText = "Live overview could not load yet."
        }
    }

    func requestOptional<T: Decodable>(
        _ type: T.Type,
        method: String,
        paramsJSON: String = "{}",
        timeoutSeconds: Int = 8) async -> T?
    {
        do {
            let data = try await self.appModel.operatorSession.request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: timeoutSeconds)
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
        }
    }

    func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func stringValue(_ value: AnyCodable?) -> String? {
        guard let string = value?.value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func relativeTime(fromMilliseconds milliseconds: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    static func compactNumber(_ value: Int) -> String {
        value.formatted(.number.notation(.compactName))
    }

    static func currency(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(0...2)))
    }

    static func duration(milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    static func agentScopedParams(agentId: String) -> String {
        guard let data = try? JSONEncoder().encode(["agentId": agentId]),
              let json = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return json
    }
}
