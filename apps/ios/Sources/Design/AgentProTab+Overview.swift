import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    var agentFilterMenu: some View {
        Menu {
            Picker(selection: self.$agentRosterFilter) {
                ForEach(AgentRosterFilter.allCases) { filter in
                    Label(filter.title, systemImage: filter.systemImage)
                        .font(OpenClawType.subhead)
                        .tag(filter)
                }
            } label: {
                Text("Agent status")
                    .font(OpenClawType.subhead)
            }
            if self.agentFiltersActive {
                Divider()
                Button {
                    self.agentRosterFilter = .all
                    self.agentSearchText = ""
                } label: {
                    Label("Clear Filters", systemImage: "xmark.circle")
                        .font(OpenClawType.subhead)
                }
            }
        } label: {
            Label("Filter agents", systemImage: "line.3.horizontal.decrease")
                .font(OpenClawType.subheadSemiBold)
                .labelStyle(.iconOnly)
        }
        .accessibilityIdentifier("agent-status-filter-menu")
        .accessibilityValue(agentRosterFilter.title)
    }

    @ViewBuilder
    var gatewayToolbarButton: some View {
        if let openSettings {
            Button(action: openSettings) {
                Image(systemName: self.gatewayConnected ? "antenna.radiowaves.left.and.right" : "wifi.slash")
            }
            .tint(self.gatewayConnected ? OpenClawBrand.ok : .secondary)
            .accessibilityLabel(self.gatewayConnected
                ? String(localized: "Gateway online")
                : String(localized: "Gateway offline"))
            .accessibilityHint("Opens Settings / Gateway")
        }
    }

    var agentFiltersActive: Bool {
        agentRosterFilter != .all
            || !agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var emptyAgentsRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "person.2.slash", color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.emptyAgentsTitle)
                    .font(OpenClawType.subheadSemiBold)
                Text(self.emptyAgentsDetail)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    func agentRow(_ agent: AgentSummary) -> some View {
        let isActive = agent.id == self.activeAgentID
        let state = agentRosterState(for: agent)
        return Button {
            guard !isActive else { return }
            self.appModel.setSelectedAgentId(agent.id)
        } label: {
            HStack(alignment: .center, spacing: 12) {
                self.agentAvatar(agent, state: state)

                VStack(alignment: .leading, spacing: 3) {
                    Text(self.agentName(for: agent))
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(self.agentDetail(for: agent))
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .layoutPriority(1)

                Spacer(minLength: 8)

                if isActive {
                    Image(systemName: "checkmark")
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(OpenClawBrand.accent)
                        .frame(width: 24, height: 44)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(agentAccessibilityLabel(agent, isActive: isActive, state: state))
        .accessibilityHint(isActive
            ? String(localized: "Selected agent")
            : String(localized: "Selects this agent"))
    }

    func agentAvatar(_ agent: AgentSummary, state: AgentRosterState) -> some View {
        ZStack(alignment: .bottomTrailing) {
            Text(self.agentBadge(for: agent))
                .font(OpenClawType.avatar(size: self.agentBadge(for: agent).count > 2 ? 14 : 18))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.62)
                .lineLimit(1)
                .frame(width: 36, height: 36)
                .background(
                    Circle()
                        .fill(self.agentTint(for: agent, state: state).gradient))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 1))

            Circle()
                .fill(state.color)
                .frame(width: 8, height: 8)
                .overlay(Circle().strokeBorder(Color(uiColor: .systemBackground), lineWidth: 2))
        }
    }

    var sortedAgents: [AgentSummary] {
        appModel.gatewayAgents.filter(\.isSelectableAgent).sorted { lhs, rhs in
            if lhs.id == self.activeAgentID { return true }
            if rhs.id == self.activeAgentID { return false }
            return self.agentName(for: lhs)
                .localizedCaseInsensitiveCompare(self.agentName(for: rhs)) == .orderedAscending
        }
    }

    var filteredAgents: [AgentSummary] {
        let query = agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.sortedAgents.filter { agent in
            let matchesFilter: Bool = switch self.agentRosterFilter {
            case .all:
                true
            case .online:
                self.agentRosterState(for: agent) == .online
            case .ready:
                self.agentRosterState(for: agent) == .ready
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
        normalized(appModel.selectedAgentId)
            ?? normalized(appModel.gatewayDefaultAgentId)
            ?? "main"
    }

    var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: appModel) == .connected
    }

    var liveGatewayConnected: Bool {
        !appModel.isLocalGatewayFixtureEnabled &&
            self.gatewayConnected &&
            appModel.isOperatorGatewayConnected
    }

    var emptyAgentsTitle: String {
        if !self.gatewayConnected { return String(localized: "Agents unavailable") }
        if !agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "No matches")
        }
        switch agentRosterFilter {
        case .online:
            return String(localized: "No online agents")
        case .ready:
            return String(localized: "No ready agents")
        case .all:
            return String(localized: "No agents reported")
        }
    }

    var emptyAgentsDetail: String {
        if !self.gatewayConnected {
            return String(localized: "Connect a gateway to load the live agent roster.")
        }
        if !agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "Try another search or clear the agent filters.")
        }
        if agentRosterFilter != .all {
            return String(localized: "Clear the filter to view the full roster.")
        }
        return String(localized: "The connected gateway did not return an agent list.")
    }

    var overviewTaskID: String {
        [
            self.gatewayConnected ? "connected" : "offline",
            appModel.isOperatorGatewayConnected ? "operator" : "no-operator",
            appModel.connectedGatewayID ?? "no-gateway",
            self.activeAgentID,
            scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    var skillsValue: String {
        guard self.gatewayConnected else { return String(localized: "offline") }
        guard let skills = overview?.skills else {
            return overviewLoading ? "..." : String(localized: "live")
        }
        return "\(skills.enabledCount)/\(skills.totalCount)"
    }

    var skillsDetail: String {
        guard self.gatewayConnected else {
            return String(localized: "Connect a gateway to load skills.")
        }
        guard let skills = overview?.skills else {
            return overviewLoading
                ? String(localized: "Loading skill status.")
                : String(localized: "Skill status is available from the gateway.")
        }
        if skills.blockedCount > 0 {
            return String(
                format: String(localized: "%@ enabled, %@ blocked"),
                skills.enabledCount.formatted(),
                skills.blockedCount.formatted())
        }
        if skills.missingRequirementCount > 0 {
            return String(
                format: String(localized: "%@ enabled, %@ need setup"),
                skills.enabledCount.formatted(),
                skills.missingRequirementCount.formatted())
        }
        return String(
            format: String(localized: "%@ enabled, %@ installed"),
            skills.enabledCount.formatted(),
            skills.totalCount.formatted())
    }

    var instancesValue: String {
        guard self.gatewayConnected else { return String(localized: "offline") }
        guard let count = overview?.presence.count else {
            return overviewLoading ? "..." : String(localized: "live")
        }
        return "\(count)"
    }

    var instancesDetail: String {
        guard self.gatewayConnected else {
            return String(localized: "Connect a gateway to load instances.")
        }
        guard let presence = overview?.presence else {
            return overviewLoading
                ? String(localized: "Loading instance presence.")
                : String(localized: "Instance presence is available.")
        }
        let labels = presence.prefix(2).compactMap(presenceLabel)
        if labels.isEmpty {
            return String(localized: "No live instances reported.")
        }
        return labels.joined(separator: ", ")
    }

    var instancesColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return (overview?.presence.isEmpty == false) ? OpenClawBrand.accent : .secondary
    }

    var cronValue: String {
        guard self.gatewayConnected else { return String(localized: "offline") }
        guard let cronStatus = overview?.cronStatus else {
            return overviewLoading ? "..." : String(localized: "live")
        }
        return cronStatus.enabled ? cronStatus.jobs.formatted() : String(localized: "off")
    }

    var cronDetail: String {
        guard self.gatewayConnected else {
            return String(localized: "Connect a gateway to load cron.")
        }
        guard let cronStatus = overview?.cronStatus else {
            return overviewLoading
                ? String(localized: "Loading cron status.")
                : String(localized: "Cron status is available.")
        }
        if let nextWakeAtMs = cronStatus.nextwakeatms {
            return String(
                format: String(localized: "Next wake %@"),
                Self.relativeTime(fromMilliseconds: nextWakeAtMs))
        }
        return cronStatus.enabled
            ? String(localized: "Scheduler enabled")
            : String(localized: "Scheduler disabled")
    }

    var cronColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return overview?.cronStatus?.enabled == true ? OpenClawBrand.accent : .secondary
    }

    var usageValue: String {
        guard self.gatewayConnected else { return String(localized: "offline") }
        guard let usage = overview?.usage else {
            return overviewLoading ? "..." : "7d"
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
        guard self.gatewayConnected else {
            return String(localized: "Connect a gateway to load usage.")
        }
        guard let usage = overview?.usage else {
            return overviewLoading
                ? String(localized: "Loading recent usage.")
                : String(localized: "Recent usage is available.")
        }
        if let tokens = usage.totalTokens, tokens > 0 {
            return String(
                format: String(localized: "%@ tokens in %@d"),
                Self.compactNumber(tokens),
                (usage.days ?? 7).formatted())
        }
        return String(
            format: String(localized: "No token usage reported for %@d."),
            (usage.days ?? 7).formatted())
    }

    var dreamingValue: String {
        guard self.gatewayConnected else { return String(localized: "offline") }
        guard let dreaming = overview?.dreaming else {
            return overviewLoading ? "..." : String(localized: "live")
        }
        return dreaming.enabled ? String(localized: "on") : String(localized: "off")
    }

    var dreamingDetail: String {
        guard self.gatewayConnected else {
            return String(localized: "Connect a gateway to load dreaming.")
        }
        guard let dreaming = overview?.dreaming else {
            return overviewLoading
                ? String(localized: "Loading dreaming status.")
                : String(localized: "Background memory status is available.")
        }
        if let nextRunAtMs = dreaming.nextRunAtMs {
            return String(
                format: String(localized: "Next cycle %@"),
                Self.relativeTime(fromMilliseconds: nextRunAtMs))
        }
        return String(
            format: String(localized: "%@ signals, %@ promoted today"),
            (dreaming.totalSignalCount ?? 0).formatted(),
            (dreaming.promotedToday ?? 0).formatted())
    }

    var dreamingColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return overview?.dreaming?.enabled == true ? OpenClawBrand.accent : .secondary
    }
}
