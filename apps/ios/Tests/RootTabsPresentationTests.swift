import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct RootTabsPresentationTests {
    @Test func `configured gateway bypasses launch request and stale onboarding markers`() {
        let route = RootTabs.startupPresentationRoute(
            gatewayConnected: false,
            hasConnectedOnce: false,
            onboardingComplete: false,
            hasExistingGatewayConfig: true,
            shouldPresentOnLaunch: true)

        #expect(route == .none)
    }

    @Test func `fresh install presents onboarding`() {
        let route = RootTabs.startupPresentationRoute(
            gatewayConnected: false,
            hasConnectedOnce: false,
            onboardingComplete: false,
            hasExistingGatewayConfig: false,
            shouldPresentOnLaunch: false)

        #expect(route == .onboarding)
    }

    @Test func `completed setup without gateway opens settings`() {
        let route = RootTabs.startupPresentationRoute(
            gatewayConnected: false,
            hasConnectedOnce: true,
            onboardingComplete: true,
            hasExistingGatewayConfig: false,
            shouldPresentOnLaunch: false)

        #expect(route == .settings)
    }

    @Test func `quick setup does not present when gateway already configured`() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: true,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }

    @Test func `quick setup presents for fresh install with discovered gateway`() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(shouldPresent)
    }

    @Test func `quick setup does not present when already connected`() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: true,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }

    @Test func `sidebar tabs enabled for I pad regular width`() {
        #expect(
            RootTabs.shouldUseSidebarTabs(
                idiom: .pad,
                horizontalSizeClass: .regular))
    }

    @Test func `sidebar tabs enabled for I pad compact width`() {
        #expect(
            RootTabs.shouldUseSidebarTabs(
                idiom: .pad,
                horizontalSizeClass: .compact))
    }

    @Test func `sidebar tabs disabled for I phone`() {
        #expect(
            !RootTabs.shouldUseSidebarTabs(
                idiom: .phone,
                horizontalSizeClass: .regular))
    }

    @Test func `sidebar groups match adaptive navigation model`() {
        let groups = RootTabs.sidebarGroups
        let destinationIDs = RootTabs.SidebarDestination.allCases.map(\.rawValue)

        #expect(groups.map(\.title) == ["CHAT", "CONTROL", "SETTINGS", "REFERENCE"])
        #expect(groups[0].destinations.map(\.rawValue) == ["chat", "talk"])
        #expect(groups[1].destinations == [
            .overview,
            .activity,
            .agents,
            .workboard,
            .skillWorkshop,
            .instances,
            .sessions,
            .files,
            .dreaming,
            .usage,
            .cron,
            .terminal,
        ])
        #expect(groups[2].destinations == [.settings])
        #expect(groups[3].destinations == [.docs])
        #expect(destinationIDs == [
            "chat",
            "talk",
            "overview",
            "activity",
            "agents",
            "workboard",
            "skillWorkshop",
            "instances",
            "sessions",
            "files",
            "dreaming",
            "usage",
            "cron",
            "terminal",
            "docs",
            "settings",
            "gateway",
        ])
        #expect(!destinationIDs.contains("agent"))
        #expect(!RootTabs.sidebarGroups.flatMap(\.destinations).contains(.gateway))
    }

    @Test func `phone control groups avoid duplicating the agent tab`() {
        let groups = RootTabs.phoneControlGroups
        let destinations = groups.flatMap(\.destinations)

        #expect(groups.map(\.title) == ["CHAT", "CONTROL", "SETTINGS", "REFERENCE"])
        #expect(!destinations.contains(.agents))
        #expect(RootTabs.sidebarGroups.flatMap(\.destinations).contains(.agents))
        #expect(destinations.contains(.dreaming))
        #expect(destinations.contains(.instances))
    }

    @Test func `sidebar uses compact labels for long routes`() {
        #expect(RootTabs.SidebarDestination.settings.title == "Settings")
        #expect(RootTabs.SidebarDestination.gateway.title == "Settings / Gateway")
        #expect(RootTabs.SidebarDestination.gateway.sidebarTitle == "Connection")
    }

    @Test func `phone hub uses root tabs only for native chat agent and gateway`() {
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.chat))
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.talk))
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.agents))
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.gateway))
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.settings))

        for destination in RootTabs.SidebarDestination.allCases
            where destination != .chat && destination != .talk && destination != .agents && destination != .gateway &&
            destination != .settings
        {
            #expect(!RootTabs.shouldOpenRootTabFromPhoneHub(destination))
        }
    }

    @Test func `app launch defaults to chat tab`() {
        #expect(RootTabs.initialTab(arguments: ["OpenClaw"]) == .chat)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-tab"]) == .chat)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-tab", "unknown"]) == .chat)
    }

    @Test func `app launch uses requested destination before chat fallback`() {
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-destination", "overview"]) == .control)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-destination", "chat"]) == .chat)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-destination", "agents"]) == .agent)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-destination", "gateway"]) == .settings)
        #expect(
            RootTabs.initialTab(arguments: [
                "OpenClaw",
                "--openclaw-initial-tab",
                "unknown",
                "--openclaw-initial-destination",
                "activity",
            ]) == .control)
    }

    @Test func `app launch respects explicit initial tab override`() {
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-tab", "control"]) == .control)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-tab", "overview"]) == .control)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-tab", "chat"]) == .chat)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-tab", "voice"]) == .talk)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-tab", "agents"]) == .agent)
        #expect(RootTabs.initialTab(arguments: ["OpenClaw", "--openclaw-initial-tab", "settings"]) == .settings)
    }

    @Test func `legacy initial tabs map to matching sidebar destinations`() {
        #expect(RootTabs.defaultSidebarDestination(for: .control) == .overview)
        #expect(RootTabs.defaultSidebarDestination(for: .chat) == .chat)
        #expect(RootTabs.defaultSidebarDestination(for: .talk) == .talk)
        #expect(RootTabs.defaultSidebarDestination(for: .agent) == .agents)
        #expect(RootTabs.defaultSidebarDestination(for: .settings) == .settings)
    }

    @Test func `skill workshop mutations require admin scope`() {
        #expect(IPadSkillWorkshopScreen.shouldEnableProposalMutation(canWrite: true, hasOperatorAdminScope: true))
        #expect(!IPadSkillWorkshopScreen.shouldEnableProposalMutation(canWrite: true, hasOperatorAdminScope: false))
        #expect(!IPadSkillWorkshopScreen.shouldEnableProposalMutation(canWrite: false, hasOperatorAdminScope: true))
    }

    @Test func `skill workshop held filter includes quarantined and stale`() {
        #expect(IPadSkillWorkshopScreen.proposalStatusFilters.contains("held"))
        #expect(IPadSkillWorkshopScreen.proposalStatusMatchesFilter(status: "quarantined", filter: "held"))
        #expect(IPadSkillWorkshopScreen.proposalStatusMatchesFilter(status: "stale", filter: "held"))
        #expect(!IPadSkillWorkshopScreen.proposalStatusMatchesFilter(status: "pending", filter: "held"))
    }

    @Test func `skill workshop board lanes match status filter`() {
        #expect(
            IPadSkillWorkshopScreen.proposalStatusBoardLanes(
                filter: "pending",
                proposalStatuses: ["pending", "applied"]) == ["pending"])
        #expect(
            IPadSkillWorkshopScreen.proposalStatusBoardLanes(
                filter: "held",
                proposalStatuses: ["quarantined", "stale"]) == ["quarantined", "stale"])
        #expect(
            IPadSkillWorkshopScreen.proposalStatusBoardLanes(
                filter: "all",
                proposalStatuses: ["pending", "needs-review"]) == [
                "pending",
                "quarantined",
                "stale",
                "applied",
                "rejected",
                "needs-review",
            ])
        #expect(IPadSkillWorkshopScreen.proposalLaneLabel("quarantined") == "Quarantined")
        #expect(IPadSkillWorkshopScreen.proposalLaneLabel("pending") == "Pending")
        #expect(IPadSkillWorkshopScreen.proposalLaneLabel("needs-review") == "Needs Review")
        #expect(IPadSkillWorkshopScreen.proposalLaneLabel("manual_QA") == "Manual QA")
    }

    @Test func `skill workshop selection stays inside active filter`() {
        let proposals = [
            (id: "applied-1", status: "applied"),
            (id: "pending-1", status: "pending"),
            (id: "held-1", status: "quarantined"),
        ]

        #expect(
            IPadSkillWorkshopScreen.nextSelectedProposalID(
                current: "applied-1",
                proposals: proposals,
                filter: "pending") == "pending-1")
        #expect(
            IPadSkillWorkshopScreen.nextSelectedProposalID(
                current: "held-1",
                proposals: proposals,
                filter: "held") == "held-1")
        #expect(
            IPadSkillWorkshopScreen.nextSelectedProposalID(
                current: "pending-1",
                visibleProposalIDs: ["held-1"]) == "held-1")
        #expect(
            IPadSkillWorkshopScreen.nextSelectedProposalID(
                current: "pending-1",
                visibleProposalIDs: []) == nil)
    }

    @Test func `workboard board scope labels stay compact`() {
        #expect(IPadWorkboardScreen.normalizedScopeID("  planning ") == "planning")
        #expect(IPadWorkboardScreen.boardScopeLabel(for: "") == "All boards")
        #expect(IPadWorkboardScreen.boardScopeLabel(for: "planning") == "planning")
        #expect(IPadWorkboardScreen.boardScopeOptions(
            knownBoardIDs: ["default", " empty-board ", ""],
            cardBoardIDs: ["planning", "default"]) == ["default", "empty-board", "planning"])
        #expect(IPadWorkboardScreen
            .workboardSubtitle(boardScopeLabel: "All boards", selectedStatus: "active") == "All boards / Active")
        #expect(IPadWorkboardScreen
            .workboardSubtitle(boardScopeLabel: "planning", selectedStatus: "running") == "planning / Running")
    }

    @Test func `workboard compact unavailable copy explains real capability state`() {
        #expect(IPadWorkboardScreen
            .compactWriteUnavailableMessage(canRead: false) ==
            "Connect from Settings to create, move, and dispatch cards.")
        #expect(IPadWorkboardScreen.compactWriteUnavailableMessage(canRead: true) == "Read-only gateway.")
    }

    @Test func `skill workshop agent scope normalizes gateway ids`() {
        #expect(IPadSkillWorkshopScreen.normalizedScopeID("  aiden ") == "aiden")
        #expect(IPadSkillWorkshopScreen.normalizedScopeID(nil) == "")
    }

    @Test func `channel lifecycle controls require admin scope`() {
        #expect(SettingsChannelsDestination.shouldEnableChannelOperation(canRead: true, hasOperatorAdminScope: true))
        #expect(!SettingsChannelsDestination.shouldEnableChannelOperation(canRead: true, hasOperatorAdminScope: false))
        #expect(!SettingsChannelsDestination.shouldEnableChannelOperation(canRead: false, hasOperatorAdminScope: true))
    }

    @Test func `click clack stays in channels integration metadata`() {
        #expect(SettingsChannelsDestination.fallbackLabel("clickclack") == "ClickClack")
        #expect(SettingsChannelsDestination.fallbackDetail("clickclack") == "Self-hosted chat bot routing.")
        #expect(SettingsChannelsDestination.fallbackSystemImage("clickclack") == "bubble.left.and.bubble.right")
    }

    @Test func `i pad overview can suppress standalone header branding`() {
        #expect(CommandCenterTab.shouldShowHeaderMark(hasLeadingAction: false, showsHeaderMark: true))
        #expect(!CommandCenterTab.shouldShowHeaderMark(hasLeadingAction: true, showsHeaderMark: true))
        #expect(!CommandCenterTab.shouldShowHeaderMark(hasLeadingAction: false, showsHeaderMark: false))
    }

    @Test func `command center can use parent navigation stack for embedded routes`() {
        let standalone = CommandCenterTab(openChat: {}, openSettings: {})
        let embedded = CommandCenterTab(
            ownsNavigationStack: false,
            openChat: {},
            openSettings: {})
        let native = CommandCenterTab(
            ownsNavigationStack: false,
            usesNativeNavigationChrome: true,
            openChat: {},
            openSettings: {})
        let shellRouted = CommandCenterTab(
            ownsNavigationStack: false,
            openChat: {},
            openSettings: {},
            openSessions: {})

        #expect(standalone.ownsNavigationStack)
        #expect(standalone.openSessions == nil)
        #expect(!embedded.ownsNavigationStack)
        #expect(!embedded.usesNativeNavigationChrome)
        #expect(embedded.openSessions == nil)
        #expect(native.usesNativeNavigationChrome)
        #expect(shellRouted.openSessions != nil)
    }

    @Test func `chat sidebar destination can use native route title instead of agent branding`() {
        let standalone = ChatProTab()
        let routed = ChatProTab(
            headerTitle: "Chat",
            showsAgentBadge: false,
            ownsNavigationStack: false,
            openSettings: {})

        #expect(standalone.showsAgentBadge)
        #expect(standalone.ownsNavigationStack)
        #expect(standalone.headerTitle == nil)
        #expect(standalone.openSettings == nil)
        #expect(routed.headerTitle == "Chat")
        #expect(!routed.showsAgentBadge)
        #expect(!routed.ownsNavigationStack)
        #expect(routed.openSettings != nil)
        #expect(ChatProTab.defaultHeaderTitle(showsAgentBadge: true, agentDisplayName: "OpenClaw") == "OpenClaw")
        #expect(ChatProTab.defaultHeaderTitle(showsAgentBadge: false, agentDisplayName: "OpenClaw") == "Chat")
    }

    @Test func `chat transport identity distinguishes unresolved and resolved agents`() {
        #expect(ChatProTab.transportAgentID(nil).isEmpty)
        #expect(ChatProTab.transportAgentID("   ").isEmpty)
        #expect(ChatProTab.transportAgentID(" Main ") == "main")
    }

    @Test func `chat view model rebuilds only when its transport owner changes`() {
        #expect(!ChatProTab.requiresViewModelRebuild(
            currentOwnerID: "gateway-a",
            nextOwnerID: "gateway-a",
            currentTransportAgentID: "main",
            nextTransportAgentID: "main"))
        #expect(ChatProTab.requiresViewModelRebuild(
            currentOwnerID: "gateway-a",
            nextOwnerID: "gateway-b",
            currentTransportAgentID: "main",
            nextTransportAgentID: "main"))
        #expect(ChatProTab.requiresViewModelRebuild(
            currentOwnerID: "gateway-a",
            nextOwnerID: "gateway-a",
            currentTransportAgentID: "main",
            nextTransportAgentID: "work"))
    }

    @Test func `agent routes can open gateway settings from header pill`() {
        let standalone = AgentProTab()
        let routed = AgentProTab(
            directRoute: .instances,
            headerTitle: "Instances",
            openSettings: {})

        #expect(standalone.headerTitle == "Agents")
        #expect(standalone.directRoute == nil)
        #expect(standalone.openSettings == nil)
        #expect(AgentProTab(directRoute: .agents).directRoute == .agents)
        #expect(routed.directRoute == .instances)
        #expect(routed.headerTitle == "Instances")
        #expect(routed.openSettings != nil)
    }

    @Test func `workboard dispatch summary reports started and failures`() throws {
        let payload = Data(
            """
            {
              "count": 2,
              "started": [{}],
              "startFailures": [{}],
              "promoted": [],
              "reclaimed": [],
              "blocked": [],
              "orchestrated": []
            }
            """.utf8)
        let summary = try JSONDecoder().decode(IPadWorkboardDispatchSummary.self, from: payload)

        #expect(summary.summaryText == "2 dispatched: 1 started, 1 failed.")
    }

    @Test func `talk sidebar destination can receive reveal action`() {
        let action = OpenClawSidebarHeaderAction(
            systemName: "sidebar.left",
            accessibilityLabel: "Show Sidebar",
            action: {})
        let routed = TalkProTab(headerLeadingAction: action, openSettings: {})
        let embedded = TalkProTab(
            headerLeadingAction: action,
            ownsNavigationStack: false,
            openSettings: {})

        #expect(routed.headerLeadingAction?.systemName == "sidebar.left")
        #expect(routed.headerLeadingAction?.accessibilityLabel == "Show Sidebar")
        #expect(routed.ownsNavigationStack)
        #expect(!embedded.ownsNavigationStack)
    }

    @Test func `settings can use parent navigation stack for sidebar routes`() {
        let standalone = SettingsProTab()
        let embedded = SettingsProTab(ownsNavigationStack: false)

        #expect(standalone.ownsNavigationStack)
        #expect(!embedded.ownsNavigationStack)
    }

    @Test func `settings sidebar route follows navigation top then direct base`() {
        #expect(RootTabs.visibleSettingsRoute(
            navigationPath: [.approvals],
            baseRoute: nil) == .approvals)
        #expect(RootTabs.visibleSettingsRoute(
            navigationPath: [.approvals, .notifications],
            baseRoute: .gateway) == .notifications)
        #expect(RootTabs.visibleSettingsRoute(
            navigationPath: [],
            baseRoute: .approvals) == .approvals)
        #expect(RootTabs.visibleSettingsRoute(
            navigationPath: [],
            baseRoute: nil) == nil)
    }

    @Test func `i pad portrait uses hidden drawer sidebar`() {
        let mode = RootTabs.sidebarLayoutMode(containerSize: CGSize(width: 1024, height: 1366))

        #expect(mode == .drawer)
        #expect(!RootTabs.preferredSidebarVisibility(layoutMode: mode))
    }

    @Test func `i pad wide landscape uses visible split sidebar`() {
        let mode = RootTabs.sidebarLayoutMode(containerSize: CGSize(width: 1366, height: 1024))

        #expect(mode == .split)
        #expect(RootTabs.preferredSidebarVisibility(layoutMode: mode))
    }

    @Test func `i pad split sidebar width stays usable`() {
        let width = RootTabs.sidebarWidth(containerWidth: 1366, isDrawerLayout: false)

        #expect(width >= RootTabs.sidebarSplitIdealWidth)
        #expect(width <= RootTabs.sidebarSplitMaximumWidth)
    }

    @Test func `i pad collapsed split sidebar uses header reveal without reserved rail`() {
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: false,
                layoutMode: .split))
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: true,
                layoutMode: .split))
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: false,
                layoutMode: .drawer))
        #expect(
            !RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: true,
                layoutMode: .drawer))
    }

    @Test func `initial sidebar visibility parses launch argument`() {
        #expect(
            RootTabs.requestedInitialSidebarVisibility(arguments: [
                "OpenClaw",
                "--openclaw-sidebar-visibility",
                "hidden",
            ]) == false)
        #expect(
            RootTabs.requestedInitialSidebarVisibility(arguments: [
                "OpenClaw",
                "--openclaw-sidebar-visibility",
                "visible",
            ]) == true)
        #expect(
            RootTabs.requestedInitialSidebarVisibility(arguments: [
                "OpenClaw",
                "--openclaw-sidebar-visibility",
                "unknown",
            ]) == nil)
    }

    @Test func `sidebar controls have stable accessibility identifiers`() {
        #expect(RootTabs.sidebarShowButtonAccessibilityIdentifier == "RootTabs.Sidebar.Show")
        #expect(RootTabs.sidebarHideButtonAccessibilityIdentifier == "RootTabs.Sidebar.Hide")
    }

    @Test func `i pad drawer sidebar width stays inside screen`() {
        let width = RootTabs.sidebarWidth(containerWidth: 744, isDrawerLayout: true)

        #expect(width >= 280)
        #expect(width <= RootTabs.sidebarDrawerMaximumWidth)
    }

    @Test func `narrow landscape keeps drawer sidebar`() {
        let mode = RootTabs.sidebarLayoutMode(containerSize: CGSize(width: 900, height: 600))

        #expect(mode == .drawer)
        #expect(!RootTabs.preferredSidebarVisibility(layoutMode: mode))
    }

    @Test func `drawer selection collapses sidebar but split selection does not`() {
        #expect(RootTabs.shouldCollapseSidebarAfterSelection(layoutMode: .drawer))
        #expect(!RootTabs.shouldCollapseSidebarAfterSelection(layoutMode: .split))
    }

    @Test func `hidden sidebar shows reveal control`() {
        #expect(RootTabs.shouldShowSidebarRevealControl(isSidebarVisible: false))
    }

    @Test func `sidebar reveal controls hide when sidebar is visible`() {
        #expect(!RootTabs.shouldShowSidebarRevealControl(isSidebarVisible: true))
    }

    @Test func `i pad split prefers integrated visible sidebar`() {
        #expect(RootTabs.preferredSidebarVisibility(layoutMode: .split))
        #expect(!RootTabs.shouldCollapseSidebarAfterSelection(layoutMode: .split))
        #expect(!RootTabs.preferredSidebarVisibility(layoutMode: .drawer))
        #expect(RootTabs.shouldCollapseSidebarAfterSelection(layoutMode: .drawer))
    }

    @Test func `destination headers own hidden sidebar reveal control`() {
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: false,
                layoutMode: .drawer))
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: false,
                layoutMode: .split))
        #expect(
            !RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: true,
                layoutMode: .drawer))
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: true,
                layoutMode: .split))
    }

    @Test func `workboard and skill workshop use compact task flow on phone sizes`() {
        #expect(
            IPadWorkboardScreen.usesCompactTaskFlow(
                horizontalSizeClass: .compact,
                verticalSizeClass: .regular))
        #expect(
            IPadSkillWorkshopScreen.usesCompactTaskFlow(
                horizontalSizeClass: .compact,
                verticalSizeClass: .regular))
        #expect(
            IPadWorkboardScreen.usesCompactTaskFlow(
                horizontalSizeClass: .regular,
                verticalSizeClass: .compact))
        #expect(
            IPadSkillWorkshopScreen.usesCompactTaskFlow(
                horizontalSizeClass: .regular,
                verticalSizeClass: .compact))
    }

    @Test func `workboard and skill workshop keep regular task flow on wide I pad sizes`() {
        #expect(
            !IPadWorkboardScreen.usesCompactTaskFlow(
                horizontalSizeClass: .regular,
                verticalSizeClass: .regular))
        #expect(
            !IPadSkillWorkshopScreen.usesCompactTaskFlow(
                horizontalSizeClass: .regular,
                verticalSizeClass: .regular))
    }
}
