import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    @ViewBuilder
    func destination(for route: AgentRoute) -> some View {
        switch route {
        case .agents:
            self.agentsDestination
        case .skills:
            self.skillsDestination
        case .instances:
            self.instancesDestination
        case .cron:
            self.cronDestination
        case .usage:
            self.usageDestination
        case .dreaming:
            self.dreamingDestination
        case .files:
            self.filesDestination
        }
    }

    var filesDestination: some View {
        AgentWorkspaceFilesScreen(
            agentId: self.activeAgentID,
            headerSidebarAction: self.directHeaderSidebarAction(for: .files))
    }

    var agentsDestination: some View {
        List {
            Section {
                if self.filteredAgents.isEmpty {
                    self.emptyAgentsRow
                } else {
                    ForEach(self.filteredAgents, id: \.id) { agent in
                        self.agentRow(agent)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(self.headerTitle)
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: self.$agentSearchText, prompt: "Search agents")
        .refreshable {
            await self.refreshOverview(force: true)
        }
        .font(OpenClawType.body)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                self.agentFilterMenu
                self.gatewayToolbarButton
            }
            if let headerSidebarAction {
                OpenClawSidebarToolbarItem(
                    action: headerSidebarAction,
                    placement: .topBarLeading)
            }
        }
    }

    var skillsDestination: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.detailSummaryCard(
                        icon: "sparkles",
                        title: "Skills",
                        value: self.skillsValue,
                        detail: self.skillsDetail,
                        color: self.gatewayConnected ? OpenClawBrand.accent : .secondary)
                    self.skillsPolicyControls
                    self.skillsFilterField
                    self.clawHubSearchCard
                    self.skillsList
                }
                .padding(.vertical, 18)
                .font(OpenClawType.body)
            }
            .refreshable {
                await self.refreshOverview(force: true)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Skills")
        .navigationBarTitleDisplayMode(.inline)
    }

    var instancesDestination: some View {
        AgentProNodesDestination(
            headerSidebarAction: self.directHeaderSidebarAction(for: .instances),
            overview: self.overview,
            gatewayConnected: self.gatewayConnected,
            agentCount: self.appModel.gatewayAgents.count,
            instancesValue: self.instancesValue,
            instancesDetail: self.instancesDetail,
            instancesColor: self.instancesColor,
            refresh: {
                await self.refreshOverview(force: true)
            })
    }

    var cronDestination: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.directHeader(
                        for: .cron,
                        title: "Automations",
                        subtitle: self.cronDetail)
                    self.detailSummaryCard(
                        icon: "clock.arrow.circlepath",
                        title: "Automations",
                        value: self.cronValue,
                        detail: self.cronDetail,
                        color: self.cronColor)
                    self.cronStatusCard
                    self.cronJobsList(limit: nil)
                }
                .padding(.vertical, 18)
                .font(OpenClawType.body)
            }
            .refreshable {
                await self.refreshOverview(force: true)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Automations")
        .navigationBarTitleDisplayMode(.inline)
    }

    var usageDestination: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.directHeader(
                        for: .usage,
                        title: "Usage",
                        subtitle: self.usageDetail)
                    self.detailSummaryCard(
                        icon: "chart.line.uptrend.xyaxis",
                        title: "Usage",
                        value: self.usageValue,
                        detail: self.usageDetail,
                        color: self.gatewayConnected ? OpenClawBrand.accent : .secondary)
                    self.usageTotalsCard
                    self.usageDailyList
                }
                .padding(.vertical, 18)
                .font(OpenClawType.body)
            }
            .refreshable {
                await self.refreshOverview(force: true)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
    }

    var dreamingDestination: some View {
        AgentProDreamingDestination(
            headerSidebarAction: self.directHeaderSidebarAction(for: .dreaming),
            overview: self.overview,
            gatewayConnected: self.gatewayConnected,
            overviewLoading: self.overviewLoading,
            dreamingValue: self.dreamingValue,
            dreamingDetail: self.dreamingDetail,
            dreamingColor: self.dreamingColor,
            refresh: {
                await self.refreshOverview(force: true)
            })
    }

    @ViewBuilder
    func directHeader(for route: AgentRoute, title: String, subtitle: String) -> some View {
        if let headerSidebarAction = self.directHeaderSidebarAction(for: route) {
            OpenClawAdaptiveHeaderRow(
                title: .localized(title),
                subtitle: .localized(subtitle),
                titleFont: OpenClawType.title3SemiBold,
                subtitleFont: OpenClawType.subheadMedium)
            {
                OpenClawSidebarHeaderLeadingSlot(action: headerSidebarAction)
            } accessory: {
                EmptyView()
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    func directHeaderSidebarAction(for route: AgentRoute) -> OpenClawSidebarHeaderAction? {
        self.directRoute == route ? self.headerSidebarAction : nil
    }

    func detailSummaryCard(
        icon: String,
        title: String,
        value: String,
        detail: String,
        color: Color) -> some View
    {
        ProCard(radius: AgentLayout.cardRadius) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(OpenClawType.headline)
                    Text(detail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                ProValuePill(value: value, color: color)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }
}
