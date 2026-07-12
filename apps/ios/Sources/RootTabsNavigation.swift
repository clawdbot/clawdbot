import CoreGraphics
import Foundation
import SwiftUI

extension RootTabs {
    struct PhoneChatReturn: Equatable {
        let destination: SidebarDestination
        let openChatRequestID: Int
    }

    struct PhoneControlNavigationRequest: Equatable {
        enum Target: Equatable {
            case root
            case detail(SidebarDestination)
        }

        let id: Int
        let target: Target
    }

    private static var sidebarPersistentWidthThreshold: CGFloat {
        980
    }

    static let sidebarSplitIdealWidth: CGFloat = 316
    static let sidebarSplitMaximumWidth: CGFloat = 340
    static let sidebarDrawerMaximumWidth: CGFloat = 340
    static let sidebarShowButtonAccessibilityIdentifier = "RootTabs.Sidebar.Show"
    static let sidebarHideButtonAccessibilityIdentifier = "RootTabs.Sidebar.Hide"

    enum AppTab: Hashable {
        case control
        case chat
        case talk
        case agent
        case settings
    }

    enum SidebarDestination: String, CaseIterable, Hashable, Identifiable {
        case chat
        case talk
        case overview
        case activity
        case agents
        case workboard
        case skillWorkshop
        case instances
        case sessions
        case files
        case dreaming
        case usage
        case cron
        case terminal
        case docs
        case settings
        case gateway

        var id: String {
            rawValue
        }

        var title: String {
            switch self {
            case .chat: "Chat"
            case .talk: "Talk"
            case .overview: "Overview"
            case .activity: "Activity"
            case .agents: "Agents"
            case .workboard: "Workboard"
            case .skillWorkshop: "Skill Workshop"
            case .instances: "Instances"
            case .sessions: "Sessions"
            case .files: "Files"
            case .dreaming: "Dreaming"
            case .usage: "Usage"
            case .cron: "Cron Jobs"
            case .terminal: "Terminal"
            case .docs: "Docs"
            case .settings: "Settings"
            case .gateway: "Settings / Gateway"
            }
        }

        var sidebarTitle: String {
            switch self {
            case .gateway: "Connection"
            default: self.title
            }
        }

        var systemImage: String {
            switch self {
            case .chat: "bubble.left"
            case .talk: "waveform.circle"
            case .overview: "chart.bar"
            case .activity: "waveform.path.ecg"
            case .agents: "person.2"
            case .workboard: "folder"
            case .skillWorkshop: "hammer"
            case .instances: "dot.radiowaves.left.and.right"
            case .sessions: "doc.text"
            case .files: "folder.fill"
            case .dreaming: "moon.stars"
            case .usage: "chart.bar.xaxis"
            case .cron: "timer"
            case .terminal: "terminal"
            case .docs: "book"
            case .settings: "gearshape"
            case .gateway: "gearshape"
            }
        }

        var appTab: AppTab {
            switch self {
            case .chat:
                .chat
            case .talk:
                .talk
            case .agents:
                .agent
            case .settings, .gateway:
                .settings
            case .overview, .activity, .workboard, .skillWorkshop, .instances, .sessions, .files,
                 .dreaming,
                 .usage,
                 .cron, .terminal, .docs:
                .control
            }
        }

        var settingsRoute: SettingsRoute? {
            switch self {
            case .gateway:
                .gateway
            case .chat, .talk, .overview, .activity, .agents, .workboard, .skillWorkshop, .instances, .sessions,
                 .files,
                 .dreaming,
                 .usage, .cron, .terminal, .settings, .docs:
                nil
            }
        }
    }

    enum SidebarLayoutMode: Equatable {
        case drawer
        case split
    }

    static func sidebarLayoutMode(containerSize: CGSize) -> SidebarLayoutMode {
        containerSize.width < self.sidebarPersistentWidthThreshold || containerSize.height > containerSize.width
            ? .drawer
            : .split
    }

    static func preferredSidebarVisibility(layoutMode: SidebarLayoutMode) -> Bool {
        layoutMode == .split
    }

    static func shouldCollapseSidebarAfterSelection(layoutMode: SidebarLayoutMode) -> Bool {
        layoutMode == .drawer
    }

    static func sidebarWidth(containerWidth: CGFloat, isDrawerLayout: Bool) -> CGFloat {
        if isDrawerLayout {
            return min(self.sidebarDrawerMaximumWidth, max(280, containerWidth * 0.86))
        }
        return min(self.sidebarSplitMaximumWidth, max(self.sidebarSplitIdealWidth, containerWidth * 0.25))
    }

    static func shouldShowSidebarRevealControl(isSidebarVisible: Bool) -> Bool {
        !isSidebarVisible
    }

    static func visibleSettingsRoute(
        navigationPath: [SettingsRoute],
        baseRoute: SettingsRoute?) -> SettingsRoute?
    {
        navigationPath.last ?? baseRoute
    }

    static func shouldShowSidebarRevealInDestinationHeader(
        isSidebarVisible: Bool,
        layoutMode: SidebarLayoutMode) -> Bool
    {
        switch layoutMode {
        case .split:
            true
        case .drawer:
            self.shouldShowSidebarRevealControl(isSidebarVisible: isSidebarVisible)
        }
    }

    static func requestedInitialSidebarVisibility(arguments: [String]) -> Bool? {
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-sidebar-visibility") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }

        switch arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "visible", "show", "shown", "open", "true", "1":
            return true
        case "hidden", "hide", "closed", "false", "0":
            return false
        default:
            return nil
        }
    }

    static func shouldOpenRootTabFromPhoneHub(_ destination: SidebarDestination) -> Bool {
        switch destination {
        case .chat, .talk, .agents, .gateway, .settings:
            true
        case .overview, .activity, .workboard, .skillWorkshop, .instances, .sessions, .files,
             .dreaming,
             .usage,
             .cron, .terminal, .docs:
            false
        }
    }

    static func defaultSidebarDestination(for tab: AppTab) -> SidebarDestination {
        switch tab {
        case .control:
            .overview
        case .chat:
            .chat
        case .talk:
            .talk
        case .agent:
            .agents
        case .settings:
            .settings
        }
    }

    enum StartupPresentationRoute: Equatable {
        case none
        case onboarding
        case settings
    }

    static func startupPresentationRoute(
        gatewayConnected: Bool,
        hasConnectedOnce: Bool,
        onboardingComplete: Bool,
        hasExistingGatewayConfig: Bool,
        shouldPresentOnLaunch: Bool) -> StartupPresentationRoute
    {
        if gatewayConnected {
            return .none
        }
        // Saved gateway state survives independently of the onboarding markers.
        // Explicit resets bypass this route through evaluateOnboardingPresentation(force:).
        if hasExistingGatewayConfig {
            return .none
        }
        if shouldPresentOnLaunch || !hasConnectedOnce || !onboardingComplete {
            return .onboarding
        }
        return .settings
    }

    static func shouldPresentQuickSetup(
        quickSetupDismissed: Bool,
        showOnboarding: Bool,
        hasPresentedSheet: Bool,
        gatewayConnected: Bool,
        hasExistingGatewayConfig: Bool,
        discoveredGatewayCount: Int) -> Bool
    {
        guard !quickSetupDismissed else { return false }
        guard !showOnboarding else { return false }
        guard !hasPresentedSheet else { return false }
        guard !gatewayConnected else { return false }
        guard !hasExistingGatewayConfig else { return false }
        return discoveredGatewayCount > 0
    }

    struct SidebarGroup: Identifiable {
        let title: String
        let destinations: [SidebarDestination]

        var id: String {
            self.title
        }
    }

    static let sidebarGroups: [SidebarGroup] = [
        SidebarGroup(title: "CHAT", destinations: [.chat, .talk]),
        SidebarGroup(
            title: "CONTROL",
            destinations: [
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
            ]),
        SidebarGroup(
            title: "SETTINGS",
            destinations: [.settings]),
        SidebarGroup(title: "REFERENCE", destinations: [.docs]),
    ]

    static var phoneControlGroups: [SidebarGroup] {
        // Agents owns a bottom tab and its hub entry duplicated the same destination;
        // Chat and Talk stay per the tested Control-hub IA contract.
        let tabOwned: Set<SidebarDestination> = [.agents]
        return self.sidebarGroups
            .map { group in
                SidebarGroup(
                    title: group.title,
                    destinations: group.destinations.filter { !tabOwned.contains($0) })
            }
            .filter { !$0.destinations.isEmpty }
    }
}
