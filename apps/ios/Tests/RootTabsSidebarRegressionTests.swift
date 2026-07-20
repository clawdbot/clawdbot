import Foundation
import Testing

struct RootTabsSidebarRegressionTests {
    @Test func `i pad split hidden sidebar uses header reveal instead of reserved rail`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let navigationSource = try String(contentsOf: Self.rootTabsNavigationSourceURL(), encoding: .utf8)
        let splitContent = try Self.extract(
            source,
            from: "private func sidebarNavigationSplitContent(sidebarWidth: CGFloat) -> some View",
            to: "private func sidebarDrawerContent(")

        #expect(splitContent.contains("HStack(spacing: 0)"))
        #expect(splitContent.contains("self.sidebarColumn"))
        #expect(splitContent.contains(".frame(width: sidebarWidth, alignment: .topLeading)"))
        #expect(splitContent.contains(".overlay(alignment: .trailing)"))
        #expect(!splitContent.contains("self.syncSidebarVisibility(from: visibility)"))
        #expect(!source.contains("NavigationSplitViewVisibility"))
        #expect(!source.contains("@State private var splitColumnVisibility: NavigationSplitViewVisibility"))
        #expect(!splitContent.contains("NavigationSplitView"))
        #expect(!splitContent.contains("self.collapsedSidebarRail"))
        #expect(!source.contains("private var collapsedSidebarRail: some View"))
        #expect(!source.contains("Self.sidebarCollapsedRailWidth"))
        #expect(source.contains("shouldShowSidebarRevealInDestinationHeader"))
        #expect(!navigationSource.contains("static let sidebarCollapsedRailWidth"))
        #expect(!navigationSource.contains("static func sidebarSplitColumnVisibility(isSidebarVisible: Bool)"))
        #expect(!navigationSource
            .contains("static func sidebarIsVisible(splitColumnVisibility: NavigationSplitViewVisibility)"))
    }

    @Test func `initial sidebar visibility survives first layout measurement`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let layoutUpdate = try Self.extract(
            source,
            from: "private func updateSidebarLayout(containerSize: CGSize, force: Bool)",
            to: "private func setSidebarVisible(_ isVisible: Bool)")

        #expect(source.contains("@State private var didResolveSidebarLayout: Bool = false"))
        #expect(layoutUpdate.contains("let didResolvePreviousLayout = self.didResolveSidebarLayout"))
        #expect(layoutUpdate.contains("self.didResolveSidebarLayout = true"))
        #expect(layoutUpdate.contains("if layoutModeDidChange && didResolvePreviousLayout"))
        #expect(layoutUpdate.contains("guard force || !self.sidebarVisibilityUserOverridden else { return }"))
    }

    @Test func `push reveal keeps sidebar behind an interactive dismissal card`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let drawerContent = try Self.extract(
            source,
            from: "private func sidebarDrawerContent(",
            to: "private var sidebarDetailShell: some View")

        let sidebarLayer = try Self.extract(
            drawerContent,
            from: "private func sidebarDrawerLayer(",
            to: "private func sidebarDrawerContentSurface(")
        let contentSurface = try Self.extract(
            drawerContent,
            from: "private func sidebarDrawerContentSurface(",
            to: "private func sidebarDrawerContentCard(")
        let contentCardStart = try #require(
            drawerContent.range(of: "private func sidebarDrawerContentCard("))
        let contentCard = String(drawerContent[contentCardStart.lowerBound...])

        #expect(drawerContent.contains("ZStack(alignment: .leading)"))
        #expect(drawerContent.contains("self.sidebarDrawerLayer"))
        #expect(drawerContent.contains("self.sidebarDrawerContentSurface"))
        #expect(drawerContent.contains("self.sidebarDrawerContentCard"))
        #expect(drawerContent.contains(".background(OpenClawSidebarPalette.background)"))
        #expect(!drawerContent.contains("Color.black.opacity(0.35)"))
        #expect(!sidebarLayer.contains(".clipShape"))
        #expect(!sidebarLayer.contains(".shadow"))
        #expect(drawerContent.contains("self.sidebarColumn(drawerSafeAreaInsets: safeAreaInsets)"))
        #expect(sidebarLayer.contains(".ignoresSafeArea(.container, edges: .vertical)"))
        #expect(contentSurface.contains(".fill(Color(uiColor: .systemGroupedBackground))"))
        #expect(contentSurface.contains(".ignoresSafeArea(.container, edges: .vertical)"))
        #expect(contentSurface.contains(".shadow("))
        #expect(contentSurface.contains(".offset(x: Self.sidebarContentOffset("))
        #expect(contentCard.contains(".allowsHitTesting(!self.isSidebarVisible)"))
        #expect(contentCard.contains("if self.isSidebarVisible {"))
        #expect(contentCard.contains("self.hideSidebar()"))
        #expect(contentCard.contains("isEnabled: self.isSidebarVisible && !self.reduceMotion"))
        #expect(contentCard.contains("cornerRadius: OpenClawProMetric.drawerRadius * progress"))
        #expect(contentCard.contains(".offset(x: Self.sidebarContentOffset("))
        #expect(!contentCard.contains("OpenClawProBackground()"))
        #expect(!contentCard.contains(".shadow("))
    }

    @Test func `sidebar selection resets embedded settings navigation path`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let sidebarDetail = try Self.extract(
            source,
            from: "private var sidebarDetail: some View",
            to: "private var sidebarDetailNavigationShell: some View")
        let navigationShell = try Self.extract(
            source,
            from: "private var sidebarDetailNavigationShell: some View",
            to: "private var sidebarDetailShellID: String")
        let selection = try Self.extract(
            source,
            from: "private func selectSidebarDestination(",
            to: "private func handleOpenChatRequest(")
        let resetRange = try #require(selection.range(of: "self.sidebarNavigationPath.removeAll()"))
        let destinationRange = try #require(selection.range(of: "self.selectedSidebarDestination = destination"))

        #expect(source.contains("@State private var sidebarNavigationPath: [SettingsRoute] = []"))
        #expect(navigationShell.contains("NavigationStack(path: self.$sidebarNavigationPath)"))
        #expect(sidebarDetail.contains("case .settings:"))
        #expect(sidebarDetail.contains("ownsNavigationStack: false"))
        #expect(resetRange.lowerBound < destinationRange.lowerBound)
    }

    @Test func `embedded overview routes view more through owning navigation stack`() throws {
        let rootTabsSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let commandCenterSource = try String(contentsOf: Self.commandCenterSourceURL(), encoding: .utf8)
        let sidebarDetail = try Self.extract(
            rootTabsSource,
            from: "private var sidebarDetail: some View",
            to: "private var sidebarDetailNavigationShell: some View")
        let iPadOverview = try Self.extract(sidebarDetail, from: "case .overview:", to: "case .activity:")
        let recentSessions = try Self.extract(
            commandCenterSource,
            from: "private var recentSessions: some View",
            to: "private func cardHeader(")
        #expect(commandCenterSource.contains("var openSessions: (() -> Void)?"))
        #expect(recentSessions.contains("if let openSessions"))
        #expect(recentSessions.contains("Button(action: openSessions)"))
        #expect(recentSessions.contains("NavigationLink"))
        #expect(iPadOverview.contains("openSessions: { self.selectSidebarDestination(.sessions) }"))
    }

    private static func rootTabsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootTabs.swift")
    }

    private static func rootTabsNavigationSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootTabsNavigation.swift")
    }

    private static func commandCenterSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/CommandCenterTab.swift")
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
