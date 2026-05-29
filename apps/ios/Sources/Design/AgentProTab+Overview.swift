import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    var rosterHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Agents")
                        .font(.system(size: 28, weight: .bold))
                    Text("\(self.sortedAgents.count) total")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                HStack(spacing: 10) {
                    self.headerIconButton(
                        systemName: "magnifyingglass",
                        label: "Search agents",
                        action: {
                            withAnimation(.snappy(duration: 0.18)) {
                                self.agentSearchPresented.toggle()
                            }
                        })
                    self.headerIconButton(
                        systemName: "arrow.clockwise",
                        label: self.overviewLoading ? "Refreshing agents" : "Refresh agents",
                        action: {
                            self.overviewRefreshNonce += 1
                        })
                }
                .padding(.top, 2)
            }

            if self.agentSearchPresented {
                TextField("Search agents", text: self.$agentSearchText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.subheadline)
                    .padding(.horizontal, 12)
                    .frame(height: 38)
                    .background {
                        Capsule()
                            .fill(self.searchFieldFill)
                            .overlay {
                                Capsule().strokeBorder(self.searchFieldStroke, lineWidth: 1)
                            }
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
        .padding(.top, 6)
    }

    var agentFilters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AgentRosterFilter.allCases) { filter in
                    Button {
                        withAnimation(.snappy(duration: 0.18)) {
                            self.agentRosterFilter = filter
                        }
                    } label: {
                        Text(filter.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(self.agentRosterFilter == filter ? .primary : .secondary)
                            .padding(.horizontal, 15)
                            .frame(height: AgentLayout.filterHeight)
                            .background {
                                Capsule()
                                    .fill(self.agentRosterFilter == filter
                                        ? Color.primary.opacity(0.13)
                                        : Color.primary.opacity(0.055))
                            }
                            .overlay {
                                Capsule()
                                    .strokeBorder(Color.primary.opacity(self.agentRosterFilter == filter ? 0.22 : 0.06))
                            }
                    }
                    .buttonStyle(.plain)
                }

                if self.agentFiltersActive {
                    self.headerIconButton(
                        systemName: "xmark",
                        label: "Clear filters",
                        action: {
                            self.agentRosterFilter = .all
                            self.agentSearchText = ""
                        })
                        .frame(width: AgentLayout.filterHeight, height: AgentLayout.filterHeight)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    var agentFiltersActive: Bool {
        self.agentRosterFilter != .all
            || !self.agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var agentsSection: some View {
        ProCard(padding: 0, radius: AgentLayout.cardRadius) {
            if self.filteredAgents.isEmpty {
                self.emptyAgentsRow
                    .padding(14)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(self.filteredAgents.enumerated()), id: \.element.id) { index, agent in
                        self.agentRow(agent)
                        if index < self.filteredAgents.count - 1 {
                            Divider().padding(.leading, 76)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var operationsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Live Operations")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                self.metricTile(
                    icon: "sparkles",
                    title: "Skills",
                    value: self.skillsValue,
                    detail: self.skillsDetail,
                    color: self.gatewayConnected ? OpenClawBrand.accent : .secondary,
                    route: .skills)
                self.metricTile(
                    icon: "externaldrive.connected.to.line.below",
                    title: "Instances",
                    value: self.instancesValue,
                    detail: self.instancesDetail,
                    color: self.instancesColor,
                    route: .nodes)
                self.metricTile(
                    icon: "clock.arrow.circlepath",
                    title: "Cron",
                    value: self.cronValue,
                    detail: self.cronDetail,
                    color: self.cronColor,
                    route: .cron)
                self.metricTile(
                    icon: "chart.line.uptrend.xyaxis",
                    title: "Usage",
                    value: self.usageValue,
                    detail: self.usageDetail,
                    color: self.gatewayConnected ? OpenClawBrand.accent : .secondary,
                    route: .usage)
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)

            if let overviewErrorText {
                Text(overviewErrorText)
                    .font(.caption)
                    .foregroundStyle(OpenClawBrand.warn)
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
            }
        }
    }

    var dreamingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Dreaming")
            ProCard(radius: AgentLayout.cardRadius) {
                NavigationLink(value: AgentRoute.dreaming) {
                    self.agentMenuRow(
                        icon: "moon",
                        title: "Dreaming",
                        detail: self.dreamingDetail,
                        value: self.dreamingValue,
                        color: self.dreamingColor,
                        showsChevron: true)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    var cronSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Scheduled Work")
            ProCard(padding: 0, radius: AgentLayout.cardRadius) {
                let jobs = self.recentCronJobs
                if jobs.isEmpty {
                    NavigationLink(value: AgentRoute.cron) {
                        self.emptyCronRow
                            .padding(14)
                    }
                    .buttonStyle(.plain)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(jobs.enumerated()), id: \.element.id) { index, job in
                            NavigationLink(value: AgentRoute.cron) {
                                self.cronJobRow(job)
                            }
                            .buttonStyle(.plain)
                            if index < jobs.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    var emptyAgentsRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "person.2.slash", color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.emptyAgentsTitle)
                    .font(.subheadline.weight(.semibold))
                Text(self.emptyAgentsDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    func agentRow(_ agent: AgentSummary) -> some View {
        let isActive = agent.id == self.activeAgentID
        let state = self.agentRosterState(for: agent)
        return HStack(alignment: .top, spacing: 12) {
            self.agentAvatar(agent, state: state)

            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(self.agentName(for: agent))
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)

                        HStack(spacing: 4) {
                            Circle()
                                .fill(state.color)
                                .frame(width: 6, height: 6)
                            Text(state.title)
                                .font(.caption2.weight(.semibold))
                        }
                        .foregroundStyle(state.color)
                        .lineLimit(1)
                    }

                    Text(self.agentDetail(for: agent))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                HStack(spacing: 0) {
                    self.agentMetric(label: "Sessions", value: self.agentSessionSummary(agent))
                    Divider()
                        .frame(height: 24)
                        .padding(.horizontal, 12)
                    self.agentMetric(label: "Runtime", value: self.agentRuntimeSummary(agent))
                }
            }
            .layoutPriority(1)

            Button {
                self.appModel.setSelectedAgentId(agent.id)
            } label: {
                Image(systemName: isActive ? "checkmark" : "arrow.right")
                    .font(.caption.weight(.bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(isActive ? OpenClawBrand.accent : .primary)
            .frame(width: AgentLayout.actionButtonSize, height: AgentLayout.actionButtonSize)
            .background {
                Circle()
                    .fill(self.iconButtonFill)
                    .overlay {
                        Circle().strokeBorder(self.iconButtonStroke, lineWidth: 1)
                    }
            }
            .accessibilityLabel(isActive ? "Active agent" : "Make active agent")
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 13)
        .frame(minHeight: AgentLayout.rowMinHeight, alignment: .center)
        .contentShape(Rectangle())
        .onTapGesture {
            self.appModel.setSelectedAgentId(agent.id)
        }
    }

    func headerIconButton(
        systemName: String,
        label: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.subheadline.weight(.semibold))
                .frame(width: AgentLayout.filterHeight, height: AgentLayout.filterHeight)
                .background {
                    Circle()
                        .fill(self.iconButtonFill)
                        .overlay {
                            Circle().strokeBorder(self.iconButtonStroke, lineWidth: 1)
                        }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    func agentAvatar(_ agent: AgentSummary, state: AgentRosterState) -> some View {
        ZStack(alignment: .bottomTrailing) {
            Text(self.agentBadge(for: agent))
                .font(.system(size: self.agentBadge(for: agent).count > 2 ? 14 : 18, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.62)
                .lineLimit(1)
                .frame(width: 48, height: 48)
                .background(
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [
                                    self.agentTint(for: agent, state: state),
                                    Color.primary.opacity(0.38),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing)))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 1))

            Circle()
                .fill(state.color)
                .frame(width: 10, height: 10)
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.15), lineWidth: 1))
        }
    }

    func agentMetric(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.74)
        }
        .frame(minWidth: 60, alignment: .leading)
    }

    func agentMenuRow(
        icon: String,
        title: String,
        detail: String,
        value: String,
        color: Color,
        showsChevron: Bool = false) -> some View
    {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: color)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(value)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(color)
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 10)
    }

    func metricTile(
        icon: String,
        title: String,
        value: String,
        detail: String,
        color: Color,
        route: AgentRoute? = nil) -> some View
    {
        Group {
            if let route {
                NavigationLink(value: route) {
                    self.metricTileContent(
                        icon: icon,
                        title: title,
                        value: value,
                        detail: detail,
                        color: color,
                        showsChevron: true)
                }
                .buttonStyle(.plain)
            } else {
                self.metricTileContent(
                    icon: icon,
                    title: title,
                    value: value,
                    detail: detail,
                    color: color,
                    showsChevron: false)
            }
        }
    }

    func metricTileContent(
        icon: String,
        title: String,
        value: String,
        detail: String,
        color: Color,
        showsChevron: Bool) -> some View
    {
        ProCard(padding: 12, radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    ProIconBadge(systemName: icon, color: color)
                    Spacer()
                    ProValuePill(value: value, color: color)
                    if showsChevron {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.caption.weight(.semibold))
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: AgentLayout.metricTileHeight, alignment: .topLeading)
        }
    }

    var emptyCronRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "clock.badge.questionmark", color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.gatewayConnected ? "No scheduled jobs" : "Cron unavailable")
                    .font(.subheadline.weight(.semibold))
                Text(self.gatewayConnected
                    ? "The gateway has no visible cron jobs."
                    : "Connect a gateway to load scheduled work.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    func cronJobRow(_ job: CronJob) -> some View {
        HStack(spacing: 12) {
            ProIconBadge(
                systemName: job.enabled ? "clock.arrow.circlepath" : "pause.circle",
                color: job.enabled ? OpenClawBrand.accent : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(job.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.cronJobDetail(job))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(self.cronJobState(job))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(job.enabled ? OpenClawBrand.accent : .secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    var sortedAgents: [AgentSummary] {
        self.appModel.gatewayAgents.sorted { lhs, rhs in
            if lhs.id == self.activeAgentID { return true }
            if rhs.id == self.activeAgentID { return false }
            return self.agentName(for: lhs)
                .localizedCaseInsensitiveCompare(self.agentName(for: rhs)) == .orderedAscending
        }
    }

    var filteredAgents: [AgentSummary] {
        let query = self.agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.sortedAgents.filter { agent in
            let matchesFilter: Bool = switch self.agentRosterFilter {
            case .all:
                true
            case .online:
                self.agentRosterState(for: agent) == .online
            case .busy:
                self.agentRosterState(for: agent) == .busy
            case .idle:
                self.agentRosterState(for: agent) == .idle
            }

            guard matchesFilter else { return false }
            guard !query.isEmpty else { return true }
            let haystack = [
                self.agentName(for: agent),
                agent.id,
                self.normalized(agent.workspace),
                self.modelLabel(for: agent),
            ]
                .compactMap(\.self)
                .joined(separator: " ")
            return haystack.localizedCaseInsensitiveContains(query)
        }
    }

    var activeAgentID: String {
        self.normalized(self.appModel.selectedAgentId)
            ?? self.normalized(self.appModel.gatewayDefaultAgentId)
            ?? "main"
    }

    var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var searchFieldFill: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.045) : Color.white.opacity(0.78)
    }

    private var searchFieldStroke: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.11) : Color.black.opacity(0.07)
    }

    private var iconButtonFill: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.065) : Color.white.opacity(0.78)
    }

    private var iconButtonStroke: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.14) : Color.black.opacity(0.07)
    }

    var emptyAgentsTitle: String {
        if !self.gatewayConnected { return "Agents unavailable" }
        if !self.agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "No matches" }
        if self.agentRosterFilter != .all { return "No \(self.agentRosterFilter.title.lowercased()) agents" }
        return "No agents reported"
    }

    var emptyAgentsDetail: String {
        if !self.gatewayConnected { return "Connect a gateway to load the live agent roster." }
        if !self.agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Try another search or clear the agent filters."
        }
        if self.agentRosterFilter != .all { return "Clear the filter to view the full roster." }
        return "The connected gateway did not return an agent list."
    }

    var overviewTaskID: String {
        [
            self.gatewayConnected ? "connected" : "offline",
            self.appModel.isOperatorGatewayConnected ? "operator" : "no-operator",
            self.activeAgentID,
            self.scenePhase == .active ? "active" : "inactive",
            "\(self.overviewRefreshNonce)",
        ].joined(separator: ":")
    }

    var skillsValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let skills = self.overview?.skills else {
            return self.overviewLoading ? "..." : "live"
        }
        return "\(skills.enabledCount)/\(skills.totalCount)"
    }

    var skillsDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load skills." }
        guard let skills = self.overview?.skills else {
            return self.overviewLoading ? "Loading skill status." : "Skill status is available from the gateway."
        }
        if skills.blockedCount > 0 {
            return "\(skills.enabledCount) enabled, \(skills.blockedCount) blocked"
        }
        if skills.missingRequirementCount > 0 {
            return "\(skills.enabledCount) enabled, \(skills.missingRequirementCount) need setup"
        }
        return "\(skills.enabledCount) enabled, \(skills.totalCount) installed"
    }

    var instancesValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let count = self.overview?.presence.count else {
            return self.overviewLoading ? "..." : "live"
        }
        return "\(count)"
    }

    var instancesDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load instances." }
        guard let presence = self.overview?.presence else {
            return self.overviewLoading ? "Loading instance presence." : "Instance presence is available."
        }
        let labels = presence.prefix(2).compactMap(self.presenceLabel)
        if labels.isEmpty {
            return "No live instances reported."
        }
        return labels.joined(separator: ", ")
    }

    var instancesColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return (self.overview?.presence.isEmpty == false) ? OpenClawBrand.accent : .secondary
    }

    var cronValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let cronStatus = self.overview?.cronStatus else {
            return self.overviewLoading ? "..." : "live"
        }
        return cronStatus.enabled ? "\(cronStatus.jobs)" : "off"
    }

    var cronDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load cron." }
        guard let cronStatus = self.overview?.cronStatus else {
            return self.overviewLoading ? "Loading cron status." : "Cron status is available."
        }
        if let nextWakeAtMs = cronStatus.nextwakeatms {
            return "Next wake \(Self.relativeTime(fromMilliseconds: nextWakeAtMs))"
        }
        return cronStatus.enabled ? "Scheduler enabled" : "Scheduler disabled"
    }

    var cronColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return self.overview?.cronStatus?.enabled == true ? OpenClawBrand.accent : .secondary
    }

    var usageValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let usage = self.overview?.usage else {
            return self.overviewLoading ? "..." : "7d"
        }
        if let cost = usage.totalCost {
            return Self.currency(cost)
        }
        if let tokens = usage.totalTokens, tokens > 0 {
            return Self.compactNumber(tokens)
        }
        return "7d"
    }

    var usageDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load usage." }
        guard let usage = self.overview?.usage else {
            return self.overviewLoading ? "Loading recent usage." : "Recent usage is available."
        }
        if let tokens = usage.totalTokens, tokens > 0 {
            return "\(Self.compactNumber(tokens)) tokens in \(usage.days ?? 7)d"
        }
        return "No token usage reported for \(usage.days ?? 7)d."
    }

    var dreamingValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let dreaming = self.overview?.dreaming else {
            return self.overviewLoading ? "..." : "live"
        }
        return dreaming.enabled ? "on" : "off"
    }

    var dreamingDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load dreaming." }
        guard let dreaming = self.overview?.dreaming else {
            return self.overviewLoading ? "Loading dreaming status." : "Background memory status is available."
        }
        if let nextRunAtMs = dreaming.nextRunAtMs {
            return "Next cycle \(Self.relativeTime(fromMilliseconds: nextRunAtMs))"
        }
        return "\(dreaming.totalSignalCount ?? 0) signals, \(dreaming.promotedToday ?? 0) promoted today"
    }

    var dreamingColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return self.overview?.dreaming?.enabled == true ? OpenClawBrand.accent : .secondary
    }

    var recentCronJobs: [CronJob] {
        (self.overview?.cronJobs ?? [])
            .sorted { lhs, rhs in
                let lhsNext = AgentProValueReader.intValue(lhs.state["nextRunAtMs"])
                let rhsNext = AgentProValueReader.intValue(rhs.state["nextRunAtMs"])
                switch (lhsNext, rhsNext) {
                case let (lhsNext?, rhsNext?): return lhsNext < rhsNext
                case (_?, nil): return true
                case (nil, _?): return false
                case (nil, nil): return lhs.updatedatms > rhs.updatedatms
                }
            }
            .prefix(4)
            .map(\.self)
    }
}
