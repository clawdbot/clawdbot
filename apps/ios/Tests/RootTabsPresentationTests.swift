import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct RootTabsPresentationTests {
    @Test func `notification guidance opens delivery setup before system permissions`() {
        #expect(RootTabs
            .notificationSettingsPath(servingEnabled: false, disclosureAccepted: false) == "/settings/device")
        #expect(RootTabs
            .notificationSettingsPath(servingEnabled: false, disclosureAccepted: true) == "/settings/device")
        #expect(RootTabs
            .notificationSettingsPath(servingEnabled: true, disclosureAccepted: false) == "/settings/device")
        #expect(RootTabs
            .notificationSettingsPath(servingEnabled: true, disclosureAccepted: true) == "/settings/device/permissions")
    }

    @Test func `every sidebar destination resolves to a native screen or a valid Dashboard route`() {
        let expected: [RootTabs.SidebarDestination: RootTabs.SidebarScreen] = [
            .chat: .chat, .overview: .overview, .agents: .agents, .sessions: .sessions,
            .files: .files, .desktop: .desktop, .terminal: .terminal, .docs: .docs,
            .settings: .settings, .gateway: .gateway,
            .activity: .dashboard("/activity"), .workboard: .dashboard("/workboard"),
            .skillWorkshop: .dashboard("/skills/workshop"), .instances: .dashboard("/settings/devices"),
            .dreaming: .dashboard("/settings/memory/dreams"), .usage: .dashboard("/usage"),
            .cron: .dashboard("/automations"),
        ]
        #expect(Set(expected.keys) == Set(RootTabs.SidebarDestination.allCases))
        for destination in RootTabs.SidebarDestination.allCases {
            #expect(expected[destination] == destination.screen)
            if case let .dashboard(path) = destination.screen {
                #expect(DashboardRouteMap.isValidSameAppPath(path))
            }
        }
    }

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
        let incompleteRoster = RootSidebarModel.tokenUsageSummary(
            for: [Self.sessionEntry(key: "known", totalTokens: 45, totalTokensFresh: true)],
            rosterIsComplete: false)

        #expect(summary.total == 1500)
        #expect(summary.isPartial)
        #expect(complete.total == 100)
        #expect(!complete.isPartial)
        #expect(unknown.total == nil)
        #expect(unknown.isPartial)
        #expect(incompleteRoster.total == 45)
        #expect(incompleteRoster.isPartial)
    }

    @Test func `session roster loads every gateway page beyond the former thousand-row ceiling`() async throws {
        let entries = (0..<1205).map { Self.sessionEntry(key: "session-\($0)") }
        var offsets: [Int] = []

        let snapshot = try await ChatSessionRosterSnapshot.collect { offset in
            offsets.append(offset)
            let page = Array(entries.dropFirst(offset).prefix(200))
            let nextOffset = offset + page.count
            return OpenClawChatSessionsListResponse(
                ts: nil,
                path: nil,
                count: page.count,
                totalCount: entries.count,
                offset: offset,
                nextOffset: nextOffset < entries.count ? nextOffset : nil,
                hasMore: nextOffset < entries.count,
                defaults: nil,
                sessions: page)
        }

        #expect(offsets == [0, 200, 400, 600, 800, 1000, 1200])
        #expect(snapshot.sessions.count == 1205)
        #expect(snapshot.sessions.last?.key == "session-1204")
        #expect(snapshot.totalCount == 1205)
        #expect(snapshot.isComplete)
    }

    @Test func `session roster bounds an endlessly advancing gateway snapshot without dropping rows`() async throws {
        var requestCount = 0

        let snapshot = try await ChatSessionRosterSnapshot.collect { offset in
            requestCount += 1
            guard requestCount <= 51 else { throw URLError(.networkConnectionLost) }
            let sessions = (offset..<(offset + 200)).map { Self.sessionEntry(key: "session-\($0)") }
            return OpenClawChatSessionsListResponse(
                ts: nil,
                path: nil,
                count: sessions.count,
                totalCount: offset + 400,
                offset: offset,
                nextOffset: offset + sessions.count,
                hasMore: true,
                defaults: nil,
                sessions: sessions)
        }

        #expect(requestCount == 50)
        #expect(snapshot.sessions.count == 10000)
        #expect(snapshot.sessions.last?.key == "session-9999")
        #expect(!snapshot.isComplete)
    }

    @Test func `session roster preserves successful pages when a later request fails`() async throws {
        let firstPage = (0..<200).map { Self.sessionEntry(key: "session-\($0)") }

        let snapshot = try await ChatSessionRosterSnapshot.collect { offset in
            guard offset == 0 else { throw URLError(.networkConnectionLost) }
            return OpenClawChatSessionsListResponse(
                ts: nil,
                path: nil,
                count: firstPage.count,
                totalCount: 350,
                offset: offset,
                nextOffset: firstPage.count,
                hasMore: true,
                defaults: nil,
                sessions: firstPage)
        }

        #expect(snapshot.sessions.count == 200)
        #expect(snapshot.totalCount == 350)
        #expect(!snapshot.isComplete)
    }

    @Test func `session roster rejects a nonadvancing gateway cursor without losing rows`() async throws {
        var requestCount = 0

        let snapshot = try await ChatSessionRosterSnapshot.collect { offset in
            requestCount += 1
            return OpenClawChatSessionsListResponse(
                ts: nil,
                path: nil,
                count: 1,
                totalCount: 2,
                offset: offset,
                nextOffset: offset,
                hasMore: true,
                defaults: nil,
                sessions: [Self.sessionEntry(key: "first")])
        }

        #expect(requestCount == 1)
        #expect(snapshot.sessions.map(\.key) == ["first"])
        #expect(!snapshot.isComplete)
    }

    @Test func `session roster propagates cancellation after a successful page`() async {
        await #expect(throws: CancellationError.self) {
            _ = try await ChatSessionRosterSnapshot.collect { offset in
                guard offset == 0 else { throw CancellationError() }
                return OpenClawChatSessionsListResponse(
                    ts: nil,
                    path: nil,
                    count: 1,
                    totalCount: 2,
                    offset: offset,
                    nextOffset: 1,
                    hasMore: true,
                    defaults: nil,
                    sessions: [Self.sessionEntry(key: "first")])
            }
        }
    }

    @Test func `iOS usage requests device calendar days`() throws {
        let cases: [(timeZoneID: String, timestamp: TimeInterval, expectedOffset: String)] = [
            ("America/Los_Angeles", 1_769_000_000, "UTC-8"),
            ("America/Los_Angeles", 1_785_000_000, "UTC-7"),
            ("Asia/Kathmandu", 1_785_000_000, "UTC+5:45"),
        ]

        for testCase in cases {
            let timeZone = try #require(TimeZone(identifier: testCase.timeZoneID))
            let paramsJSON = CostUsageRequest.monthParamsJSON(
                timeZone: timeZone,
                date: Date(timeIntervalSince1970: testCase.timestamp))
            let data = try #require(paramsJSON.data(using: .utf8))
            let params = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

            #expect(params["days"] as? Int == 31)
            #expect(params["mode"] as? String == "specific")
            #expect(params["timeZone"] as? String == testCase.timeZoneID)
            #expect(params["utcOffset"] as? String == testCase.expectedOffset)
        }
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
            .desktop,
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
            "desktop",
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

    @Test func `chat header follows the agent badge presentation`() {
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
            navigationPath: [.approvals, .licenses],
            baseRoute: .gateway) == .licenses)
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

    @Test func `keyboard contracted content uses portrait window for sidebar layout`() {
        let size = RootTabs.sidebarLayoutContainerSize(
            contentSize: CGSize(width: 1032, height: 973),
            windowSize: CGSize(width: 1032, height: 1376))

        #expect(size == CGSize(width: 1032, height: 1376))
        #expect(RootTabs.sidebarLayoutMode(containerSize: size) == .drawer)
    }

    @Test func `sidebar layout container falls back to content size without a window`() {
        let contentSize = CGSize(width: 900, height: 600)

        #expect(RootTabs.sidebarLayoutContainerSize(contentSize: contentSize, windowSize: nil) == contentSize)
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

    @Test func `sidebar session accessibility names pin and unread state`() {
        #expect(RootSidebar.sessionAccessibilityValue(isPinned: false, isUnread: false).isEmpty)
        #expect(RootSidebar.sessionAccessibilityValue(isPinned: true, isUnread: false) == "Pinned")
        #expect(RootSidebar.sessionAccessibilityValue(isPinned: false, isUnread: true) == "Unread")
        #expect(RootSidebar.sessionAccessibilityValue(isPinned: true, isUnread: true) == "Pinned, Unread")
    }

    @Test func `iOS sidebar moves pinned sessions ahead of the remaining inventory`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                Self.sessionEntry(key: "pinned", pinned: true),
                Self.sessionEntry(key: "recent"),
            ],
            currentSessionKey: "recent",
            excludesMainSession: true,
            query: "")

        let layout = RootSidebar.sessionLayout(sections)

        #expect(layout.pinnedNodes.map(\.session.key) == ["pinned"])
        #expect(layout.sections.map(\.id) == ["recent"])
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

    @Test func `sidebar replays actual observer visibility after each reconnect`() async {
        var isVisible = true
        var subscribeAttempts = 0
        var declarations: [Bool] = []

        await RootSidebarModel.consumeSubscribedSessionEvents(
            makeStream: {
                AsyncStream { continuation in
                    continuation.finish()
                }
            },
            subscribe: {
                subscribeAttempts += 1
            },
            onEvent: { _ in false },
            observerVisibility: { isVisible },
            declareObserverVisibility: { visible in
                declarations.append(visible)
            },
            retryDelays: [.zero],
            sleep: { _ in
                guard subscribeAttempts == 1 else {
                    throw CancellationError()
                }
                isVisible = false
            })

        #expect(subscribeAttempts == 2)
        #expect(declarations == [true, false])
    }

    @Test func `sidebar invalidates a confirmed same-route observer after resubscription`() async {
        let route = "same-operator-route"
        var subscribeAttempts = 0
        var confirmation: (route: String, visible: Bool)? = (route, true)
        var declarations: [Bool] = []

        await RootSidebarModel.consumeSubscribedSessionEvents(
            makeStream: {
                AsyncStream { continuation in
                    continuation.finish()
                }
            },
            subscribe: {
                subscribeAttempts += 1
            },
            onEvent: { _ in false },
            invalidateObserverDeclaration: {
                confirmation = nil
            },
            observerVisibility: { true },
            declareObserverVisibility: { visible in
                guard confirmation?.route != route || confirmation?.visible != visible else { return }
                declarations.append(visible)
                confirmation = (route, visible)
            },
            retryDelays: [.zero],
            sleep: { _ in
                guard subscribeAttempts == 1 else {
                    throw CancellationError()
                }
            })

        #expect(subscribeAttempts == 2)
        #expect(declarations == [true, true])
        #expect(confirmation?.route == route)
        #expect(confirmation?.visible == true)
    }

    @Test func `sidebar rejects an old visibility acknowledgement after same-route resubscription`() async {
        let route = "same-operator-route"
        var subscribeAttempts = 0
        var generation: UInt64 = 0
        var confirmation: RootSidebarModel.SessionObserverDeclaration<String>?
        var firstAcknowledgementGeneration: UInt64?
        var rejectedOldAcknowledgement = false
        var declarations: [Bool] = []

        await RootSidebarModel.consumeSubscribedSessionEvents(
            makeStream: {
                AsyncStream { continuation in
                    continuation.finish()
                }
            },
            subscribe: {
                subscribeAttempts += 1
            },
            onEvent: { _ in false },
            invalidateObserverDeclaration: {
                generation &+= 1
                confirmation = nil

                if let firstAcknowledgementGeneration {
                    let oldAcknowledgement = RootSidebarModel.confirmedSessionObserverDeclaration(
                        route: route,
                        visible: true,
                        generation: firstAcknowledgementGeneration,
                        currentGeneration: generation,
                        currentVisibility: true)
                    rejectedOldAcknowledgement = oldAcknowledgement == nil
                    if let oldAcknowledgement {
                        confirmation = oldAcknowledgement
                    }
                }
            },
            observerVisibility: { true },
            declareObserverVisibility: { visible in
                let declaration = RootSidebarModel.SessionObserverDeclaration(
                    route: route,
                    visible: visible,
                    generation: generation)
                guard confirmation != declaration else { return }
                declarations.append(visible)

                if subscribeAttempts == 1 {
                    firstAcknowledgementGeneration = generation
                } else {
                    confirmation = RootSidebarModel.confirmedSessionObserverDeclaration(
                        route: route,
                        visible: visible,
                        generation: generation,
                        currentGeneration: generation,
                        currentVisibility: true)
                }
            },
            retryDelays: [.zero],
            sleep: { _ in
                guard subscribeAttempts == 1 else {
                    throw CancellationError()
                }
            })

        #expect(subscribeAttempts == 2)
        #expect(rejectedOldAcknowledgement)
        #expect(declarations == [true, true])
        #expect(confirmation?.route == route)
        #expect(confirmation?.visible == true)
        #expect(confirmation?.generation == 2)
    }

    @Test func `sidebar observer identity restarts for foreground and background transitions`() {
        let foreground = RootTabs.SessionObserverTaskIdentity(
            sidebarRefreshID: "gateway:main",
            isSceneActive: true,
            isSidebarVisible: true)
        let background = RootTabs.SessionObserverTaskIdentity(
            sidebarRefreshID: "gateway:main",
            isSceneActive: false,
            isSidebarVisible: true)
        let foregroundAgain = RootTabs.SessionObserverTaskIdentity(
            sidebarRefreshID: "gateway:main",
            isSceneActive: true,
            isSidebarVisible: true)
        let hidden = RootTabs.SessionObserverTaskIdentity(
            sidebarRefreshID: "gateway:main",
            isSceneActive: true,
            isSidebarVisible: false)

        #expect(foreground != background)
        #expect(background != foregroundAgain)
        #expect(foreground == foregroundAgain)
        #expect(foreground != hidden)
        #expect(foreground.isObserverVisible)
        #expect(!background.isObserverVisible)
        #expect(foregroundAgain.isObserverVisible)
        #expect(!hidden.isObserverVisible)
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

    private static func sessionEntry(
        key: String,
        archived: Bool? = nil,
        pinned: Bool? = nil,
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
            pinned: pinned,
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
