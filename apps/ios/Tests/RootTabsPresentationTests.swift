import OpenClawChatUI
import OpenClawProtocol
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct RootTabsPresentationTests {
    @Test func `session activity clamps current and future timestamps to just now`() {
        let now = Date(timeIntervalSince1970: 1_750_000_000)

        #expect(CommandCenterTab.relativeTimeText(
            forMilliseconds: now.timeIntervalSince1970 * 1000,
            relativeTo: now) == "just now")
        #expect(CommandCenterTab.relativeTimeText(
            forMilliseconds: now.addingTimeInterval(30).timeIntervalSince1970 * 1000,
            relativeTo: now) == "just now")
    }

    @Test func `dashboard deep link requests overview navigation`() async throws {
        let appModel = NodeAppModel()
        let initialRequestID = appModel.dashboardNavigationRequestID
        let url = try #require(URL(string: "openclaw://dashboard"))

        await appModel.handleDeepLink(url: url)

        #expect(appModel.dashboardNavigationRequestID == initialRequestID + 1)
        #expect(appModel.consumeDashboardNavigationRequest(appModel.dashboardNavigationRequestID))
        #expect(!appModel.consumeDashboardNavigationRequest(appModel.dashboardNavigationRequestID))
    }

    @Test func `sidebar gateway label ignores empty identity values`() {
        #expect(RootSidebar.gatewayName(serverName: "  ", remoteAddress: " gateway.example ") == "gateway.example")
        #expect(RootSidebar.gatewayName(serverName: "Gateway", remoteAddress: "fallback") == "Gateway")
        #expect(RootSidebar.gatewayName(serverName: nil, remoteAddress: "\n") == "Connection")
    }

    @Test func `new chat request is consumed once by the active chat owner`() {
        let appModel = NodeAppModel()

        appModel.requestNewChat()
        let firstRequestID = appModel.newChatRequestID
        #expect(appModel.consumeNewChatRequest(firstRequestID))
        #expect(!appModel.consumeNewChatRequest(firstRequestID))

        appModel.requestNewChat()
        #expect(!appModel.consumeNewChatRequest(firstRequestID))
        #expect(appModel.consumeNewChatRequest(appModel.newChatRequestID))
    }

    @Test func `overview session metrics exclude archived and internal sessions`() {
        let visible = CommandCenterTab.visibleOverviewSessions([
            Self.sessionEntry(key: "main"),
            Self.sessionEntry(key: "onboarding"),
            Self.sessionEntry(key: "agent:main:onboarding"),
            Self.sessionEntry(key: "archived", archived: true),
        ])

        #expect(visible.map(\.key) == ["main"])
    }

    @Test func `overview token usage sums known totals and marks stale or missing rows partial`() {
        let summary = RootSidebarModel.tokenUsageSummary(for: [
            Self.sessionEntry(key: "fresh", totalTokens: 1200, totalTokensFresh: true, contextTokens: 200_000),
            Self.sessionEntry(key: "stale", totalTokens: 300, totalTokensFresh: false, contextTokens: 200_000),
            Self.sessionEntry(key: "missing", contextTokens: 200_000),
        ])
        let complete = RootSidebarModel.tokenUsageSummary(for: [
            Self.sessionEntry(key: "one", totalTokens: 20, totalTokensFresh: true),
            Self.sessionEntry(key: "two", totalTokens: 80),
        ])
        let unknown = RootSidebarModel.tokenUsageSummary(for: [Self.sessionEntry(key: "unknown")])

        #expect(summary.total == 1500)
        #expect(summary.isPartial)
        #expect(complete.total == 100)
        #expect(!complete.isPartial)
        #expect(unknown.total == nil)
        #expect(unknown.isPartial)
    }

    @Test func `failed cron attention ignores disabled jobs`() {
        #expect(RootSidebarModel.isFailedCronJob(Self.cronJob(enabled: true, status: "error")))
        #expect(!RootSidebarModel.isFailedCronJob(Self.cronJob(enabled: false, status: "error")))
        #expect(!RootSidebarModel.isFailedCronJob(Self.cronJob(enabled: true, status: "ok")))
    }

    @Test func `recent session cap is disabled while search is active`() {
        #expect(RootSidebar.recentSessionCap(searchText: "") == 20)
        #expect(RootSidebar.recentSessionCap(searchText: "  \n") == 20)
        #expect(RootSidebar.recentSessionCap(searchText: "deploy") == nil)
    }

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

    @Test func `sidebar destinations match frozen page order`() {
        let destinationIDs = RootTabs.SidebarDestination.allCases.map(\.rawValue)

        #expect(RootTabs.sidebarDestinations == [
            .chat,
            .overview,
            .workboard,
            .usage,
            .cron,
            .sessions,
            .activity,
            .skillWorkshop,
            .agents,
            .instances,
            .files,
            .dreaming,
            .terminal,
            .docs,
        ])
        #expect(destinationIDs == [
            "chat",
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
        #expect(RootTabs.sidebarDestinations.contains(.chat))
        #expect(!RootTabs.sidebarDestinations.contains(.settings))
        #expect(!RootTabs.sidebarDestinations.contains(.gateway))
    }

    @Test func `sidebar uses compact labels for long routes`() {
        #expect(RootTabs.SidebarDestination.settings.title == "Settings")
        #expect(RootTabs.SidebarDestination.gateway.title == "Settings / Gateway")
        #expect(RootTabs.SidebarDestination.gateway.sidebarTitle == "Connection")
    }

    @Test func `app launch defaults to chat destination`() {
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw"]) == .chat)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab"]) == .chat)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab", "unknown"]) == .chat)
    }

    @Test func `app launch uses requested destination before chat fallback`() {
        #expect(RootTabs
            .initialDestination(arguments: ["OpenClaw", "--openclaw-initial-destination", "overview"]) == .overview)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-destination", "chat"]) == .chat)
        #expect(RootTabs
            .initialDestination(arguments: ["OpenClaw", "--openclaw-initial-destination", "agents"]) == .agents)
        #expect(RootTabs
            .initialDestination(arguments: ["OpenClaw", "--openclaw-initial-destination", "gateway"]) == .gateway)
        #expect(
            RootTabs.initialDestination(arguments: [
                "OpenClaw",
                "--openclaw-initial-tab",
                "unknown",
                "--openclaw-initial-destination",
                "activity",
            ]) == .activity)
    }

    @Test func `legacy initial tab aliases map directly to sidebar destinations`() {
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab", "control"]) == .overview)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab", "overview"]) == .overview)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab", "chat"]) == .chat)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab", "talk"]) == .chat)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab", "voice"]) == .chat)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab", "agents"]) == .agents)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab", "settings"]) == .settings)
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

    @Test func `chat keeps active voice capture stoppable while attachment ownership is pinned`() {
        #expect(ChatProTab.shouldExposeCaptureControl(
            isAttachmentOwnerPinned: true,
            isCaptureInFlight: true))
        #expect(!ChatProTab.shouldExposeCaptureControl(
            isAttachmentOwnerPinned: true,
            isCaptureInFlight: false))
        #expect(ChatProTab.shouldExposeCaptureControl(
            isAttachmentOwnerPinned: false,
            isCaptureInFlight: false))
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

    @Test func `settings can use parent navigation stack for sidebar routes`() {
        let standalone = SettingsProTab()
        let embedded = SettingsProTab(ownsNavigationStack: false)

        #expect(standalone.ownsNavigationStack)
        #expect(!embedded.ownsNavigationStack)
    }

    @Test func `localized QR status matcher accepts positional placeholders`() {
        #expect(SettingsProTab.localizedFormat(
            "qr loaded. connecting to %1$@:%2$@...",
            matches: "qr loaded. connecting to gateway.local:18789..."))
        #expect(!SettingsProTab.localizedFormat(
            "qr loaded. connecting to %1$@:%2$@...",
            matches: "qr loaded. connecting to gateway.local..."))
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

    @Test func `phone drawer uses the wider cap when space allows`() {
        #expect(RootTabs.sidebarWidth(containerWidth: 402, isDrawerLayout: true) == 340)
    }

    @Test func `sidebar shows configured agent rows with sane clamping`() {
        #expect(RootSidebar.shownAgentCount(configured: 1, total: 5) == 1)
        #expect(RootSidebar.shownAgentCount(configured: 3, total: 5) == 3)
        #expect(RootSidebar.shownAgentCount(configured: 0, total: 5) == 1)
        #expect(RootSidebar.shownAgentCount(configured: 3, total: 2) == 2)
        #expect(RootSidebar.shownAgentCount(configured: 1, total: 0) == 1)
    }

    @Test func `sidebar agent badges use canonical identity fallback`() {
        #expect(RootSidebar.agentBadge(
            name: "Research Agent",
            identity: ["emoji": AnyCodable(" 🦞 ")]) == "🦞")
        #expect(RootSidebar.agentBadge(
            name: "Research Agent",
            identity: ["emoji": AnyCodable("?")]) == "RA")
        #expect(RootSidebar.agentBadge(name: "Research Agent", identity: nil) == "RA")
    }

    @Test func `session work subtitle mirrors the web repo and branch line`() {
        func entry(repoRoot: String?, branch: String?) -> OpenClawChatSessionEntry {
            Self.sessionEntry(
                key: "agent:main:w1",
                worktree: OpenClawChatSessionWorktree(id: "w1", branch: branch, repoRoot: repoRoot))
        }
        #expect(ChatSessionSidebarModel.workSubtitle(
            for: entry(repoRoot: "/Users/dev/openclaw", branch: "openclaw/fix-thing")) == "openclaw \u{2387} fix-thing")
        #expect(ChatSessionSidebarModel.workSubtitle(
            for: entry(repoRoot: "/Users/dev/openclaw", branch: nil)) == "openclaw")
        #expect(ChatSessionSidebarModel.workSubtitle(for: entry(repoRoot: nil, branch: "main")) == nil)
        #expect(ChatSessionSidebarModel.workSubtitle(for: Self.sessionEntry(key: "plain")) == nil)
    }

    @Test func `sidebar subtitle keeps an unread final observer digest above work metadata`() {
        let digest = OpenClawChatSessionObserverDigest(
            revision: 4,
            updatedAt: 2000,
            headline: "Finished with warnings",
            health: "done")
        let unread = Self.sessionEntry(
            key: "agent:main:work",
            lastReadAt: 1999,
            observerDigest: digest)
        let read = Self.sessionEntry(
            key: "agent:main:work",
            lastReadAt: 2000,
            observerDigest: digest)

        #expect(ChatSessionSidebarModel.subtitle(
            for: unread,
            workSubtitle: "openclaw \u{2387} observer") == "Finished with warnings")
        #expect(ChatSessionSidebarModel.subtitle(
            for: read,
            workSubtitle: "openclaw \u{2387} observer") == "openclaw \u{2387} observer")
    }

    @Test func `sidebar registers event stream before subscription request`() async {
        var order: [String] = []
        let (stream, continuation) = AsyncStream<EventFrame>.makeStream()

        await RootSidebarModel.consumeSubscribedSessionEvents(
            makeStream: {
                order.append("stream")
                return stream
            },
            subscribe: {
                order.append("subscribe")
                continuation.yield(EventFrame(type: "event", event: "tick"))
                continuation.finish()
            },
            onEvent: { frame in
                order.append("event:\(frame.event)")
                return false
            },
            retryDelays: [.zero],
            sleep: { _ in
                throw CancellationError()
            })

        #expect(order == ["stream", "subscribe", "event:tick"])
    }

    @Test func `sidebar retries failed subscribe and resubscribes after stream completion`() async {
        enum TestError: Error { case transient }

        func sessionsChangedEvent(reason: String) -> EventFrame {
            EventFrame(
                type: "event",
                event: "sessions.changed",
                payload: AnyCodable([
                    "sessionKey": AnyCodable("agent:main:work"),
                    "reason": AnyCodable(reason),
                    "updatedAt": AnyCodable(200),
                ]))
        }

        var streamCount = 0
        var subscribeAttempts = 0
        var events: [String] = []

        await RootSidebarModel.consumeSubscribedSessionEvents(
            makeStream: {
                streamCount += 1
                return AsyncStream { continuation in
                    if streamCount == 2 {
                        continuation.yield(sessionsChangedEvent(reason: "patch"))
                    } else if streamCount == 3 {
                        continuation.yield(sessionsChangedEvent(reason: "message"))
                    }
                    continuation.finish()
                }
            },
            subscribe: {
                subscribeAttempts += 1
                if subscribeAttempts == 1 {
                    throw TestError.transient
                }
            },
            onEvent: { frame in
                guard case let .sessionsChanged(change) = OpenClawChatGatewayPayloadCodec.event(from: frame)
                else { return false }
                events.append(change.reason)
                return false
            },
            retryDelays: [.zero],
            sleep: { _ in
                if subscribeAttempts >= 3 {
                    throw CancellationError()
                }
            })

        #expect(streamCount == 3)
        #expect(subscribeAttempts == 3)
        #expect(events == ["patch", "message"])
    }

    @Test func `pinned pages storage round trips and preserves pin order`() {
        #expect(RootTabs.pinnedSidebarPages(from: "") == RootTabs.defaultPinnedSidebarPages)
        #expect(RootTabs.pinnedSidebarPages(from: "none").isEmpty)
        #expect(RootTabs.pinnedSidebarPagesStorage([]) == "none")

        // Storage order is the user's pin order (web parity).
        let parsed = RootTabs.pinnedSidebarPages(from: "usage,overview,docs")
        #expect(parsed == [.usage, .overview, .docs])

        let storage = RootTabs.pinnedSidebarPagesStorage([.docs, .overview, .usage])
        #expect(RootTabs.pinnedSidebarPages(from: storage) == [.docs, .overview, .usage])

        // Duplicates collapse to first occurrence.
        #expect(RootTabs.pinnedSidebarPages(from: "usage,usage,docs") == [.usage, .docs])

        // Unknown raw values are dropped; chat is never pinnable.
        #expect(RootTabs.pinnedSidebarPages(from: "chat,bogus").isEmpty)
        #expect(!RootTabs.pinnedSidebarPages(from: "chat,overview").contains(.chat))
        #expect(!RootTabs.pinnableSidebarPages.contains(.chat))
    }

    @Test func `drawer content follows reveal and dismiss drag`() {
        #expect(RootTabs.sidebarContentOffset(
            sidebarWidth: 340,
            isVisible: false,
            dragOffset: 0,
            reduceMotion: false) == 0)
        #expect(RootTabs.sidebarContentOffset(
            sidebarWidth: 340,
            isVisible: true,
            dragOffset: 0,
            reduceMotion: false) == 340)
        #expect(RootTabs.sidebarContentOffset(
            sidebarWidth: 340,
            isVisible: true,
            dragOffset: -120,
            reduceMotion: false) == 220)
        #expect(RootTabs.sidebarContentOffset(
            sidebarWidth: 340,
            isVisible: true,
            dragOffset: -400,
            reduceMotion: false) == 0)
        #expect(RootTabs.sidebarContentOffset(
            sidebarWidth: 340,
            isVisible: true,
            dragOffset: 40,
            reduceMotion: true) == 0)

        // Closed + positive drag = interactive edge-open follow, clamped to width.
        #expect(RootTabs.sidebarContentOffset(
            sidebarWidth: 340,
            isVisible: false,
            dragOffset: 120,
            reduceMotion: false) == 120)
        #expect(RootTabs.sidebarContentOffset(
            sidebarWidth: 340,
            isVisible: false,
            dragOffset: 500,
            reduceMotion: false) == 340)
        #expect(RootTabs.sidebarContentOffset(
            sidebarWidth: 340,
            isVisible: false,
            dragOffset: 120,
            reduceMotion: true) == 0)
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

    private static func sessionEntry(
        key: String,
        archived: Bool? = nil,
        totalTokens: Int? = nil,
        totalTokensFresh: Bool? = nil,
        contextTokens: Int? = nil,
        lastReadAt: Double? = nil,
        observerDigest: OpenClawChatSessionObserverDigest? = nil,
        worktree: OpenClawChatSessionWorktree? = nil) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: totalTokens,
            totalTokensFresh: totalTokensFresh,
            modelProvider: nil,
            model: nil,
            contextTokens: contextTokens,
            archived: archived,
            observerDigest: observerDigest,
            lastReadAt: lastReadAt,
            worktree: worktree)
    }

    private static func cronJob(enabled: Bool, status: String) -> CronJob {
        CronJob(
            id: "sidebar-test",
            name: "Sidebar test",
            enabled: enabled,
            createdatms: 1,
            updatedatms: 1,
            schedule: AnyCodable(["kind": AnyCodable("every")]),
            sessiontarget: AnyCodable("isolated"),
            wakemode: AnyCodable("now"),
            payload: AnyCodable(["kind": AnyCodable("agentTurn")]),
            state: [:],
            lastrunstatus: AnyCodable(status))
    }
}
