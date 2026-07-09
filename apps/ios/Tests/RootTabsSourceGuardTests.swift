import Foundation
import Testing

struct RootTabsSourceGuardTests {
    @Test func `hidden sidebar reveal uses destination header without reserved rail`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let componentSource = try String(contentsOf: Self.proComponentsSourceURL(), encoding: .utf8)

        #expect(source.contains("sidebarHeaderLeadingAction"))
        #expect(source.contains("Hide Sidebar"))
        #expect(source.contains("Show Sidebar"))
        #expect(source.contains("shouldShowSidebarRevealInDestinationHeader"))
        #expect(source.contains("layoutMode: self.isSidebarDrawerLayout ? .drawer : .split"))
        #expect(componentSource.contains("OpenClawSidebarHeaderLeadingSlot"))
        #expect(componentSource.contains(".frame(width: 44, height: 44, alignment: .center)"))
        #expect(source.contains(".safeAreaPadding(.top, 8)"))
        #expect(source.contains("Self.sidebarShowButtonAccessibilityIdentifier"))
        #expect(source.contains("Self.sidebarHideButtonAccessibilityIdentifier"))
        #expect(source.contains("accessibilityLabel: \"Hide Sidebar\""))
        #expect(source.contains("accessibilityLabel: \"Show Sidebar\""))
        #expect(source.contains("action: { self.hideSidebar() }"))
        #expect(source.contains("action: { self.showSidebar() }"))
        #expect(!source.contains("private var collapsedSidebarRail: some View"))
        #expect(!source.contains("Self.sidebarCollapsedRailWidth"))
        #expect(source.contains("requestedInitialSidebarVisibility"))
        #expect(!source.contains("@State private var splitColumnVisibility: NavigationSplitViewVisibility"))
        #expect(!source.contains("NavigationSplitView(columnVisibility: self.$splitColumnVisibility)"))
        #expect(source.contains("HStack(spacing: 0)"))
        #expect(!source.contains("self.syncSidebarVisibility(from: visibility)"))
        #expect(!source.contains("shouldReserveSidebarRevealInset"))
        #expect(!source.contains("safeAreaInset(edge: .top"))
        #expect(!source.contains("thinMaterial, in: Circle"))
        #expect(!source.contains("sidebarRevealInset"))
        #expect(source.contains("Color.black.opacity(0.28)"))
        #expect(source.contains(".background(Color(uiColor: .systemBackground))"))
        #expect(!source.contains("sidebarRevealCornerButton"))
        #expect(!source.contains("shouldShowSidebarRevealOverlay"))
        #expect(!source.contains("shouldShowOverviewHeaderSidebarReveal"))
    }

    @Test func `i pad split uses sliding sidebar while portrait keeps drawer overlay`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let splitContent = try Self.extract(
            source,
            from: "private func sidebarNavigationSplitContent(sidebarWidth: CGFloat) -> some View",
            to: "private func sidebarDrawerContent(sidebarWidth: CGFloat) -> some View")
        let drawerContent = try Self.extract(
            source,
            from: "private func sidebarDrawerContent(sidebarWidth: CGFloat) -> some View",
            to: "private var sidebarDetailShell: some View")

        #expect(!source.contains("@State private var splitColumnVisibility: NavigationSplitViewVisibility"))
        #expect(!source.contains("Self.sidebarSplitColumnVisibility(isSidebarVisible:"))
        #expect(!source.contains("self.syncSidebarVisibility(from: visibility)"))
        #expect(splitContent.contains("HStack(spacing: 0)"))
        #expect(splitContent.contains("self.sidebarColumn"))
        #expect(splitContent.contains(".frame(width: sidebarWidth, alignment: .topLeading)"))
        #expect(splitContent.contains(".overlay(alignment: .trailing)"))
        #expect(splitContent.contains("self.sidebarVerticalSeparator"))
        #expect(splitContent.contains("self.sidebarDetailNavigationShell"))
        #expect(!splitContent.contains("NavigationSplitView"))
        #expect(!splitContent.contains("self.collapsedSidebarRail"))
        #expect(!source.contains("Self.sidebarCollapsedRailWidth"))
        #expect(drawerContent.contains("ZStack(alignment: .topLeading)"))
        #expect(drawerContent.contains("Color.black.opacity(0.28)"))
        #expect(drawerContent.contains(".transition(.move(edge: .leading).combined(with: .opacity))"))
        #expect(!drawerContent.contains("NavigationSplitView"))
    }

    @Test func `phone tab bar keeps chat first product order`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let phoneTabContent = try Self.extract(
            source,
            from: "private var phoneTabContent: some View",
            to: "private var sidebarSplitContent: some View")

        let chatRange = try #require(phoneTabContent.range(of: "ChatProTab("))
        let talkRange = try #require(phoneTabContent.range(of: "TalkProTab("))
        let controlRange = try #require(phoneTabContent.range(of: "RootTabsPhoneControlHub("))
        let agentRange = try #require(phoneTabContent.range(of: "AgentProTab("))
        let settingsRange = try #require(phoneTabContent.range(of: "SettingsProTab("))

        #expect(chatRange.lowerBound < talkRange.lowerBound)
        #expect(talkRange.lowerBound < controlRange.lowerBound)
        #expect(controlRange.lowerBound < agentRange.lowerBound)
        #expect(agentRange.lowerBound < settingsRange.lowerBound)
        #expect(phoneTabContent.matches(of: /PhoneTabSettingsHost(?:\([^\n]+\))? \{/).count == 3)
    }

    @Test func `sidebar keeps navigation model destination only`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let navigationSource = try String(contentsOf: Self.rootTabsNavigationSourceURL(), encoding: .utf8)
        let sidebarColumn = try Self.extract(
            source,
            from: "private var sidebarColumn: some View",
            to: "private var sidebarList: some View")

        #expect(source.contains("ForEach(Self.sidebarGroups)"))
        #expect(!source.contains("Section(\"Context\")"))
        #expect(!source.contains("sidebarAgentMenu"))
        #expect(!source.contains("sidebarDeviceMenu"))
        #expect(sidebarColumn.contains("self.sidebarIdentityHeader"))
        #expect(source.contains("private var sidebarIdentityHeader: some View"))
        #expect(source.contains("OpenClawProMark(size: 30"))
        #expect(source.contains("Text(\"OpenClaw\")"))
        #expect(source.contains("private var sidebarGatewayStatusTitle: String"))
        #expect(source.contains("private var sidebarGatewayStatusColor: Color"))
        #expect(!sidebarColumn.contains("activeAgent"))
        #expect(!source.contains("shouldShowSidebarColumnHeader"))
        #expect(!source.contains("private var sidebarColumnHeader: some View"))
        #expect(sidebarColumn.contains(".safeAreaPadding(.top, 8)"))
        #expect(source.contains(".scrollContentBackground(.hidden)"))
        #expect(source.contains(".listStyle(.sidebar)"))
        #expect(source.contains("private var sidebarHorizontalSeparator: some View"))
        #expect(source.contains("private var sidebarVerticalSeparator: some View"))
        #expect(source.contains("1 / UIScreen.main.scale"))
        #expect(!source.contains("geometry.size.height >= Self.sidebarListNonScrollingMinimumHeight"))
        #expect(!source.contains("private var sidebarListContent: some View"))
        #expect(source.contains(".listRowSeparator(.hidden, edges: .all)"))
        #expect(source.contains(".listSectionSeparator(.hidden, edges: .all)"))
        #expect(source.contains("if self.isSidebarDrawerLayout {"))
        #expect(!source.contains("private var sidebarFooter: some View"))
        #expect(!source.contains("LabeledContent(\"Version\""))
        #expect(navigationSource.contains("SidebarGroup(title: \"CHAT\", destinations: [.chat, .talk])"))
        #expect(!navigationSource.contains("title: \"AGENT\""))
        #expect(navigationSource.contains("case settings"))
        #expect(!navigationSource.contains("case settingsChannels"))
        #expect(!navigationSource.contains("case settingsApprovals"))
        #expect(!navigationSource.contains("case settingsPrivacy"))
        #expect(navigationSource.contains("SidebarGroup(\n            title: \"SETTINGS\""))
        #expect(navigationSource.contains("destinations: [.settings]"))
        #expect(!navigationSource.contains("destinations: [.gateway"))
        #expect(!navigationSource.contains("SidebarGroup(title: \"REFERENCE\", destinations: [.settings"))
        #expect(navigationSource.contains("SidebarGroup(title: \"REFERENCE\", destinations: [.docs])"))
    }

    @Test func `sidebar routes use destination headers instead of repeated product branding`() throws {
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let agentOverviewSource = try String(contentsOf: Self.agentProTabOverviewSourceURL(), encoding: .utf8)
        let docsSource = try String(contentsOf: Self.docsSourceURL(), encoding: .utf8)
        let sidebarDetail = try Self.extract(
            rootSource,
            from: "private var sidebarDetail: some View",
            to: "private var sidebarDetailNavigationShell: some View")

        #expect(sidebarDetail.contains("headerTitle: \"Chat\""))
        #expect(sidebarDetail.contains("headerTitle: \"Overview\""))
        #expect(sidebarDetail.contains("headerTitle: \"Agents\""))
        #expect(sidebarDetail.contains("headerTitle: \"Instances\""))
        #expect(!sidebarDetail.contains("headerTitle: \"Nodes\""))
        #expect(sidebarDetail.contains("directRoute: .agents"))
        #expect(sidebarDetail.contains("directRoute: .instances"))
        #expect(sidebarDetail.contains("directRoute: .dreaming"))
        #expect(sidebarDetail.contains("directRoute: .usage"))
        #expect(sidebarDetail.contains("directRoute: .cron"))
        #expect(!sidebarDetail.contains("initialRoute: .nodes"))
        #expect(!sidebarDetail.contains("initialRoute: .usage"))
        #expect(!sidebarDetail.contains("initialRoute: .cron"))
        #expect(sidebarDetail.contains("headerTitle: \"Dreaming\""))
        #expect(sidebarDetail.contains("headerTitle: \"Usage\""))
        #expect(sidebarDetail.contains("headerTitle: \"Cron Jobs\""))
        #expect(!sidebarDetail.contains("headerTitle: \"OpenClaw\""))
        #expect(agentOverviewSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(agentOverviewSource.contains("title: self.headerTitle"))
        #expect(!agentOverviewSource.contains("Text(\"OpenClaw\")"))
        #expect(docsSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(docsSource.contains("title: \"Docs\""))
        #expect(!docsSource.contains("Text(\"OpenClaw Docs\")"))
    }

    @Test func `agents direct route keeps single sidebar control`() throws {
        let source = try String(contentsOf: Self.agentProTabSourceURL(), encoding: .utf8)
        let destinationsSource = try String(contentsOf: Self.agentProTabDestinationsSourceURL(), encoding: .utf8)
        let nodesSource = try String(contentsOf: Self.agentProNodesDestinationSourceURL(), encoding: .utf8)
        let dreamingSource = try String(contentsOf: Self.agentProDreamingDestinationSourceURL(), encoding: .utf8)

        #expect(source
            .contains("route != .agents && self.directHeaderLeadingAction(for: route) != nil ? .hidden : .visible"))
        #expect(destinationsSource.contains(".navigationTitle(self.headerTitle)"))
        #expect(destinationsSource.contains(".searchable(text: self.$agentSearchText"))
        #expect(destinationsSource.contains("ToolbarItemGroup(placement: .topBarTrailing)"))
        #expect(!destinationsSource.contains(".toolbar(.hidden, for: .navigationBar)"))
        #expect(destinationsSource.contains("self.directHeaderLeadingAction(for: .instances)"))
        #expect(destinationsSource.contains("self.directHeaderLeadingAction(for: .dreaming)"))
        #expect(destinationsSource.contains("self.directHeader(\n                        for: .usage"))
        #expect(destinationsSource.contains("self.directHeader(\n                        for: .cron"))
        #expect(destinationsSource.contains("self.directRoute == route ? self.headerLeadingAction : nil"))
        #expect(nodesSource.contains("OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)"))
        #expect(dreamingSource.contains("OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)"))
    }

    @Test func `iOS 26 chrome uses native glass while content cards stay quiet`() throws {
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let appSource = try String(contentsOf: Self.openClawAppSourceURL(), encoding: .utf8)
        let componentsSource = try String(contentsOf: Self.proComponentsSourceURL(), encoding: .utf8)
        let cardSurface = try Self.extract(
            componentsSource,
            from: "private struct ProPanelSurfaceModifier: ViewModifier",
            to: "struct ProIconBadge: View")

        #expect(rootSource.contains(".openClawTabBarBehavior()"))
        #expect(appSource.contains(".preferredColorScheme(self.appearanceModel.preference.colorScheme)"))
        #expect(!appSource.contains("overrideUserInterfaceStyle"))
        #expect(componentsSource.contains("content.tabBarMinimizeBehavior(.onScrollDown)"))
        #expect(componentsSource.contains(".buttonStyle(.glassProminent)"))
        #expect(componentsSource.contains(".buttonStyle(.glass)"))
        #expect(componentsSource.contains("GlassEffectContainer(spacing: 8)"))
        #expect(componentsSource.contains("if #available(iOS 26.0, *)"))
        #expect(componentsSource.contains(".buttonStyle(.borderedProminent)"))
        #expect(componentsSource.contains(".buttonStyle(.bordered)"))
        #expect(componentsSource.contains("struct OpenClawNoticeBanner: View"))
        #expect(!cardSurface.contains("glassEffect"))
    }

    @Test func `professional layout avoids nested pills and card stacks`() throws {
        let componentsSource = try String(contentsOf: Self.proComponentsSourceURL(), encoding: .utf8)
        let agentSource = try String(contentsOf: Self.agentProTabOverviewSourceURL(), encoding: .utf8)
        let agentDestinationsSource = try String(
            contentsOf: Self.agentProTabDestinationsSourceURL(),
            encoding: .utf8)
        let talkSource = try String(contentsOf: Self.talkProTabSourceURL(), encoding: .utf8)
        let settingsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let overviewSource = try String(contentsOf: Self.commandCenterSourceURL(), encoding: .utf8)
        let overviewRowsSource = try String(contentsOf: Self.commandCenterSupportSourceURL(), encoding: .utf8)
        let gatewayStatus = try Self.extract(
            componentsSource,
            from: "struct OpenClawGatewayCompactPill: View",
            to: "struct ProMetricTile: View")
        let agentFilterMenu = try Self.extract(
            agentSource,
            from: "var agentFilterMenu: some View",
            to: "var agentFiltersActive: Bool")
        let agentRow = try Self.extract(
            agentSource,
            from: "func agentRow(_ agent: AgentSummary) -> some View",
            to: "func headerIconButton(")
        let settingsList = try Self.extract(
            settingsSource,
            from: "var settingsListSection: some View",
            to: "func settingsListRow(")
        let settingsRow = try Self.extract(
            settingsSource,
            from: "func settingsListRow(",
            to: "func destination(for route:")
        let appearanceScreen = try Self.extract(
            settingsSource,
            from: "private struct AppearanceSettingsScreen: View",
            to: "extension SettingsProTab")
        #expect(gatewayStatus.contains("OpenClawStatusBadge(label: self.title, tone: self.tone)"))
        #expect(!gatewayStatus.contains("ProCapsule("))
        #expect(!gatewayStatus.contains("Capsule()"))
        #expect(agentDestinationsSource.contains("List {"))
        #expect(agentDestinationsSource.contains(".searchable(text: self.$agentSearchText"))
        #expect(agentFilterMenu.contains("Picker(\"Agent status\""))
        #expect(!agentFilterMenu.contains(".pickerStyle(.segmented)"))
        #expect(agentFilterMenu.contains("agent-status-filter-menu"))
        #expect(!agentRow.contains("agentMetric"))
        #expect(!agentRow.contains("chevron.right"))
        #expect(agentRow.contains("Image(systemName: \"checkmark\")"))
        #expect(agentRow.contains("agentAccessibilityLabel"))
        #expect(!talkSource.contains("conversationCard"))
        #expect(!talkSource.contains("voiceModeCard"))
        #expect(!talkSource.contains("statusChip"))
        #expect(settingsList.contains("Text(\"Device\")"))
        #expect(settingsList.contains(".font(OpenClawType.captionSemiBold)"))
        #expect(!settingsList.contains("ProCard("))
        #expect(settingsRow.contains("NavigationLink(value: route)"))
        #expect(!settingsRow.contains("chevron.right"))
        #expect(settingsSource.contains("settings-appearance-row"))
        #expect(appearanceScreen.contains("AppearanceSettingsScreen"))
        #expect(!appearanceScreen.contains(".pickerStyle(.segmented)"))
        #expect(!overviewSource.contains("ProCapsule("))
        #expect(overviewSource.contains("value: self.gatewayConnectionText"))
        #expect(overviewSource.contains("switch self.gatewayDisplayState"))
        #expect(overviewSource.contains("case .connecting:"))
        #expect(overviewSource.contains("case .error:"))
        #expect(!overviewRowsSource.contains("private var rowFill"))
        #expect(overviewRowsSource.matches(of: /.contentShape\(Rectangle\(\)\)/).count >= 2)
    }

    @Test func `settings about page shows concise public device details`() throws {
        let settingsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let aboutDestination = try Self.extract(
            settingsSource,
            from: "var aboutDestination: some View",
            to: "func toggleCard(")
        let diagnosticsDestination = try Self.extract(
            settingsSource,
            from: "var diagnosticsDestination: some View",
            to: "var privacyDestination: some View")

        #expect(!aboutDestination.contains("detailStatusCard("))
        #expect(aboutDestination.contains("detailListCard"))
        #expect(aboutDestination.contains("SettingsDetailRow(\"OpenClaw app version\""))
        #expect(aboutDestination.contains("SettingsDetailRow(\"Device\", value: DeviceInfoHelper.deviceFamily())"))
        #expect(aboutDestination
            .contains("SettingsDetailRow(\"iOS\", value: DeviceInfoHelper.iOSVersionStringForDisplay())"))
        #expect(!aboutDestination.contains("SettingsDetailRow(\"Version\""))
        #expect(!aboutDestination.contains("SettingsDetailRow(\"Platform\""))
        #expect(!aboutDestination.contains("SettingsDetailRow(\"Model\""))
        #expect(diagnosticsDestination
            .contains("SettingsDetailRow(\"Device\", value: DeviceInfoHelper.deviceFamily())"))
        #expect(diagnosticsDestination
            .contains("SettingsDetailRow(\"Platform\", value: DeviceInfoHelper.platformStringForDisplay())"))
        #expect(diagnosticsDestination
            .contains("SettingsDetailRow(\"Model\", value: DeviceInfoHelper.modelIdentifier())"))
    }

    @Test func `routed headers use shared adaptive layout`() throws {
        let componentsSource = try String(contentsOf: Self.proComponentsSourceURL(), encoding: .utf8)
        let featureChromeSource = try String(contentsOf: Self.iPadSidebarScreenChromeSourceURL(), encoding: .utf8)
        let docsSource = try String(contentsOf: Self.docsSourceURL(), encoding: .utf8)
        let overviewSource = try String(contentsOf: Self.commandCenterSourceURL(), encoding: .utf8)
        let chatSource = try String(contentsOf: Self.chatProTabSourceURL(), encoding: .utf8)
        let agentOverviewSource = try String(contentsOf: Self.agentProTabOverviewSourceURL(), encoding: .utf8)
        let settingsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)

        #expect(componentsSource.contains("struct OpenClawAdaptiveHeaderRow<Leading: View, Accessory: View>: View"))
        #expect(componentsSource.contains("ViewThatFits(in: .horizontal)"))
        #expect(componentsSource.contains("private var stackedLayout: some View"))
        #expect(componentsSource.contains(".layoutPriority(1)"))
        #expect(componentsSource.contains(".fixedSize(horizontal: true, vertical: false)"))
        #expect(featureChromeSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(featureChromeSource.contains("if !self.usesNativeNavigationChrome"))
        #expect(!featureChromeSource.contains("if self.headerLeadingAction != nil"))
        #expect(docsSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(docsSource.contains("if !self.usesNativeNavigationChrome"))
        #expect(overviewSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(overviewSource.matches(of: /if !self\.usesNativeNavigationChrome/).count == 2)
        #expect(chatSource.contains(".navigationTitle(self.headerDisplayTitle)"))
        #expect(chatSource.contains("OpenClawSidebarRevealButton(action: headerLeadingAction)"))
        #expect(!chatSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(agentOverviewSource.contains("OpenClawAdaptiveHeaderRow("))
        #expect(settingsSource.contains("ToolbarItem(placement: .topBarLeading)"))
    }

    @Test func `phone hub keeps docs as destination only`() throws {
        let source = try String(contentsOf: Self.phoneHubSourceURL(), encoding: .utf8)

        #expect(source.contains("case .docs:"))
        #expect(source.contains("OpenClawDocsScreen("))
        #expect(source.contains("gatewayAction: { self.openGatewayDetail() }"))
        #expect(!source.contains("phoneDetailBackAction"))
        #expect(!source.contains("Label(\"Docs\", systemImage: \"book\")"))
        #expect(!source.contains("https://docs.openclaw.ai"))
    }

    @Test func `root shell preview matrix covers phone and I pad states`() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\n    \"Shell iPhone portrait\""))
        #expect(source.contains("#Preview(\n    \"Shell iPhone landscape\""))
        #expect(source.contains("#Preview(\n    \"Shell iPhone connected\""))
        #expect(source.contains("#Preview(\n    \"Shell iPhone gateway error\""))
        #expect(source.contains("#Preview(\n    \"Shell iPad portrait drawer\""))
        #expect(source.contains("#Preview(\n    \"Shell iPad landscape split\""))
        #expect(source.contains("#Preview(\n    \"Shell iPad connecting\""))
        #expect(source.contains("#Preview(\n    \"Shell iPad gateway error\""))
    }

    @Test func `shared chat preview matrix covers connection states`() throws {
        let source = try String(contentsOf: Self.sharedChatPreviewSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\"Chat connected\")"))
        #expect(source.contains("#Preview(\"Chat empty\")"))
        #expect(source.contains("#Preview(\"Chat loading\")"))
        #expect(source.contains("#Preview(\"Chat gateway error\")"))
        #expect(source.contains("enum Scenario"))
        #expect(source.contains("case connected"))
        #expect(source.contains("case empty"))
        #expect(source.contains("case loading"))
        #expect(source.contains("case error"))
        #expect(source.contains("Gateway not connected. Check Tailscale and retry."))
    }

    @Test func `phone hub lets the native list respect the floating tab bar`() throws {
        let source = try String(contentsOf: Self.phoneHubSourceURL(), encoding: .utf8)

        #expect(source.contains("List {"))
        #expect(source.contains(".listStyle(.insetGrouped)"))
        #expect(!source.contains("bottomScrollInset"))
        #expect(!source.contains("safeAreaPadding(.bottom"))
    }

    @Test func `phone hub stays task first without duplicating root tabs`() throws {
        let source = try String(contentsOf: Self.phoneHubSourceURL(), encoding: .utf8)

        #expect(source.contains("private var gatewayRow: some View"))
        #expect(source.contains(".accessibilityLabel(\"Gateway \\(self.gatewayStateText),"))
        #expect(!source.contains("ProValuePill(value: self.gatewayStateText"))
        #expect(!source.contains("destination.subtitle"))
        #expect(source.contains("self.openGatewayDetail()"))
        #expect(!source.contains("self.openPhoneRootDestination(.gateway)"))
        #expect(source.contains("group.destinations.filter { !self.opensRootTab($0) }"))
        #expect(!source.contains("phoneDetailBackAction"))
        #expect(!source.contains(".navigationBarBackButtonHidden(true)"))
        #expect(!source.contains(".toolbar(.hidden, for: .navigationBar)"))
        #expect(source.matches(of: /usesNativeNavigationChrome: true/).count == 7)
        #expect(!source.contains("directRoute: .agents"))
        #expect(!source.contains("Image(systemName: \"gearshape\")"))
        #expect(!source.contains("self.metric(label:"))
        #expect(!source.contains("private func metric(label:"))
    }

    @Test func `phone hub clears detail path before root tab handoff`() throws {
        let source = try String(contentsOf: Self.phoneHubSourceURL(), encoding: .utf8)
        let handoff = try Self.extract(
            source,
            from: "private func openPhoneRootDestination(_ destination: RootTabs.SidebarDestination)",
            to: "private func opensRootTab(_ destination: RootTabs.SidebarDestination)")
        let clearRange = try #require(handoff.range(of: "self.navigationPath.removeAll()"))
        let openRange = try #require(handoff.range(of: "self.openRootDestination(destination)"))

        #expect(source.contains("NavigationStack(path: self.$navigationPath)"))
        #expect(!source.contains("self.openRootDestination(.gateway)"))
        #expect(source.contains("self.navigationPath.append(.gateway)"))
        #expect(clearRange.lowerBound < openRange.lowerBound)
    }

    @Test func `workboard uses real gateway methods`() throws {
        let source = try String(contentsOf: Self.iPadWorkboardScreenSourceURL(), encoding: .utf8)

        #expect(source.contains("workboard.cards.list"))
        #expect(source.contains("workboard.cards.create"))
        #expect(source.contains("workboard.cards.move"))
        #expect(source.contains("workboard.cards.archive"))
        #expect(source.contains("workboard.cards.dispatch"))
        #expect(source.contains(".padding(.bottom, 12)"))
        #expect(!source.contains("Workboard gateway contract unavailable"))
        #expect(!source.contains("supportsGatewayContract"))
        #expect(!source.contains("Compact mobile queue control"))
        #expect(!source.contains("Multi-column queue control"))
    }

    @Test func `workboard dismisses card sheet before opening chat`() throws {
        let source = try String(contentsOf: Self.iPadWorkboardScreenSourceURL(), encoding: .utf8)
        let openFunction = try Self.extract(
            source,
            from: "private func open(_ card: IPadWorkboardCard)",
            to: "private func replace(_ card: IPadWorkboardCard)")
        let dismiss = try #require(openFunction.range(of: "self.presentedSheet = nil"))
        let focus = try #require(openFunction.range(of: "self.appModel.openChat(sessionKey: sessionKey)"))
        let route = try #require(openFunction.range(of: "self.openChat()"))

        #expect(dismiss.lowerBound < focus.lowerBound)
        #expect(focus.lowerBound < route.lowerBound)
    }

    @Test func `workboard create action surfaces unavailable reasons`() throws {
        let source = try String(contentsOf: Self.iPadWorkboardScreenSourceURL(), encoding: .utf8)
        let createFunction = try Self.extract(
            source,
            from: "private func createCard() async -> Bool",
            to: "private func move(_ card: IPadWorkboardCard, to status: String) async")

        #expect(source.contains("private var createUnavailableMessage: String?"))
        #expect(source.contains("Enter a title to create a card."))
        #expect(source.contains("Card creation is already in progress."))
        #expect(source.contains("private func newCardButton(expands: Bool) -> some View"))
        #expect(source.contains("private func beginCreateCard()"))
        #expect(source.contains("self.newCardButton(expands: false)"))
        #expect(source.contains("self.newCardButton(expands: true)"))
        #expect(source.contains("Label(\"New Card\", systemImage: \"plus\")"))
        #expect(source.contains(".accessibilityHint(\"Opens card title and notes entry\")"))
        #expect(source.contains(".accessibilityHint(self.createUnavailableMessage ?? \"Creates a workboard card\")"))
        #expect(source.contains("if await self.createCard()"))
        #expect(source.contains(".disabled(self.isCreatingCard)"))
        #expect(!source.contains("Button(\"Create\")"))
        #expect(!source.contains("TextField(\"New card\""))
        #expect(!source.contains(".disabled(!self.canWrite || self.draftTitle"))
        #expect(createFunction.contains("self.errorText = createUnavailableMessage"))
        #expect(createFunction.contains("return false"))
        #expect(createFunction.contains("return true"))
    }

    @Test func `task scope controls send real gateway params`() throws {
        let source = try Self.iPadTaskFeatureScreensSource()

        #expect(source.contains("private var boardScopeMenu: some View"))
        #expect(source.contains("method: \"workboard.boards.list\""))
        #expect(source.contains("IPadWorkboardListParams(boardId: selectedBoardParam)"))
        #expect(source.contains("boardId: selectedBoardParam"))
        #expect(source
            .matches(
                of: /method: "workboard\.cards\.dispatch"[\s\S]*?IPadWorkboardListParams\(boardId: selectedBoardParam\)/)
            .count == 1)
        #expect(source.contains("private var agentScopeMenu: some View"))
        #expect(source.contains("IPadSkillProposalListParams(agentId: selectedAgentParam)"))
        #expect(source.contains("agentId: selectedAgentParam"))
        #expect(!source
            .contains(
                "params: EmptyParams(),\n                timeoutSeconds: 20)\n            let response = try JSONDecoder().decode(IPadSkillProposalManifest.self"))
    }

    @Test func `compact task rows keep phone native actions`() throws {
        let source = try Self.iPadTaskFeatureScreensSource()
        let compactControls = try Self.extract(
            source,
            from: "private var compactQueueControls: some View",
            to: "private var compactRefreshButton: some View")

        #expect(source.contains("struct IPadWorkboardQueueRow"))
        #expect(source.contains("private var actionMenuItems: some View"))
        #expect(source.components(separatedBy: ".contextMenu {").count - 1 >= 2)
        #expect(source.components(separatedBy: ".swipeActions(edge: .leading").count - 1 >= 2)
        #expect(source.components(separatedBy: ".swipeActions(edge: .trailing").count - 1 >= 2)
        #expect(source.contains("@State private var presentedProposalRoute: IPadSkillProposalSheetRoute?"))
        #expect(source.contains(".sheet(item: self.$presentedProposalRoute)"))
        #expect(source.contains("private func selectProposal("))
        #expect(!source.contains("proposalSheetPresented"))
        #expect(source.contains("self.presentedSheet = .card(card)"))
        #expect(!source.contains("Label(\"Gateway\", systemImage: \"network\")"))
        #expect(!source.contains("Button(\"Gateway\")"))
        #expect(!source.contains("actionTitle: self.canRead ? nil : \"Gateway\""))
        #expect(!source.contains("Workboard offline"))
        #expect(!source.contains("Workshop offline"))
        #expect(!source.contains("Connect gateway to"))
        #expect(source.contains("private var compactRefreshButton: some View"))
        #expect(source.contains("private var compactBoardScopeMenu: some View"))
        #expect(source.contains("Color(uiColor: .secondarySystemGroupedBackground)"))
        #expect(source.contains(".allowsHitTesting(false)"))
        #expect(compactControls.contains("self.compactRefreshButton"))
        #expect(compactControls.contains("self.compactBoardScopeMenu"))
        #expect(!compactControls.contains("Self.workboardSubtitle("))
        #expect(!compactControls.contains("Label(\"Refresh\""))
        #expect(compactControls.contains("Label(\"Dispatch\""))
    }

    @Test func `skill workshop uses kanban lanes on wide I pad`() throws {
        let source = try String(contentsOf: Self.iPadSkillWorkshopScreenSourceURL(), encoding: .utf8)
        let previewSource = try String(contentsOf: Self.iPadSidebarFeaturePreviewsSourceURL(), encoding: .utf8)
        let content = try Self.extract(
            source,
            from: "private var proposalContent: some View",
            to: "private var proposalBoard: some View")
        let board = try Self.extract(
            source,
            from: "private var proposalBoard: some View",
            to: "private var proposalList: some View")

        #expect(content.contains("if self.isCompactWidth"))
        #expect(content.contains("self.proposalList"))
        #expect(content.contains("self.proposalBoard"))
        #expect(!content.contains("self.proposalDetail"))
        #expect(board.contains("ScrollView(.horizontal)"))
        #expect(board.contains("IPadSkillProposalKanbanColumn("))
        #expect(source.contains("private struct IPadSkillProposalKanbanCard"))
        #expect(source.contains("static let defaultProposalStatusBoardLanes"))
        #expect(source.contains("private func proposals(forLaneStatus status: String)"))
        #expect(previewSource.contains("#Preview(\n    \"Skill Workshop iPad kanban lanes\""))
        #expect(previewSource.contains("private struct IPadSkillWorkshopKanbanPreview"))
        #expect(previewSource.contains("IPadSkillProposalKanbanColumn("))
        #expect(previewSource.contains("status: \"needs-review\""))
        #expect(previewSource.contains("status: \"manual_QA\""))
    }

    @Test func `compact task rows have populated phone previews`() throws {
        let source = try String(contentsOf: Self.iPadSidebarFeaturePreviewsSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\"Workboard phone queue rows\")"))
        #expect(source.contains("#Preview(\"Skill Workshop phone queue rows\")"))
        #expect(source.contains("private struct IPadWorkboardCompactRowsPreview"))
        #expect(source.contains("private struct IPadSkillWorkshopCompactRowsPreview"))
        #expect(source.contains("IPadWorkboardPreviewFixtures.cards"))
        #expect(source.contains("IPadSkillWorkshopPreviewFixtures.proposals"))
    }

    @Test func `task screen preview matrices cover primary states`() throws {
        let source = try String(contentsOf: Self.iPadSidebarFeaturePreviewsSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\"Workboard states\")"))
        #expect(source.contains("private struct IPadWorkboardStatesPreview"))
        #expect(source.contains("self.previewHeader(\"Connected\")"))
        #expect(source.contains("self.previewHeader(\"Empty\")"))
        #expect(source.contains("self.previewHeader(\"Loading\")"))
        #expect(source.contains("self.previewHeader(\"Error\")"))
        #expect(source.contains("title: \"Loading cards\""))
        #expect(source.contains("title: \"Cards unavailable\""))
        #expect(source.contains("IPadWorkboardKanbanColumn("))

        #expect(source.contains("#Preview(\"Skill Workshop states\")"))
        #expect(source.contains("private struct IPadSkillWorkshopStatesPreview"))
        #expect(source.contains("self.previewHeader(\"Offline / Error\")"))
        #expect(source.contains("title: \"No proposals\""))
        #expect(source.contains("title: \"Workshop offline\""))
        #expect(source.contains("title: \"Proposal unavailable\""))
        #expect(source.contains("#Preview(\n    \"Skill Workshop iPad kanban lanes\""))
        #expect(source.contains("private struct IPadSkillWorkshopKanbanPreview"))
        #expect(source.contains("\"needs-review\""))
        #expect(source.contains("\"manual_QA\""))
    }

    @Test func `activity preview matrix covers connection states`() throws {
        let source = try String(contentsOf: Self.iPadSidebarFeaturePreviewsSourceURL(), encoding: .utf8)

        #expect(source.contains("#Preview(\"Activity states\")"))
        #expect(source.contains("private struct IPadActivityStatesPreview"))
        #expect(source.contains("self.previewHeader(\"Connected\")"))
        #expect(source.contains("self.previewHeader(\"Loading\")"))
        #expect(source.contains("self.previewHeader(\"Empty\")"))
        #expect(source.contains("self.previewHeader(\"Error\")"))
        #expect(source.contains("title: \"Sessions unavailable\""))
        #expect(source.contains("title: \"No recent sessions\""))
        #expect(source.contains("title: \"Loading sessions\""))
    }

    @Test func `routed feature screens reuse shared pro components`() throws {
        let source = try Self.iPadTaskFeatureScreensSource()
        let componentsSource = try String(contentsOf: Self.proComponentsSourceURL(), encoding: .utf8)
        let channelsSource = try String(contentsOf: Self.channelsSourceURL(), encoding: .utf8)

        #expect(source.contains("ProMetricGrid(metrics: self.metrics)"))
        #expect(source.contains("ProPanelHeader("))
        #expect(source.contains("ProStatusRow("))
        #expect(!source.contains("private struct ProMetricGrid"))
        #expect(!source.contains("private struct ProMetric"))
        #expect(!source.contains("private struct ProPanelHeader"))
        #expect(!source.contains("private struct ProStatusRow"))
        #expect(!channelsSource.contains("private struct SettingsChannelPanelHeader"))
        #expect(!channelsSource.contains("private struct SettingsChannelInfoRow"))
        #expect(componentsSource.contains("struct ProMetricGrid"))
        #expect(componentsSource.contains("struct ProPanelHeader"))
        #expect(componentsSource.contains("struct ProStatusRow"))
    }

    @Test func `activity screen stays split from task feature screens`() throws {
        let taskSource = try Self.iPadTaskFeatureScreensSource()
        let activitySource = try String(contentsOf: Self.iPadActivityScreenSourceURL(), encoding: .utf8)
        let appModelSource = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let projectSource = try String(contentsOf: Self.xcodeProjectSourceURL(), encoding: .utf8)

        #expect(activitySource.contains("struct IPadActivityScreen: View"))
        #expect(activitySource.contains("self.appModel.makeChatTransport()"))
        #expect(appModelSource.contains("return IOSGatewayChatTransport("))
        #expect(appModelSource.contains("globalAgentId: self.chatDeliveryAgentId"))
        #expect(!appModelSource.contains("defaultAgentId: self.gatewayDefaultAgentId"))
        #expect(activitySource.contains("IPadSidebarScreenChrome("))
        #expect(!taskSource.contains("struct IPadActivityScreen"))
        #expect(!taskSource.contains("import OpenClawChatUI"))
        #expect(projectSource.contains("IPadActivityScreen.swift in Sources"))
    }

    @Test func `routed feature chrome stays split from task feature screens`() throws {
        let taskSource = try Self.iPadTaskFeatureScreensSource()
        let chromeSource = try String(contentsOf: Self.iPadSidebarScreenChromeSourceURL(), encoding: .utf8)
        let projectSource = try String(contentsOf: Self.xcodeProjectSourceURL(), encoding: .utf8)

        #expect(chromeSource.contains("struct IPadSidebarScreenChrome<Content: View>: View"))
        #expect(chromeSource.contains("OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)"))
        #expect(chromeSource.contains("OpenClawGatewayCompactPill()"))
        #expect(!taskSource.contains("struct IPadSidebarScreenChrome"))
        #expect(projectSource.contains("IPadSidebarScreenChrome.swift in Sources"))
    }

    @Test func `routed feature chrome keeps gateway pill actionable`() throws {
        let chromeSource = try String(contentsOf: Self.iPadSidebarScreenChromeSourceURL(), encoding: .utf8)
        let featureSource = try Self.iPadTaskFeatureScreensSource()
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)

        #expect(chromeSource.contains("let gatewayAction: (() -> Void)?"))
        #expect(chromeSource.contains("private var gatewayPill: some View"))
        #expect(chromeSource.contains("Button(action: gatewayAction)"))
        #expect(chromeSource.contains(".buttonBorderShape(.capsule)"))
        #expect(chromeSource.contains(".openClawGlassButton()"))
        #expect(chromeSource.contains(".accessibilityHint(\"Opens Settings / Gateway\")"))
        #expect(featureSource.matches(of: /gatewayAction: self\.openSettings/).count == 2)
        #expect(rootSource.contains("IPadActivityScreen("))
        #expect(rootSource
            .matches(of: /IPadActivityScreen\([\s\S]*?openSettings: \{ self\.selectSidebarDestination\(\.gateway\) \}/)
            .count == 1)
    }

    @Test func `routed gateway pills open gateway settings`() throws {
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let agentSource = try String(contentsOf: Self.agentProTabSourceURL(), encoding: .utf8)
        let agentOverviewSource = try String(contentsOf: Self.agentProTabOverviewSourceURL(), encoding: .utf8)
        let overviewSource = try String(contentsOf: Self.commandCenterSourceURL(), encoding: .utf8)
        let chatSource = try String(contentsOf: Self.chatProTabSourceURL(), encoding: .utf8)
        let docsSource = try String(contentsOf: Self.docsSourceURL(), encoding: .utf8)
        let settingsTabSource = try String(contentsOf: Self.settingsProTabSourceURL(), encoding: .utf8)
        let settingsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let notificationGuidanceSource = try String(
            contentsOf: Self.notificationPermissionGuidanceDialogSourceURL(),
            encoding: .utf8)

        #expect(rootSource.matches(of: /openSettings: \{ self\.selectSidebarDestination\(\.gateway\) \}/).count >= 2)
        #expect(rootSource.matches(of: /openVoiceSettings: \{ openSettingsRoute\(\.voice\) \}/).count == 1)
        #expect(rootSource.matches(of: /openVoiceSettings: \{ self\.selectSettingsRoute\(\.voice\) \}/).count == 1)
        #expect(rootSource.matches(of: /gatewayAction: \{ self\.selectSidebarDestination\(\.gateway\) \}/).count == 2)
        #expect(!rootSource.contains("showGatewayActions"))
        #expect(!rootSource.contains("gatewayActionsDialog"))
        #expect(overviewSource.contains("Button(action: self.openSettings)"))
        #expect(overviewSource.contains(".accessibilityHint(\"Opens gateway settings\")"))
        #expect(agentSource.contains("let openSettings: (() -> Void)?"))
        #expect(agentOverviewSource.contains("OpenClawGatewayCompactPill()"))
        #expect(agentOverviewSource.contains("Button(action: openSettings)"))
        #expect(rootSource
            .matches(of: /AgentProTab\([\s\S]*?openSettings: \{ self\.selectSidebarDestination\(\.gateway\) \}/)
            .count >= 3)
        #expect(chatSource.contains("let openSettings: (() -> Void)?"))
        #expect(chatSource.contains("private var connectionStatusButton: some View"))
        #expect(chatSource.contains(".buttonStyle(.plain)"))
        #expect(chatSource.contains(".accessibilityIdentifier(\"chat-gateway-status\")"))
        #expect(chatSource.contains("composerChrome: .clean"))
        #expect(docsSource.contains("let gatewayAction: (() -> Void)?"))
        #expect(docsSource.contains(".buttonBorderShape(.capsule)"))
        #expect(docsSource.contains(".openClawGlassButton()"))
        #expect(settingsSource.contains("NavigationLink(value: SettingsRoute.gateway)"))
        #expect(rootSource.contains("case .settings:"))
        #expect(rootSource
            .matches(
                of: /case \.settings:[\s\S]*?SettingsProTab\([\s\S]*?headerLeadingAction: self\.sidebarHeaderLeadingAction,[\s\S]*?ownsNavigationStack: false[\s\S]*?onRouteChange: handleSettingsRouteChange/)
            .count >= 1)
        #expect(rootSource
            .contains(
                "directRoute: self.selectedSettingsRoute ?? self.selectedSidebarDestination.settingsRoute ?? .gateway"))
        #expect(rootSource.contains("ownsNavigationStack: false"))
        #expect(rootSource.contains("@State private var sidebarNavigationPath: [SettingsRoute] = []"))
        #expect(rootSource.contains("NavigationStack(path: self.$sidebarNavigationPath)"))
        #expect(rootSource.contains("self.sidebarNavigationPath.removeAll()"))
        #expect(rootSource.matches(of: /SettingsProTab\(\s*initialRoute: self\.selectedSettingsRoute,/).count == 1)
        #expect(rootSource.contains(".id(self.settingsTabViewID)"))
        #expect(rootSource.contains("@State private var selectedSettingsRouteRequestID: Int = 0"))
        #expect(rootSource.contains("self.selectedSettingsRouteRequestID &+= 1"))
        #expect(rootSource.contains("@State private var suppressedExecApprovalPromptIDForNotificationSettings"))
        #expect(rootSource.contains("private var activeExecApprovalPromptSuppressionID: String?"))
        #expect(rootSource.contains("suppressedApprovalID: self.activeExecApprovalPromptSuppressionID"))
        #expect(rootSource.contains("if destination.settingsRoute != .notifications"))
        #expect(rootSource.contains("if route != .notifications"))
        #expect(rootSource.contains("if route == nil"))
        #expect(rootSource.contains("self.selectedSettingsRoute = nil"))
        #expect(rootSource.contains("self.selectedSidebarDestination = .settings"))
        #expect(rootSource.contains("self.suppressedExecApprovalPromptIDForNotificationSettings = approvalId"))
        #expect(rootSource.contains("onRouteChange: handleSettingsRouteChange"))
        #expect(rootSource.contains("navigateToRoute: pushSidebarSettingsRoute"))
        #expect(rootSource.contains("private func pushSidebarSettingsRoute(_ route: SettingsRoute)"))
        #expect(rootSource.contains("self.sidebarNavigationPath.append(route)"))
        #expect(settingsTabSource.contains("let navigateToRoute: ((SettingsRoute) -> Void)?"))
        #expect(settingsTabSource.contains("navigateToRoute(.notifications)"))
        // Cross-route settings shortcuts push so Back returns to the origin
        // screen; replacing the path resets Back to the Settings root.
        #expect(settingsTabSource.contains("self.navigationPath.append(.notifications)"))
        #expect(!settingsTabSource.contains("self.navigationPath = [.notifications]"))
        #expect(rootSource.contains("private func handleSettingsRouteChange(_ route: SettingsRoute?)"))
        #expect(settingsTabSource.contains("let onRouteChange: ((SettingsRoute?) -> Void)?"))
        #expect(settingsTabSource.contains("self.onRouteChange?(self.navigationPath.last)"))
        #expect(notificationGuidanceSource.contains("onSuppressFuture"))
        #expect(notificationGuidanceSource.contains("suppressFuture: true"))
        #expect(notificationGuidanceSource.contains("Text(\"Don't show again\")"))
        #expect(rootSource.contains("private func selectSettingsRoute(_ route: SettingsRoute)"))
        #expect(settingsSource.contains("title: \"Channels\""))
        #expect(settingsSource.contains("route: .channels"))
        #expect(docsSource.contains(".accessibilityHint(\"Opens Settings / Gateway\")"))
    }

    @Test func `push enrollment stays behind notification disclosure flow`() throws {
        let appSource = try String(contentsOf: Self.openClawAppSourceURL(), encoding: .utf8)
        let actionsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let modelSource = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)

        #expect(appSource.contains("PushEnrollmentConsent.disclosureAccepted"))
        #expect(appSource.contains("NotificationServingPreference.isEnabled()"))
        #expect(appSource.contains("await Self.isNotificationAuthorizationAllowed()"))
        #expect(actionsSource.contains("PushEnrollmentConsent.markDisclosureAccepted()"))
        #expect(actionsSource.contains("self.registerForRemoteNotificationsIfEnrollmentReady()"))
        #expect(modelSource.contains("PushEnrollmentConsent.disclosureAccepted"))
        #expect(modelSource.contains("notifications_not_authorized"))
        #expect(modelSource.contains("enrollment_disclosure_not_accepted"))
    }

    @Test func `notification preference lives in privacy and keeps system authority separate`() throws {
        let sectionsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let actionsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let settingsList = try Self.extract(
            sectionsSource,
            from: "@ViewBuilder var settingsListSection: some View",
            to: "func settingsListRow(")
        let privacyDestination = try Self.extract(
            sectionsSource,
            from: "var privacyDestination: some View",
            to: "var notificationsDestination: some View")

        #expect(!settingsList.contains("route: .notifications"))
        #expect(privacyDestination.contains("self.notificationsSection"))
        #expect(sectionsSource.contains("Toggle(\"Notifications\", isOn: self.notificationToggleBinding)"))
        #expect(actionsSource.contains("UIApplication.shared.unregisterForRemoteNotifications()"))
        #expect(actionsSource.contains("UIApplication.openNotificationSettingsURLString"))
        #expect(!actionsSource.contains("UIApplication.openSettingsURLString"))
    }

    @Test func `gateway settings keeps pairing trust diagnostics and tailscale actions`() throws {
        let settingsSource = try String(contentsOf: Self.settingsProTabSourceURL(), encoding: .utf8)
        let sectionsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let actionsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let trustSource = try String(contentsOf: Self.gatewayTrustPromptAlertSourceURL(), encoding: .utf8)
        let onboardingSource = try String(contentsOf: Self.onboardingWizardSourceURL(), encoding: .utf8)
        let controllerSource = try String(contentsOf: Self.gatewayConnectionControllerSourceURL(), encoding: .utf8)
        let modelSource = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let scannerSource = try String(contentsOf: Self.qrScannerSourceURL(), encoding: .utf8)
        let settingsScannerSheet = try Self.extract(
            settingsSource,
            from: "isPresented: self.$showQRScanner,",
            to: ".sheet(isPresented: self.$showNotificationRelayDisclosure)")
        let settingsOnDismiss = try #require(settingsScannerSheet.range(of: "onDismiss: {"))
        let settingsProcessing = try #require(settingsScannerSheet.range(of: "self.processQueuedScannerResult()"))
        let settingsContent = try #require(settingsScannerSheet.range(of: "content: {"))
        let settingsPendingSetupHandler = try Self.extract(
            actionsSource,
            from: "func applyGatewaySetupLink(_ link: GatewayConnectDeepLink)",
            to: "@discardableResult\n    func applySetupCode(attemptID: UUID)")
        let settingsScannerCancel = try #require(
            settingsPendingSetupHandler.range(of: "self.scannerResultHandoff.cancel()"))
        let settingsSetupStaging = try #require(
            settingsPendingSetupHandler.range(of: "self.stagedGatewaySetupLink = link"))
        let scannerMake = try Self.extract(
            scannerSource,
            from: "func makeUIViewController",
            to: "func updateUIViewController")
        let scannerLifecycle = try Self.extract(
            scannerSource,
            from: "final class QRScannerContainerViewController",
            to: "final class Coordinator")
        let scannerDelivery = try Self.extract(
            scannerSource,
            from: "private func deliver(_ result: QRScannerResult",
            to: "func dataScanner(_: DataScannerViewController, didRemove")
        let stopScanning = try #require(scannerDelivery.range(of: "scanner.stopScanning()"))
        let deliverResult = try #require(scannerDelivery.range(of: "self.parent.onResult(result)"))
        #expect(scannerSource.contains("static let defaultSettlingNanoseconds: UInt64 = 1_200_000_000"))
        #expect(scannerSource.contains("QRScannerContainerViewController(coordinator: context.coordinator)"))
        #expect(!scannerMake.contains("startScanning()"))
        #expect(scannerLifecycle.contains("override func viewDidAppear"))
        #expect(scannerLifecycle.contains("try self.scanner.startScanning()"))
        #expect(scannerLifecycle.contains("override func viewWillDisappear"))
        #expect(scannerLifecycle.contains("self.stopScannerCapture()"))
        let activeProblemToast = try Self.extract(
            rootSource,
            from: "private var activeGatewayProblemToast: GatewayConnectionProblem?",
            to: "private var gatewayToastAnimation: Animation?")
        let gatewaySetupSource = try Self.extract(
            rootSource,
            from: "private func maybeOpenSettingsForGatewaySetup()",
            to: "private func maybeRequestLocalNetworkAccess")
        let consumedGatewaySetup = try #require(
            gatewaySetupSource.range(of: "appModel.consumePendingGatewaySetupLink()"))
        let onboardingSetupOwnerGuard = try #require(
            gatewaySetupSource.range(of: "guard !self.showOnboarding else { return }"))
        let deliveredGatewaySetup = try #require(
            gatewaySetupSource.range(of: "self.gatewaySetupRequest = GatewaySetupRequest"))
        let pendingSetupHandler = try Self.extract(
            onboardingSource,
            from: "private func applyPendingGatewaySetupLinkIfNeeded()",
            to: "private func connectStagedGatewaySetupLink()")
        let stagedSetupConnect = try Self.extract(
            onboardingSource,
            from: "private func connectStagedGatewaySetupLink()",
            to: "private func clearStagedGatewaySetupLink()")
        let stagedSetupClear = try Self.extract(
            onboardingSource,
            from: "private func clearStagedGatewaySetupLink()",
            to: "private func applyGatewayLink(")
        let connectionFailure = try Self.extract(
            onboardingSource,
            from: "private func setConnectionFailure(_ message: String)",
            to: "var body: some View")
        let stagedValidation = try #require(stagedSetupConnect.range(of: "guard link.isValidEndpoint"))
        let stagedConsumption = try #require(stagedSetupConnect.range(of: "self.setupLinkStaging.take()"))
        let stagedReset = try #require(
            stagedSetupConnect.range(of: "await self.appModel.resetGatewaySessionsForTargetSwitch()"))
        let backgroundReconnect = try Self.extract(
            modelSource,
            from: "private func performBackgroundAliveBeaconIfNeeded(",
            to: "private func publishBackgroundAliveBeacon(")
        let disconnectGateway = try Self.extract(
            modelSource,
            from: "func disconnectGateway()",
            to: "private func disableGatewayAutoReconnect()")
        let operatorGatewayLoop = try Self.extract(
            modelSource,
            from: "private func startOperatorGatewayLoop(",
            to: "private func startNodeGatewayLoop(")
        let nodeGatewayLoop = try Self.extract(
            modelSource,
            from: "private func startNodeGatewayLoop(",
            to: "private func makeOperatorConnectOptions(")
        let wakeWordRefresh = try Self.extract(
            modelSource,
            from: "private func refreshWakeWordsFromGateway(",
            to: "private func isGatewayHealthMonitorDisabled()")
        let onboardingGatewayLink = try Self.extract(
            onboardingSource,
            from: "private func applyGatewayLink(",
            to: "private func handleScannedSetupCode(")
        let settingsGatewayLink = try Self.extract(
            actionsSource,
            from: "func applyGatewayLink(",
            to: "func openGatewayQRScanner()")
        let onboardingManualConnect = try Self.extract(
            onboardingSource,
            from: "private func connectCurrentManualGateway(",
            to: "private func retryLastAttempt(")
        let onboardingRetry = try Self.extract(
            onboardingSource,
            from: "private func retryLastAttempt(",
            to: "private func gatewayProblemPrimaryActionTitle(")
        let settingsManualConnect = try Self.extract(
            actionsSource,
            from: "func connectManual(setupAttemptID: UUID? = nil) async",
            to: "func preflightGateway(host: String)")

        #expect(sectionsSource.contains("var gatewayDestination: some View"))
        #expect(sectionsSource.contains("self.gatewayActions"))
        #expect(sectionsSource.contains("self.manualGatewayCard"))
        #expect(sectionsSource.contains("self.gatewaySetupCard"))
        #expect(sectionsSource.contains("self.discoveredGatewaysCard"))
        #expect(sectionsSource.contains("self.gatewayAdvancedCard"))
        #expect(sectionsSource.contains("title: \"Reconnect\""))
        #expect(sectionsSource.contains("Task { await self.reconnectGateway() }"))
        #expect(sectionsSource.contains("title: \"Diagnose\""))
        #expect(sectionsSource.contains("Task { await self.runDiagnostics() }"))
        #expect(sectionsSource.contains("title: \"Scan QR\""))
        #expect(sectionsSource.contains("self.openGatewayQRScanner()"))
        #expect(sectionsSource.contains("title: \"Connect\""))
        #expect(sectionsSource.contains("Task { await self.applySetupCodeAndConnect() }"))
        #expect(sectionsSource.contains("Task { await self.connect(gateway) }"))
        #expect(sectionsSource.contains("tailnetWarningText"))
        // Gateway problems surface once, as the root toast; the settings page must not
        // embed a second copy of the banner.
        #expect(!sectionsSource.contains("GatewayProblemBanner("))
        #expect(rootSource.contains("GatewayProblemBanner("))
        #expect(rootSource.contains(".gesture(self.gatewayToastSwipeGesture)"))
        // Operator auth/pairing problems can coexist with a connected node, so the
        // root's only remediation surface must not depend on aggregate status.
        #expect(activeProblemToast.contains("appModel.lastGatewayProblem"))
        #expect(!activeProblemToast.contains("gatewayStatus"))
        // Every problem report re-surfaces a swiped-away toast or shakes the
        // visible one; value equality alone must not keep the toast hidden.
        #expect(rootSource.contains("self.appModel.gatewayProblemReportCount"))
        #expect(rootSource.contains("GatewayToastShakeEffect"))

        #expect(actionsSource.contains("await self.gatewayController.connectActiveGateway()"))
        #expect(actionsSource.contains("self.gatewayController.refreshActiveGatewayRegistrationFromSettings()"))
        #expect(actionsSource.contains("self.gatewayController.restartDiscovery()"))
        #expect(actionsSource.contains("await self.appModel.refreshGatewayOverviewIfConnected()"))
        #expect(actionsSource
            .contains("self.gatewayController.requestLocalNetworkAccess(reason: \"settings_preflight\")"))
        #expect(controllerSource.contains("await self.tcpReachabilityProbe("))
        #expect(controllerSource.contains("Check Tailscale or LAN."))
        #expect(actionsSource.contains("Tailscale is off on this device. Turn it on, then try again."))
        #expect(actionsSource.contains("Run /pair approve in your OpenClaw chat"))
        #expect(settingsSource.contains("self.resetOnboarding()"))
        #expect(settingsSource.contains(".onChange(of: self.onboardingRequestID)"))
        #expect(settingsSource.contains("self.syncAfterOnboardingReset()"))
        #expect(settingsSource.contains("let acceptsGatewaySetupRequests: Bool"))
        #expect(settingsSource.contains("guard self.acceptsGatewaySetupRequests else { return }"))
        #expect(settingsSource.contains(".onChange(of: self.acceptsGatewaySetupRequests)"))
        #expect(rootSource.matches(of: /acceptsGatewaySetupRequests: !self\.showOnboarding/).count == 2)
        #expect(actionsSource.contains("func syncAfterOnboardingReset()"))
        #expect(actionsSource.contains("self.pendingManualAuthOverride = nil"))
        // The root toast is the only gateway problem surface outside covers, so it
        // must keep the reset-onboarding primary action the settings banner had.
        #expect(rootSource.contains("resetTitle: \"Reset onboarding\""))
        #expect(rootSource.contains("GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: instanceId)"))
        #expect(rootSource.contains("self.gatewayController.trustRotatedGatewayCertificate(from: problem)"))
        #expect(rootSource.contains("GatewayProblemPrimaryAction.handleProtocolMismatchIfNeeded(problem)"))
        #expect(rootSource.contains("await self.gatewayController.connectActiveGateway()"))

        #expect(rootSource.contains("GatewayProblemDetailsSheet("))
        #expect(onboardingSetupOwnerGuard.lowerBound < consumedGatewaySetup.lowerBound)
        #expect(consumedGatewaySetup.lowerBound < deliveredGatewaySetup.lowerBound)
        #expect(settingsSource.contains("QRScannerView("))
        #expect(settingsOnDismiss.lowerBound < settingsProcessing.lowerBound)
        #expect(settingsProcessing.lowerBound < settingsContent.lowerBound)
        #expect(settingsPendingSetupHandler.contains("self.showQRScanner = false"))
        #expect(settingsScannerCancel.lowerBound < settingsSetupStaging.lowerBound)
        #expect(settingsPendingSetupHandler.contains(
            "self.gatewayController.cancelPendingConnectionAttempts()"))
        #expect(!settingsSource.contains(".onChange(of: self.showQRScanner)"))
        #expect(actionsSource.contains("case let .gatewayLink(link):"))
        #expect(actionsSource.contains("case let .setupCode(code):"))
        #expect(stopScanning.lowerBound < deliverResult.lowerBound)
        #expect(trustSource.contains("Trust this gateway?"))
        #expect(trustSource.contains("Trust and connect"))
        #expect(trustSource.contains("let isEnabled: Bool"))
        #expect(rootSource.contains(".gatewayTrustPromptAlert(isEnabled: !self.showOnboarding)"))
        #expect(onboardingSource.contains(".gatewayTrustPromptAlert()"))
        #expect(onboardingSource.contains("self.applyPendingGatewaySetupLinkIfNeeded()"))
        #expect(onboardingSource.contains(".onChange(of: self.appModel.gatewaySetupRequestID)"))
        #expect(onboardingSource.contains("self.appModel.consumePendingGatewaySetupLink()"))
        #expect(onboardingSource.contains("self.scannerResultHandoff.cancel()"))
        #expect(!onboardingSource.contains("pendingScannerResult"))
        #expect(onboardingSource.contains("self.setupLinkStaging.stage(link)"))
        #expect(pendingSetupHandler.contains("self.gatewayController.cancelPendingConnectionAttempts()"))
        #expect(pendingSetupHandler.contains("if self.selectedMode == nil"))
        #expect(onboardingSource.contains("Tap Connect to apply."))
        #expect(onboardingSource.contains("self.connectStagedGatewaySetupLink()"))
        #expect(onboardingSource.contains("Credentials are applied only after you tap Connect."))
        #expect(onboardingSource.contains("Plaintext (local network)"))
        #expect(onboardingSource.contains("self.statusLine = message"))
        #expect(!pendingSetupHandler.contains("self.manualHost ="))
        #expect(!pendingSetupHandler.contains("self.manualPort ="))
        #expect(!pendingSetupHandler.contains("self.manualTLS ="))
        #expect(!pendingSetupHandler.contains("self.applyGatewayLink(link)"))
        #expect(!pendingSetupHandler.contains("self.handleScannedLink(link)"))
        #expect(!pendingSetupHandler.contains("self.connectManual()"))
        #expect(stagedValidation.lowerBound < stagedConsumption.lowerBound)
        #expect(stagedReset.lowerBound < stagedConsumption.lowerBound)
        #expect(!stagedSetupConnect.contains("self.appModel.disconnectGateway()"))
        #expect(stagedSetupConnect.contains(
            "self.applyGatewayLink(link, disconnectExistingGatewayForBootstrap: false)"))
        #expect(stagedSetupConnect.contains("guard self.connectingGatewayID == nil else { return }"))
        #expect(stagedSetupConnect.contains("self.setConnectionFailure(message)"))
        #expect(connectionFailure.contains("self.localConnectionFailure = message"))
        #expect(!connectionFailure.contains("self.connectMessage = message"))
        #expect(connectionFailure.contains("self.statusLine = message"))
        #expect(onboardingSource.contains(".failedStatus(message: message, allowsRetry: false)"))
        #expect(onboardingSource.contains("primaryActionTitle: allowsRetry ? \"Retry\" : nil"))
        #expect(onboardingSource.contains("onPrimaryAction: onRetry"))
        #expect(stagedSetupClear.contains("self.localConnectionFailure = nil"))
        #expect(onboardingRetry.contains("self.localConnectionFailure = nil"))
        #expect(onboardingRetry.contains(
            "self.setConnectionFailure(\"No connection to retry. Check the gateway host and port.\")"))
        #expect(onboardingSource.contains("self.setupLinkStaging.link == nil else { return }"))
        #expect(onboardingGatewayLink.contains("self.gatewayToken = setupAuth.token"))
        #expect(onboardingGatewayLink.contains("self.gatewayPassword = setupAuth.password"))
        #expect(settingsGatewayLink.contains("self.gatewayToken = setupAuth.token"))
        #expect(settingsGatewayLink.contains("self.gatewayPassword = setupAuth.password"))
        #expect(onboardingManualConnect.contains("nodeOptions.allowStoredDeviceAuth == true"))
        #expect(onboardingManualConnect.contains("self.pendingManualAuthOverride = nil"))
        #expect(onboardingManualConnect.contains("targetStableID: stableID"))
        #expect(settingsManualConnect.contains("nodeOptions.allowStoredDeviceAuth == true"))
        #expect(settingsManualConnect.contains("self.pendingManualAuthOverride = nil"))
        #expect(settingsManualConnect.contains("targetStableID: stableID"))
        #expect(!controllerSource.contains("shouldApplyTokenField"))
        #expect(!controllerSource.contains("shouldApplyPasswordField"))
        #expect(controllerSource.contains("allowStoredDeviceAuth: !suppressStoredDeviceAuth"))
        #expect(controllerSource.contains(
            "deviceAuthGatewayID: GatewaySettingsStore.authenticationOwnerID("))
        #expect(controllerSource.contains("DeviceAuthStore.migrateUnscopedToken("))
        #expect(controllerSource.contains("DeviceAuthStore.discardUnscopedTokens("))
        #expect(onboardingSource.contains(
            "self.selectGatewayCredentialTarget(gateway.stableID, allowManualOverride: false)"))
        #expect(actionsSource.contains(
            "self.selectGatewayCredentialTarget(gateway.stableID, allowManualOverride: false)"))
        #expect(onboardingSource.contains(
            "self.gatewayCredentialFieldStableID ?? self.currentManualGatewayStableID"))
        #expect(actionsSource.contains(
            "self.gatewayCredentialFieldStableID ?? self.currentManualGatewayStableID"))
        #expect(disconnectGateway.contains("self.beginGatewaySessionReset(chainingAfterExisting: true)"))
        #expect(!disconnectGateway.contains("Task {"))
        #expect(modelSource.contains(
            "private func isCurrentGatewayRoute(generation: UInt64, stableID: String) -> Bool"))
        #expect(modelSource.matches(
            of: /self\.isCurrentGatewayRoute\(generation: routeGeneration, stableID: stableID\)/).count >= 2)
        #expect(operatorGatewayLoop.contains("gatewayReconnectLoopDelay(source: \"operator_loop\")"))
        #expect(nodeGatewayLoop.contains("gatewayReconnectLoopDelay(source: \"node_loop\")"))
        #expect(modelSource.contains("refreshWakeWordsFromGateway(shouldApply: shouldContinue)"))
        #expect(wakeWordRefresh.matches(of: /guard shouldApply\(\) else \{ return \}/).count >= 2)
        #expect(modelSource.contains("if !self.gatewayAutoReconnectEnabled || self.gatewayPairingPaused"))
        #expect(controllerSource.contains("acceptPendingTrustPrompt()"))
        #expect(controllerSource.contains("trustRotatedGatewayCertificate(from problem: GatewayConnectionProblem)"))
        #expect(controllerSource.contains("allowAutoReconnect: false"))
        #expect(controllerSource.contains("guard allowAutoReconnect else { return }"))
        #expect(controllerSource.contains("guard self.autoConnectSuppressionGeneration == nil else { return }"))
        #expect(backgroundReconnect.contains("let generation = self.gatewayConnectGeneration"))
        #expect(backgroundReconnect.contains("await self.resetGatewaySessionsForForcedReconnect()"))
        #expect(backgroundReconnect.contains("expectedGeneration: generation"))
        #expect(modelSource.contains("expectedGeneration: UInt64)"))
        #expect(!modelSource.contains("expectedGeneration: UInt64?"))
    }

    @Test func `gateway credential fields update before endpoint persistence is available`() throws {
        let onboardingSource = try String(contentsOf: Self.onboardingWizardSourceURL(), encoding: .utf8)
        let settingsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        for source in [onboardingSource, settingsSource] {
            let tokenSetter = try Self.extract(
                source,
                from: "func persistGatewayToken(_ value: String)",
                to: "func persistGatewayPassword(_ value: String)")
            let passwordSetter = try Self.extract(
                source,
                from: "func persistGatewayPassword(_ value: String)",
                to: "func clearManualCredentialFields()")
            let tokenAssignment = try #require(tokenSetter.range(of: "self.gatewayToken = value"))
            let tokenEndpointGuard = try #require(
                tokenSetter.range(of: "let stableID = self.gatewayCredentialTargetStableID"))
            let passwordAssignment = try #require(passwordSetter.range(of: "self.gatewayPassword = value"))
            let passwordEndpointGuard = try #require(
                passwordSetter.range(of: "let stableID = self.gatewayCredentialTargetStableID"))

            #expect(tokenAssignment.lowerBound < tokenEndpointGuard.lowerBound)
            #expect(passwordAssignment.lowerBound < passwordEndpointGuard.lowerBound)
        }
    }

    @Test func `onboarding mode defaults clear credentials after endpoint changes`() throws {
        let source = try String(contentsOf: Self.onboardingWizardSourceURL(), encoding: .utf8)
        let modeDefaults = try Self.extract(
            source,
            from: "private func applyModeDefaults(_ mode: OnboardingConnectionMode)",
            to: "private func gatewayHasResolvableHost")

        #expect(modeDefaults.contains("let previousStableID = self.currentManualGatewayStableID"))
        #expect(modeDefaults.contains("previousStableID != self.currentManualGatewayStableID"))
        #expect(modeDefaults.contains("self.clearManualCredentialFields()"))
    }

    @Test func `watch snapshot bundle applies owner before approvals and clears old chat`() throws {
        let receiverSource = try String(contentsOf: Self.watchConnectivityReceiverSourceURL(), encoding: .utf8)
        let storeSource = try String(contentsOf: Self.watchInboxStoreSourceURL(), encoding: .utf8)
        let consumePayload = try Self.extract(
            receiverSource,
            from: "private func consumeIncomingPayload(_ payload: [String: Any], transport: String)",
            to: "}\n}")
        let appSnapshotConsume = try #require(
            consumePayload.range(of: "self.store.consume(appSnapshot: appSnapshot)"))
        let approvalSnapshotConsume = try #require(
            consumePayload.range(of: "self.store.consume(execApprovalSnapshot: execApprovalSnapshot"))
        let consumeAppSnapshot = try Self.extract(
            storeSource,
            from: "func consume(appSnapshot message: WatchAppSnapshotMessage)",
            to: "func markAppSnapshotRequestStarted()")

        #expect(appSnapshotConsume.lowerBound < approvalSnapshotConsume.lowerBound)
        #expect(consumeAppSnapshot.contains("if hasExistingAppSnapshot, previousGatewayID == nextGatewayID"))
        let ownerMatchedMerge = try Self.extract(
            consumeAppSnapshot,
            from: "if hasExistingAppSnapshot, previousGatewayID == nextGatewayID",
            to: "self.appSnapshot = merged")
        #expect(ownerMatchedMerge.contains("merged.chatItems = self.appSnapshot?.chatItems"))
        #expect(ownerMatchedMerge.contains("merged.chatStatusText = self.appSnapshot?.chatStatusText"))
    }

    @Test func `watch generic prompts wait for the active gateway owner`() throws {
        let receiverSource = try String(contentsOf: Self.watchConnectivityReceiverSourceURL(), encoding: .utf8)
        let source = try String(contentsOf: Self.watchInboxStoreSourceURL(), encoding: .utf8)
        let consumeMessage = try Self.extract(
            source,
            from: "func consume(message: WatchNotifyMessage, transport: String)",
            to: "func consume(\n        execApprovalPrompt")
        let consumeAppSnapshot = try Self.extract(
            source,
            from: "func consume(appSnapshot message: WatchAppSnapshotMessage)",
            to: "func markAppSnapshotRequestStarted()")

        let replay = try Self.extract(
            source,
            from: "func replayDeferredGatewayPayloads()",
            to: "private func clearMessagePrompt()")
        let routeGatewayPayload = try Self.extract(
            source,
            from: "private func routeGatewayPayload(_ payload: DeferredGatewayPayload)",
            to: "private func acceptsGatewayOwner")
        let acceptsGatewayOwner = try Self.extract(
            source,
            from: "private func acceptsGatewayOwner(_ gatewayStableID: String?)",
            to: "func replayDeferredGatewayPayloads()")

        #expect(consumeMessage.contains("self.routeGatewayPayload(.notification"))
        #expect(consumeAppSnapshot.contains("self.clearMessagePrompt()"))
        #expect(consumeAppSnapshot.contains("if !hasExistingAppSnapshot || previousGatewayID != nextGatewayID"))
        #expect(source.contains("private var deferredGatewayPayloads: [DeferredGatewayPayload]"))
        #expect(routeGatewayPayload.contains("guard let activeSnapshot = appSnapshot else { return true }"))
        #expect(acceptsGatewayOwner.contains("guard let activeSnapshot = appSnapshot else { return true }"))
        #expect(acceptsGatewayOwner.contains("else { return false }"))
        #expect(replay.contains("WatchDeferredPayloadOrdering.indicesOldestFirst"))
        #expect(replay.contains("WatchDeferredPayloadOrdering.isExpired"))
        #expect(replay.contains("WatchDeferredPayloadOrdering.isNewerThanSnapshot"))
        #expect(replay.contains("WatchDeferredPayloadOrdering.isAtOrBeforeSnapshot"))
        #expect(replay.contains("case let .notification(message, transport):"))
        #expect(replay.contains("approvalSnapshotGatewayID == activeGatewayID"))
        #expect(replay.contains("payload.isFullyRepresentedByExecApprovalSnapshot"))
        #expect(replay.contains("let approval = payload.approvalPrompt"))
        #expect(source.contains("if hasSameSnapshotOwner"))
        #expect(source.contains("if let sentAtMs = message.sentAtMs"))
        #expect(receiverSource.contains("self.store.replayDeferredGatewayPayloads()"))
    }

    @Test func `watch approval notifications include their gateway owner`() throws {
        let source = try String(contentsOf: Self.watchInboxStoreSourceURL(), encoding: .utf8)
        let identifier = try Self.extract(
            source,
            from: "private static func execApprovalNotificationIdentifier(",
            to: "private func pruneExpiredExecApprovals")
        let routeChange = try Self.extract(
            source,
            from: "func consume(appSnapshot message: WatchAppSnapshotMessage)",
            to: "func markAppSnapshotRequestStarted()")

        #expect(identifier.contains("gatewayStableID.utf8.count"))
        #expect(identifier.contains("gatewayStableID)\\(approvalID)"))
        #expect(routeChange.contains("removeExecApprovalNotifications(approvals: invalidatedApprovals)"))
        #expect(!source.contains("identifier: \"watch.execApproval.\\(message.approval.id)\""))
        #expect(source.contains("let ownerlessApprovals = state.execApprovals.filter"))
        #expect(source.contains("self.lastExecApprovalSnapshotID = nil"))
        #expect(source.contains("\"watch.execApproval.\\(approvalID)\""))
    }

    @Test func `setup route probes yield to newer manual actions`() throws {
        let onboardingSource = try String(contentsOf: Self.onboardingWizardSourceURL(), encoding: .utf8)
        let actionsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let sectionsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)

        let welcomeStep = try Self.extract(
            onboardingSource,
            from: "private var welcomeStep: some View",
            to: "@ViewBuilder\n    private var modeStep")
        #expect(welcomeStep.contains("self.openQRScannerFromOnboarding()"))
        #expect(welcomeStep.contains("self.invalidateSetupAttempt()"))

        let onboardingManualConnect = try Self.extract(
            onboardingSource,
            from: "private func connectManual(setupAttemptID: UUID? = nil) async",
            to: "private func connectCurrentManualGateway")
        #expect(onboardingManualConnect.contains("guard self.setupAttemptID == setupAttemptID else { return }"))
        #expect(onboardingManualConnect.contains("self.invalidateSetupAttempt()"))
        #expect(onboardingSource.contains("await self.connectManual(setupAttemptID: attemptID)"))

        let settingsManualConnect = try Self.extract(
            actionsSource,
            from: "func connectManual(setupAttemptID: UUID? = nil) async",
            to: "func preflightGateway")
        #expect(settingsManualConnect.contains("guard self.setupAttemptID == setupAttemptID else { return }"))
        #expect(settingsManualConnect.contains("self.invalidateGatewaySetupAttempt()"))
        #expect(actionsSource.contains("await self.connectManual(setupAttemptID: attemptID)"))
        #expect(sectionsSource.contains(".disabled(self.setupAttemptID != nil)"))
    }

    @Test func `local network access is requested from visible gateway flows`() throws {
        let appSource = try String(contentsOf: Self.openClawAppSourceURL(), encoding: .utf8)
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let onboardingSource = try String(contentsOf: Self.onboardingWizardSourceURL(), encoding: .utf8)
        let actionsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let controllerSource = try String(contentsOf: Self.gatewayConnectionControllerSourceURL(), encoding: .utf8)
        let onboardingScannerSheet = try Self.extract(
            onboardingSource,
            from: "isPresented: self.$showQRScanner,",
            to: ".sheet(isPresented: self.$showGatewayProblemDetails)")
        let onboardingOnDismiss = try #require(onboardingScannerSheet.range(of: "onDismiss: {"))
        let onboardingProcessing = try #require(onboardingScannerSheet.range(of: "self.processQueuedScannerResult()"))
        let onboardingContent = try #require(onboardingScannerSheet.range(of: "content: {"))

        #expect(appSource.contains("deferDiscoveryUntilLocalNetworkRequest: true"))
        #expect(appSource.contains("func application(\n        _ app: UIApplication,\n        open url: URL,"))
        #expect(appSource.contains("self.pendingOpenURLs.append(url)"))
        #expect(appSource.contains("model.stageGatewaySetupLink(link)"))
        #expect(appSource.contains(".onOpenURL"))
        #expect(appSource.contains("self.appDelegate.handleOpenURL(url, model: self.appModel)"))
        #expect(controllerSource.contains(
            "func requestLocalNetworkAccess(reason: String, allowAutoReconnect: Bool = true)"))
        #expect(controllerSource.contains("guard self.localNetworkAccessRequested else"))
        #expect(controllerSource.contains(
            "self.requestLocalNetworkAccess(reason: \"connect_manual\", allowAutoReconnect: false)"))
        #expect(controllerSource.contains(
            "self.requestLocalNetworkAccess(reason: \"connect_discovered_gateway\", allowAutoReconnect: false)"))
        #expect(controllerSource.contains(
            "self.requestLocalNetworkAccess(reason: \"connect_last_known\", allowAutoReconnect: false)"))

        #expect(rootSource.contains("self.maybeRequestLocalNetworkAccess(reason: \"root_appear\")"))
        #expect(rootSource.contains("self.maybeRequestLocalNetworkAccess(reason: \"scene_active\")"))
        #expect(rootSource.contains("self.maybeRequestLocalNetworkAccess(reason: \"onboarding_dismissed\")"))
        #expect(rootSource.contains("self.requestLocalNetworkAccess(reason: \"gateway_setup_deeplink\")"))
        #expect(rootSource.contains("guard self.didEvaluateOnboarding else { return }"))
        #expect(rootSource.contains("onRequestLocalNetworkAccess: { reason in"))

        #expect(onboardingSource.contains("self.requestLocalNetworkAccess(reason: \"onboarding_continue\")"))
        #expect(onboardingSource.contains("self.requestLocalNetworkAccessIfPastIntro(reason: \"onboarding_appear\")"))
        #expect(onboardingSource.contains(
            "self.applyPendingGatewaySetupLinkIfNeeded()\n                self.attemptAutomaticPairingResumeIfNeeded()"))
        #expect(onboardingOnDismiss.lowerBound < onboardingProcessing.lowerBound)
        #expect(onboardingProcessing.lowerBound < onboardingContent.lowerBound)
        #expect(!onboardingSource.contains(".onChange(of: self.showQRScanner)"))
        #expect(onboardingSource.matches(of: /self\.showQRScanner = true/).count == 1)
        #expect(actionsSource
            .contains("self.gatewayController.requestLocalNetworkAccess(reason: \"settings_preflight\")"))
    }

    @Test func `gateway settings preview matrix covers primary states`() throws {
        let supportSource = try String(contentsOf: Self.settingsProTabSupportSourceURL(), encoding: .utf8)

        #expect(supportSource.contains("#Preview(\"Gateway settings states\")"))
        #expect(supportSource.contains("private struct SettingsGatewayStatesPreview"))
        #expect(supportSource.contains("self.stateSection(\"Connected\")"))
        #expect(supportSource.contains("self.stateSection(\"Loading\")"))
        #expect(supportSource.contains("self.stateSection(\"Empty\")"))
        #expect(supportSource.contains("self.stateSection(\"Error\")"))
        #expect(supportSource.contains("Tailscale is off on this device. Turn it on, then try again."))
        #expect(supportSource.contains("self.previewButton(\"Scan QR\""))
        #expect(supportSource.contains("self.previewButton(\"Connect\""))
        #expect(supportSource.contains("self.previewButton(\"Reconnect\""))
        #expect(supportSource.contains("self.previewButton(\"Diagnose\""))
    }

    @Test func `native chat uses gateway transport`() throws {
        let chatSource = try String(contentsOf: Self.chatProTabSourceURL(), encoding: .utf8)
        let channelsSource = try String(contentsOf: Self.channelsSourceURL(), encoding: .utf8)
        let appModelSource = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let transportSource = try String(contentsOf: Self.iOSGatewayChatTransportSourceURL(), encoding: .utf8)

        #expect(chatSource.contains(
            "self.appModel.makeChatTransport(outboxGatewayID: offlineStore?.gatewayID)"))
        #expect(chatSource.contains("activeAgentId: self.appModel.chatDeliveryAgentId"))
        #expect(chatSource.contains("Self.requiresViewModelRebuild("))
        #expect(chatSource.contains("viewModel.syncSessionRoutingContract"))
        #expect(appModelSource.contains("return IOSGatewayChatTransport("))
        #expect(appModelSource.contains("globalAgentId: self.chatDeliveryAgentId"))
        #expect(appModelSource.contains("ifCurrentRoute: operatorRoute"))
        #expect(transportSource.matches(of: /ifCurrentRoute: expectedRoute/).count == 3)
        #expect(channelsSource.contains("\"clickclack\": SettingsChannelFallbackMetadata"))
        #expect(channelsSource.contains("label: \"ClickClack\""))
        #expect(channelsSource.contains("Self-hosted chat bot routing."))
    }

    @Test func `deferred gateway mutations retain their source gateway`() throws {
        let source = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let pendingActions = try Self.extract(
            source,
            from: "private func resumePendingForegroundNodeActionsIfNeeded(",
            to: "private func handleWatchQuickReply(")
        let resolvedState = try Self.extract(
            source,
            from: "private func handleExecApprovalResolvedForCurrentGateway(",
            to: "func handleExecApprovalResolvedRemotePush(")
        let resolvedPushes = try Self.extract(
            source,
            from: "func handleExecApprovalResolvedRemotePush(",
            to: "func handleSilentPushWake(")

        #expect(pendingActions.contains("ifCurrentRoute: nodeRoute"))
        #expect(pendingActions.contains("ifCurrentRoute: expectedRoute"))
        #expect(pendingActions.contains("isCurrentGatewaySessionRoute"))
        #expect(pendingActions.contains("pendingForegroundActionDrainRequested = true"))
        #expect(pendingActions.contains("trigger: \"coalesced\""))
        #expect(pendingActions.contains("pendingForegroundActionDrainInFlight = false"))
        #expect(pendingActions.contains("completedPendingForegroundActionIDsByGateway"))
        #expect(pendingActions.contains("presentIn: decoded.actions"))
        #expect(pendingActions.contains("let currentRoute = await self.nodeGateway.currentRoute()"))
        #expect(pendingActions.contains("ifCurrentRoute: expectedRoute"))
        #expect(resolvedState.matches(of: /canApplyExecApprovalResolvedState/).count >= 4)
        #expect(resolvedState.contains("routeContext: routeContext"))
        #expect(resolvedPushes.contains("applyValidatedExecApprovalResolvedPush(push, context: context)"))
        #expect(resolvedPushes.contains("session: self.operatorGateway"))
        #expect(resolvedPushes.contains("generation: context.routeGeneration"))
    }

    private static func rootTabsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootTabs.swift")
    }

    private static func nodeAppModelSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Model/NodeAppModel.swift")
    }

    private static func iOSGatewayChatTransportSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Chat/IOSGatewayChatTransport.swift")
    }

    private static func phoneHubSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/RootTabsPhoneControlHub.swift")
    }

    private static func proComponentsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/OpenClawProComponents.swift")
    }

    private static func commandCenterSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/CommandCenterTab.swift")
    }

    private static func commandCenterSupportSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/CommandCenterSupport.swift")
    }

    private static func agentProTabSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProTab.swift")
    }

    private static func agentProTabOverviewSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProTab+Overview.swift")
    }

    private static func agentProTabDestinationsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProTab+Destinations.swift")
    }

    private static func agentProNodesDestinationSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProNodesDestination.swift")
    }

    private static func agentProDreamingDestinationSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/AgentProDreamingDestination.swift")
    }

    private static func rootTabsNavigationSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootTabsNavigation.swift")
    }

    private static func iPadSidebarFeatureScreensSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadSidebarFeatureScreens.swift")
    }

    private static func iPadTaskFeatureScreensSource() throws -> String {
        try [
            self.iPadWorkboardScreenSourceURL(),
            self.iPadSkillWorkshopScreenSourceURL(),
            self.iPadSidebarFeatureScreensSourceURL(),
        ]
            .map { try String(contentsOf: $0, encoding: .utf8) }
            .joined(separator: "\n")
    }

    private static func iPadWorkboardScreenSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadWorkboardScreen.swift")
    }

    private static func iPadSkillWorkshopScreenSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadSkillWorkshopScreen.swift")
    }

    private static func iPadSidebarFeaturePreviewsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadSidebarFeaturePreviews.swift")
    }

    private static func iPadActivityScreenSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadActivityScreen.swift")
    }

    private static func iPadSidebarScreenChromeSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/IPadSidebarScreenChrome.swift")
    }

    private static func chatProTabSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/ChatProTab.swift")
    }

    private static func talkProTabSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/TalkProTab.swift")
    }

    private static func docsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/OpenClawDocsScreen.swift")
    }

    private static func settingsProTabSectionsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsProTabSections.swift")
    }

    private static func settingsProTabSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsProTab.swift")
    }

    private static func onboardingWizardSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Onboarding/OnboardingWizardView.swift")
    }

    private static func qrScannerSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Onboarding/QRScannerView.swift")
    }

    private static func openClawAppSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/OpenClawApp.swift")
    }

    private static func notificationPermissionGuidanceDialogSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Gateway/NotificationPermissionGuidanceDialog.swift")
    }

    private static func settingsProTabActionsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsProTabActions.swift")
    }

    private static func settingsProTabSupportSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsProTabSupport.swift")
    }

    private static func gatewayTrustPromptAlertSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Gateway/GatewayTrustPromptAlert.swift")
    }

    private static func gatewayConnectionControllerSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Gateway/GatewayConnectionController.swift")
    }

    private static func watchConnectivityReceiverSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WatchApp/Sources/WatchConnectivityReceiver.swift")
    }

    private static func watchInboxStoreSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WatchApp/Sources/WatchInboxStore.swift")
    }

    private static func channelsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsChannelsDestination.swift")
    }

    private static func sharedChatPreviewSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("shared/OpenClawKit/Sources/OpenClawChatUI/ChatView+Previews.swift")
    }

    private static func xcodeProjectSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("OpenClaw.xcodeproj/project.pbxproj")
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
