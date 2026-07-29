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

    @Test func `sidebar controls keep glass inside their hit target`() throws {
        let source = try String(contentsOf: Self.openClawProComponentsSourceURL(), encoding: .utf8)
        let revealButton = try Self.extract(
            source,
            from: "struct OpenClawSidebarControlButton: View",
            to: "struct OpenClawSidebarHeaderLeadingSlot: View")
        let toolbarItem = try Self.extract(
            source,
            from: "struct OpenClawSidebarToolbarItem: ToolbarContent",
            to: "struct OpenClawGlassControlGroup")

        let button = try Self.extract(
            revealButton,
            from: "private var button: some View",
            to: "@ViewBuilder\n    private var icon")
        let icon = try Self.extract(
            revealButton,
            from: "private var icon: some View",
            to: "@ViewBuilder\n    private func identified")

        #expect(revealButton.contains("self.identified(self.button.buttonStyle(.plain))"))
        #expect(button.contains(".frame(width: 44, height: 44)"))
        #expect(button.contains(".contentShape(Rectangle())"))
        #expect(icon.contains(".regular.interactive()"))
        #expect(icon.contains("in: Circle()"))
        #expect(icon.contains("width: OpenClawProMetric.compactControlSize"))
        #expect(toolbarItem.contains(".sharedBackgroundVisibility(.hidden)"))
    }

    @Test func `push reveal uses one full bleed card with local gesture state`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let drawerSource = try String(contentsOf: Self.rootSidebarDrawerSourceURL(), encoding: .utf8)
        let sidebarSource = try String(contentsOf: Self.rootSidebarSourceURL(), encoding: .utf8)
        let drawerContent = try Self.extract(
            source,
            from: "private func sidebarDrawerContent(",
            to: "private var sidebarDetailShell: some View")
        let contentCard = try Self.extract(
            drawerSource,
            from: "private var contentCard: some View",
            to: "@ViewBuilder\n    private var dismissalLayer")
        let drawerGesture = try Self.extract(
            drawerSource,
            from: "private var drawerGesture: some Gesture",
            to: "private static func dragDisposition(")
        let detailShell = try Self.extract(
            source,
            from: "private var sidebarDetailShell: some View",
            to: "private func sidebarColumn(")

        #expect(drawerContent.contains("RootSidebarDrawer("))
        #expect(drawerContent.contains("self.sidebarColumn(drawerSafeAreaInsets: safeAreaInsets)"))
        #expect(drawerContent.contains("self.sidebarDetailNavigationShell"))
        #expect(drawerContent.contains("self.isSidebarDetailRootVisible && self.sidebarNavigationPath.isEmpty"))
        #expect(!source.contains("sidebarDrawerContentSurface"))
        #expect(!source.contains("sidebarDrawerContentCard"))
        #expect(!source.contains("sidebarContentDragOffset"))

        #expect(drawerSource.contains("@GestureState(resetTransaction:"))
        #expect(drawerSource.contains(".simultaneousGesture("))
        #expect(drawerSource.contains("isEnabled: !self.reduceMotion"))
        #expect(drawerSource.contains(".accessibilityHidden(!self.isPresented)"))
        #expect(drawerSource.contains(".accessibilityHidden(self.isPresented)"))
        #expect(drawerSource.contains(".onTapGesture(perform: self.onHide)"))
        #expect(drawerSource.contains(".background(OpenClawSidebarPalette.background)"))
        #expect(drawerSource.contains(".ignoresSafeArea(.container, edges: .vertical)"))
        #expect(!drawerSource.contains("Color.black.opacity(0.35)"))
        #expect(!drawerSource.contains("UIScreenEdgePanGestureRecognizer"))

        #expect(contentCard.contains(".background(OpenClawProBackground())"))
        #expect(contentCard.contains(".ignoresSafeArea(.container, edges: .vertical)"))
        #expect(contentCard.contains(".allowsHitTesting(!self.isPresented)"))
        #expect(contentCard.contains(".clipShape(shape)"))
        #expect(contentCard.contains("shape.strokeBorder("))
        #expect(contentCard.contains(".offset(x: offset)"))
        #expect(!contentCard.contains("Color(uiColor: .systemGroupedBackground)"))
        #expect(!contentCard.contains(".shadow("))

        #expect(drawerGesture.contains(".updating(self.$dragState)"))
        #expect(drawerGesture.contains("if let latchedDisposition = state.disposition"))
        #expect(drawerGesture.contains("dragSession.disposition = disposition"))
        #expect(drawerGesture.contains("let disposition = dragSession.disposition"))
        #expect(drawerGesture.contains("dragSession.disposition = nil"))
        #expect(drawerGesture.contains("case .opening:"))
        #expect(drawerGesture.contains("case .closing:"))
        #expect(drawerGesture.contains("onShow()"))
        #expect(drawerGesture.contains("onHide()"))
        #expect(drawerSource.contains("value.startLocation.x <= RootSidebarDrawerMetric.edgeGestureWidth"))
        #expect(drawerSource.contains("value.startLocation.y > RootSidebarDrawerMetric.topGestureExclusion"))
        #expect(drawerSource.contains("value.translation.width > abs(value.translation.height)"))
        #expect(drawerSource.contains("-value.translation.width > abs(value.translation.height)"))
        #expect(drawerSource.contains("UnevenRoundedRectangle("))
        #expect(drawerSource.contains("topLeadingRadius: RootSidebarDrawerMetric.topLeadingRadius * progress"))
        #expect(drawerSource.contains("bottomLeadingRadius: RootSidebarDrawerMetric.cornerRadius * progress"))

        #expect(!source.contains("showsDismissButton:"))
        #expect(!sidebarSource.contains("let showsDismissButton: Bool"))
        #expect(!sidebarSource.contains("let selectSettingsRoute:"))
        #expect(source.contains("isDismissButtonEnabled: self.isSidebarVisible"))
        #expect(sidebarSource.contains("OpenClawSidebarControlButton(action: self.dismissAction)"))
        #expect(sidebarSource.contains(".allowsHitTesting(self.isDismissButtonEnabled)"))
        #expect(sidebarSource.contains(".accessibilityHidden(!self.isDismissButtonEnabled)"))
        #expect(sidebarSource.contains("accessibilityIdentifier: self.isDismissButtonEnabled"))
        #expect(sidebarSource.contains("systemName: \"xmark\""))
        #expect(detailShell.contains(".onAppear"))
        #expect(detailShell.contains("guard self.sidebarDetailShellID == shellID else { return }"))
        #expect(detailShell.contains("self.isSidebarDetailRootVisible = true"))
        #expect(detailShell.contains(".onDisappear"))
        #expect(detailShell.contains("self.isSidebarDetailRootVisible = false"))
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

    private static func rootSidebarDrawerSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootSidebarDrawer.swift")
    }

    private static func rootSidebarSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootSidebar.swift")
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

    private static func openClawProComponentsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/OpenClawProComponents.swift")
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
