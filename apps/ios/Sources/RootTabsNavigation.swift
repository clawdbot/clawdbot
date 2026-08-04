import CoreGraphics
import Foundation
import SwiftUI

extension RootTabs {
    private static var sidebarPersistentWidthThreshold: CGFloat {
        980
    }

    static let sidebarSplitIdealWidth: CGFloat = 316
    static let sidebarSplitMaximumWidth: CGFloat = 340
    // Keep the web drawer's 86% reveal while using more of current iPhone widths.
    static let sidebarDrawerMaximumWidth: CGFloat = 340
    static let sidebarShowButtonAccessibilityIdentifier = "RootTabs.Sidebar.Show"
    static let sidebarHideButtonAccessibilityIdentifier = "RootTabs.Sidebar.Hide"

    enum SidebarDestination: String, CaseIterable, Hashable, Identifiable {
        case chat
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
            case .chat: String(localized: "Chat")
            case .overview: String(localized: "Overview")
            case .activity: String(localized: "Activity")
            case .agents: String(localized: "Agents")
            case .workboard: String(localized: "Workboard")
            case .skillWorkshop: String(localized: "Skill Workshop")
            case .instances: String(localized: "Instances")
            case .sessions: String(localized: "Sessions")
            case .files: String(localized: "Files")
            case .dreaming: String(localized: "Dreaming")
            case .usage: String(localized: "Usage")
            case .cron: String(localized: "Automations")
            case .terminal: String(localized: "Terminal")
            case .docs: String(localized: "Docs")
            case .settings: String(localized: "Settings")
            case .gateway: String(localized: "Settings / Gateway")
            }
        }

        var sidebarTitle: String {
            switch self {
            case .gateway: String(localized: "Connection")
            default: self.title
            }
        }

        var systemImage: String {
            switch self {
            case .chat: "bubble.left"
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

        var settingsRoute: SettingsRoute? {
            switch self {
            case .gateway:
                .gateway
            case .chat, .overview, .activity, .agents, .workboard, .skillWorkshop, .instances, .sessions,
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
            return min(self.sidebarDrawerMaximumWidth, containerWidth * 0.86)
        }
        return min(self.sidebarSplitMaximumWidth, max(self.sidebarSplitIdealWidth, containerWidth * 0.25))
    }

    static func sidebarContentOffset(
        sidebarWidth: CGFloat,
        isVisible: Bool,
        dragOffset: CGFloat,
        reduceMotion: Bool) -> CGFloat
    {
        guard !reduceMotion else { return 0 }
        if isVisible {
            return max(0, sidebarWidth + min(0, dragOffset))
        }
        // Closed: a positive drag is the interactive edge-open follow.
        return max(0, min(sidebarWidth, dragOffset))
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

    static let sidebarDestinations: [SidebarDestination] = [
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
    ]

    /// Home (chat) is a fixed first row like the web sidebar; only these can be
    /// pinned/unpinned by the user.
    static let pinnableSidebarPages: [SidebarDestination] = sidebarDestinations.filter { $0 != .chat }

    /// Echoes the web first-run Pages zone (Home, Usage, Automations, …):
    /// compact by default so sessions stay above the fold. The Sessions page is
    /// intentionally unpinned — the sessions section + "All Sessions…" own it.
    static let defaultPinnedSidebarPages: [SidebarDestination] = [.overview, .usage, .cron]

    /// "" = never customized (defaults); "none" = user unpinned everything.
    /// Storage order is the user's pin order (web parity); unknown or
    /// unpinnable raw values are dropped.
    static func pinnedSidebarPages(from storage: String) -> [SidebarDestination] {
        let trimmed = storage.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return self.defaultPinnedSidebarPages }
        if trimmed == "none" { return [] }
        var seen = Set<String>()
        return trimmed.split(separator: ",").compactMap { raw in
            let value = String(raw)
            guard seen.insert(value).inserted,
                  let destination = SidebarDestination(rawValue: value),
                  self.pinnableSidebarPages.contains(destination)
            else { return nil }
            return destination
        }
    }

    static func pinnedSidebarPagesStorage(_ pages: [SidebarDestination]) -> String {
        pages.isEmpty ? "none" : pages.map(\.rawValue).joined(separator: ",")
    }
}
