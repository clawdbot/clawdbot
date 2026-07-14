import Foundation
import Testing

struct RootTabsSourceGuardTests {
    @Test func `app applies initial scene phase before gateway admission`() throws {
        let source = try String(contentsOf: Self.openClawAppSourceURL(), encoding: .utf8)
        let startupTask = try Self.extract(
            source,
            from: ".task {",
            to: ".onReceive(")
        let modelPhase = try #require(startupTask.range(of: "self.appModel.setScenePhase(self.scenePhase)"))
        let gatewayPhase = try #require(
            startupTask.range(of: "self.gatewayController.setScenePhase(self.scenePhase)"))

        #expect(source.contains("NodeAppModel(audioAdmissionInitiallyAllowed: false)"))
        #expect(modelPhase.lowerBound < gatewayPhase.lowerBound)
        #expect(startupTask.contains("self.appDelegate.scenePhaseChanged(self.scenePhase)"))
    }

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
        #expect(source.contains("accessibilityLabel: .localized(\"Hide Sidebar\")"))
        #expect(source.contains("accessibilityLabel: .localized(\"Show Sidebar\")"))
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
        #expect(agentOverviewSource.contains("title: .localized(self.headerTitle)"))
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
        #expect(gatewayStatus.contains("OpenClawStatusBadge(label: .verbatim(self.title), tone: self.tone)"))
        #expect(!gatewayStatus.contains("ProCapsule("))
        #expect(!gatewayStatus.contains("Capsule()"))
        #expect(agentDestinationsSource.contains("List {"))
        #expect(agentDestinationsSource.contains(".searchable(text: self.$agentSearchText"))
        #expect(
            agentFilterMenu.contains("Picker(selection: self.$agentRosterFilter)")
                && agentFilterMenu.contains("Text(\"Agent status\")"))
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
        let supportSource = try String(contentsOf: Self.settingsProTabSupportSourceURL(), encoding: .utf8)
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
        #expect(aboutDestination.contains("SettingsBuildMetadataStrip(metadata: DeviceInfoHelper.buildMetadata())"))
        #expect(!aboutDestination.contains("SettingsDetailRow(\"OpenClaw app version\""))
        #expect(aboutDestination.contains(
            "SettingsDetailRow(\"Device\", value: .verbatim(DeviceInfoHelper.deviceFamily()))"))
        #expect(aboutDestination.contains(
            "value: .verbatim(DeviceInfoHelper.iOSVersionStringForDisplay()))"))
        #expect(!aboutDestination.contains("SettingsDetailRow(\"Version\""))
        #expect(!aboutDestination.contains("SettingsDetailRow(\"Platform\""))
        #expect(!aboutDestination.contains("SettingsDetailRow(\"Model\""))
        #expect(supportSource.contains("title: \"Version\""))
        #expect(supportSource.contains("title: \"Commit\""))
        #expect(supportSource.contains("title: \"Built\""))
        #expect(supportSource.contains("ViewThatFits(in: .horizontal)"))
        #expect(supportSource.contains("Text(\"Unavailable\")"))
        #expect(supportSource.contains(".textCase(.uppercase)"))
        #expect(diagnosticsDestination.contains(
            "SettingsDetailRow(\"Device\", value: .verbatim(DeviceInfoHelper.deviceFamily()))"))
        #expect(diagnosticsDestination.contains(
            "value: .verbatim(DeviceInfoHelper.platformStringForDisplay()))"))
        #expect(diagnosticsDestination.contains(
            "SettingsDetailRow(\"Model\", value: .verbatim(DeviceInfoHelper.modelIdentifier()))"))
    }

    @Test func `settings exposes guarded installed and ClawHub skill management`() throws {
        let settingsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let skillsSource = try String(contentsOf: Self.settingsSkillsSourceURL(), encoding: .utf8)

        #expect(settingsSource.contains("title: \"Skills\""))
        #expect(settingsSource.contains("route: .skills"))
        #expect(skillsSource.contains("case installed"))
        #expect(skillsSource.contains("case browse"))
        #expect(skillsSource.contains("case setup"))
        #expect(skillsSource.contains("case off"))
        #expect(skillsSource.contains("method: \"skills.status\""))
        #expect(skillsSource.contains("method: \"skills.search\""))
        #expect(skillsSource.contains("method: \"skills.detail\""))
        #expect(skillsSource.contains("method: \"skills.install\""))
        #expect(skillsSource.contains("method: \"skills.update\""))
        #expect(skillsSource.contains(".disabled(!self.warningExpanded || self.isInstalling)"))
        #expect(skillsSource.contains("SkillManagementContract.installed"))
        #expect(skillsSource.contains("ifCurrentRoute: route"))
        #expect(skillsSource.contains("distinguishPreDispatchRouteChange: true"))
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

    @Test func `phone hub promotes chat and talk while filtering root tabs from its destination list`() throws {
        let source = try String(contentsOf: Self.phoneHubSourceURL(), encoding: .utf8)

        #expect(source.contains("private var gatewayHeader: some View"))
        #expect(source.contains("private var gatewayIdentityTitle: some View"))
        #expect(source.contains("Text(verbatim: gatewayDisplayLabel)"))
        #expect(source.contains("Text(\"Gateway\")"))
        #expect(source.contains(".accessibilityLabel(self.gatewayAccessibilityLabel)"))
        #expect(source.contains("private var chatTalkRow: some View"))
        #expect(source.contains(
            ".listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))"))
        #expect(source.contains("self.prominentDestinationCard(\n                .chat,"))
        #expect(source.contains("self.prominentDestinationCard(\n                .talk,"))
        #expect(source.contains("private var phoneDestinations: [RootTabs.SidebarDestination]"))
        #expect(source.contains("self.groups.flatMap(\\.destinations).filter { !self.opensRootTab($0) }"))
        #expect(source.contains("private struct ControlCircleIcon: View"))
        #expect(source.contains(".foregroundStyle(self.iconForegroundStyle)"))
        #expect(!source.contains("ProValuePill(value: self.gatewayStateText"))
        #expect(!source.contains("destination.subtitle"))
        #expect(source.contains("self.openGatewayDetail()"))
        #expect(!source.contains("self.openPhoneRootDestination(.gateway)"))
        #expect(!source.contains("phoneDetailBackAction"))
        #expect(!source.contains(".navigationBarBackButtonHidden(true)"))
        #expect(!source.contains(".toolbar(.hidden, for: .navigationBar)"))
        #expect(source.matches(of: /usesNativeNavigationChrome: true/).count == 7)
        #expect(!source.contains("directRoute: .agents"))
        #expect(source.contains("Image(systemName: \"slider.horizontal.3\")"))
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
}

extension RootTabsSourceGuardTests {
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
        #expect(source.contains(
            "self.createUnavailableMessage ?? String(localized: \"Creates a workboard card\"))"))
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
        let dispatchPattern =
            /method: "workboard\.cards\.dispatch"[\s\S]*?IPadWorkboardListParams\(boardId: selectedBoardParam\)/

        #expect(source.contains("private var boardScopeMenu: some View"))
        #expect(source.contains("method: \"workboard.boards.list\""))
        #expect(source.contains("IPadWorkboardListParams(boardId: selectedBoardParam)"))
        #expect(source.contains("boardId: selectedBoardParam"))
        #expect(source.matches(of: dispatchPattern).count == 1)
        #expect(source.contains("private var agentScopeMenu: some View"))
        #expect(source.contains("IPadSkillProposalListParams(agentId: selectedAgentParam)"))
        #expect(source.contains("agentId: selectedAgentParam"))
        #expect(!source
            .contains(
                "params: EmptyParams(),\n                timeoutSeconds: 20)\n"
                    + "            let response = try JSONDecoder().decode(IPadSkillProposalManifest.self"))
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
        let settingsRoutePattern = try Regex(
            #"case \.settings:[\s\S]*?SettingsProTab\("#
                + #"[\s\S]*?headerLeadingAction: self\.sidebarHeaderLeadingAction,"#
                + #"[\s\S]*?ownsNavigationStack: false"#
                + #"[\s\S]*?onRouteChange: handleSettingsRouteChange"#)
        let approvalSuppression = try Self.extract(
            rootSource,
            from: "private var activeExecApprovalPromptSuppression: NodeAppModel.ExecApprovalInboxKey?",
            to: "private var shouldCollapseSidebarAfterSelection: Bool")
        let sidebarNavigationShell = try Self.extract(
            rootSource,
            from: "private var sidebarDetailNavigationShell: some View",
            to: "private var usesSidebarTabs: Bool")
        let settingsRoutePropagation = try Self.extract(
            rootSource,
            from: "private func handleSettingsRouteChange(_ route: SettingsRoute?)",
            to: "private func showSidebar()")
        let approvalNotificationsRoute = try Self.extract(
            settingsTabSource,
            from: "func openNotificationsRouteFromApprovals()",
            to: "private func applyInitialRouteIfNeeded()")
        let suppressionCapture = try #require(
            approvalNotificationsRoute.range(of: "self.onApprovalNotificationsRoute?(approvalID)"))
        let externalNavigation = try #require(
            approvalNotificationsRoute.range(of: "navigateToRoute(.notifications)"))
        let ownedNavigation = try #require(
            approvalNotificationsRoute.range(of: "self.navigationPath.append(.notifications)"))

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
        #expect(rootSource.matches(of: settingsRoutePattern).count >= 1)
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
        #expect(rootSource.contains("@State private var activeSettingsRoute: SettingsRoute?"))
        #expect(rootSource.contains("self.selectedSettingsRouteRequestID &+= 1"))
        #expect(rootSource.contains("@State private var suppressedExecApprovalForNotificationSettings"))
        #expect(rootSource.contains(
            "private var activeExecApprovalPromptSuppression: NodeAppModel.ExecApprovalInboxKey?"))
        #expect(rootSource.contains("suppressedApproval: self.activeExecApprovalPromptSuppression"))
        #expect(approvalSuppression.contains("case .approvals:"))
        #expect(approvalSuppression.contains("switch self.activeSettingsRoute"))
        #expect(approvalSuppression.contains(
            "NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt)"))
        #expect(sidebarNavigationShell.contains(".onChange(of: self.sidebarNavigationPath)"))
        #expect(sidebarNavigationShell.contains("self.handleSidebarSettingsNavigationPathChange(navigationPath)"))
        #expect(settingsRoutePropagation.contains("self.activeSettingsRoute = route"))
        #expect(settingsRoutePropagation.contains("navigationPath: navigationPath"))
        #expect(settingsRoutePropagation.contains("baseRoute: baseRoute"))
        #expect(rootSource.contains("if destination.settingsRoute != .notifications"))
        #expect(rootSource.contains("if route != .notifications"))
        #expect(rootSource.contains("if route == nil"))
        #expect(rootSource.contains("self.selectedSettingsRoute = nil"))
        #expect(rootSource.contains("self.selectedSidebarDestination = .settings"))
        #expect(rootSource.contains(
            "self.suppressedExecApprovalForNotificationSettings = NodeAppModel.execApprovalInboxKey(prompt)"))
        #expect(rootSource.contains(
            "onApprovalNotificationsRoute: self.suppressExecApprovalPromptForNotificationSettings"))
        #expect(rootSource.contains("private func suppressExecApprovalPromptForNotificationSettings("))
        #expect(rootSource.contains("onRouteChange: handleSettingsRouteChange"))
        #expect(rootSource.contains("navigateToRoute: pushSidebarSettingsRoute"))
        #expect(rootSource.contains("private func pushSidebarSettingsRoute(_ route: SettingsRoute)"))
        #expect(rootSource.contains("self.sidebarNavigationPath.append(route)"))
        #expect(settingsTabSource.contains("let navigateToRoute: ((SettingsRoute) -> Void)?"))
        #expect(settingsTabSource.contains("let onApprovalNotificationsRoute: ((String) -> Void)?"))
        #expect(suppressionCapture.lowerBound < externalNavigation.lowerBound)
        #expect(suppressionCapture.lowerBound < ownedNavigation.lowerBound)
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
        let locationCard = try Self.extract(
            sectionsSource,
            from: "var locationModeCard: some View",
            to: "var agentSelectionCard: some View")
        let pendingLocationApplication = try Self.extract(
            actionsSource,
            from: "func applyPendingLocationModeIfAvailable()",
            to: "func openLocationSettings()")

        #expect(!settingsList.contains("route: .notifications"))
        #expect(privacyDestination.contains("self.notificationsSection"))
        #expect(privacyDestination.contains("title: \"Camera Access\""))
        #expect(privacyDestination.contains("self.locationModeCard"))
        #expect(privacyDestination.contains("title: \"Background Listening\""))
        #expect(!privacyDestination.contains("title: \"Privacy\""))
        #expect(
            sectionsSource.contains("Toggle(isOn: self.notificationToggleBinding)")
                && sectionsSource.contains("Text(\"Notifications\")"))
        #expect(locationCard.contains("Text(\"Location\")"))
        #expect(locationCard.contains(".font(OpenClawType.body)"))
        #expect(locationCard.contains(".accessibilityLabel(\"Location Sharing\")"))
        #expect(!locationCard.contains("Text(\"Location Sharing\")"))
        #expect(!locationCard.contains("SettingsIcon("))
        #expect(locationCard.contains("Text(\"Access Level\")"))
        #expect(!locationCard.contains("Text(\"Open iOS Settings\")"))
        #expect(locationCard.contains(".opacity(self.isChangingLocationMode ? 0 : 1)"))
        #expect(locationCard.contains(".multilineTextAlignment(.trailing)"))
        #expect(locationCard.contains(".lineLimit(2)"))
        #expect(locationCard.contains(".accessibilityElement(children: .ignore)"))
        #expect(locationCard.contains(".accessibilityLabel(\"Access Level\")"))
        #expect(!locationCard.contains(".minimumScaleFactor("))
        #expect(locationCard.contains("showLocationAccessDialog"))
        #expect(locationCard.contains("chevron.up.chevron.down"))
        #expect(locationCard.contains("Chooses While Using the App or Always"))
        #expect(!locationCard.contains("Picker(\"Location\""))
        #expect(!locationCard.contains("Text(\"While Using\")"))
        #expect(!locationCard.contains("Choose a location mode"))
        #expect(!actionsSource.contains("Location permission was not granted."))
        #expect(!actionsSource.contains("presentation.showsOpenSettingsAction"))
        #expect(actionsSource.contains("func selectLocationAccessLevel"))
        #expect(actionsSource.contains("presentation.accessLevelAction(mode: mode)"))
        #expect(actionsSource.contains("self.pendingLocationMode ?? self.selectedLocationMode"))
        #expect(pendingLocationApplication.contains(
            "self.locationSettingsPresentation(selectedMode: mode).statusText"))
        let pendingClear = try #require(pendingLocationApplication.range(of: "self.pendingLocationMode = nil"))
        let unavailableReturn = try #require(
            pendingLocationApplication.range(of: "guard summary.effectiveMode != .off else"))
        #expect(pendingClear.lowerBound < unavailableReturn.lowerBound)
        #expect(actionsSource.contains("UIApplication.shared.unregisterForRemoteNotifications()"))
        #expect(actionsSource.contains("UIApplication.openNotificationSettingsURLString"))
        #expect(actionsSource.contains("UIApplication.openSettingsURLString"))
    }

    @Test func `gateway settings keeps pairing trust diagnostics and tailscale actions`() throws {
        try Self.assertGatewaySettingsSurfaceGuards()
        try Self.assertGatewayOnboardingFlowGuards()
        try Self.assertGatewayReconnectGuards()
    }

    @Test func `discovered gateway surfaces share secure connection availability`() throws {
        let controllerSource = try String(
            contentsOf: Self.gatewayConnectionControllerSourceURL(),
            encoding: .utf8)
        let settingsSource = try String(
            contentsOf: Self.settingsProTabSectionsSourceURL(),
            encoding: .utf8)
        let quickSetupSource = try String(
            contentsOf: Self.gatewayQuickSetupSourceURL(),
            encoding: .utf8)
        let onboardingSource = try Self.onboardingWizardSource()
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)

        #expect(controllerSource.contains("enum DiscoveredGatewayConnectionAvailability"))
        #expect(controllerSource.contains("gateway.tlsEnabled || GatewayTLSStore.loadFingerprint"))
        #expect(controllerSource.contains("enter your Tailscale Serve HTTPS host in Manual Setup"))
        #expect(settingsSource.contains("discoveredGatewayConnectionAvailability(gateway)"))
        #expect(quickSetupSource.contains("discoveredGatewayConnectionAvailability(candidate)"))
        #expect(quickSetupSource.contains("Text(\"Use Manual Setup\")"))
        #expect(quickSetupSource.contains("self.gatewayController.preferredDiscoveredGateway()"))
        #expect(onboardingSource.contains("discoveredGatewayConnectionAvailability(gateway)"))
        #expect(!onboardingSource.contains("gatewayHasResolvableHost"))
        #expect(rootSource.contains("GatewayQuickSetupSheet(onUseManualSetup:"))
        #expect(rootSource.contains("self.selectSettingsRoute(.gateway)"))
    }

    @Test func `gateway credential fields update before endpoint persistence is available`() throws {
        let onboardingSource = try Self.onboardingWizardSource()
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
        let source = try Self.onboardingWizardSource()
        let modeDefaults = try Self.extract(
            source,
            from: "private func applyModeDefaults(_ mode: OnboardingConnectionMode)",
            to: "private func connectManual")

        #expect(modeDefaults.contains("let previousStableID = self.currentManualGatewayStableID"))
        #expect(modeDefaults.contains("GatewayStableIdentifier.key(previousStableID) !="))
        #expect(modeDefaults.contains("GatewayStableIdentifier.key(self.currentManualGatewayStableID)"))
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
        let matchingOwnerGuard = "if hasExistingAppSnapshot, Self.gatewayIDsMatch(previousGatewayID, nextGatewayID)"
        #expect(consumeAppSnapshot.contains(matchingOwnerGuard))
        let ownerMatchedMerge = try Self.extract(
            consumeAppSnapshot,
            from: matchingOwnerGuard,
            to: "self.appSnapshot = merged")
        #expect(ownerMatchedMerge.contains("merged.chatItems = self.appSnapshot?.chatItems"))
        #expect(ownerMatchedMerge.contains("merged.chatStatus = self.appSnapshot?.chatStatus"))
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
        #expect(consumeAppSnapshot.contains(
            "if !hasExistingAppSnapshot || !Self.gatewayIDsMatch(previousGatewayID, nextGatewayID)"))
        #expect(source.contains("private var deferredGatewayPayloads: [DeferredGatewayPayload]"))
        #expect(routeGatewayPayload.contains("guard let activeSnapshot = appSnapshot else { return true }"))
        #expect(acceptsGatewayOwner.contains("guard let activeSnapshot = appSnapshot else { return true }"))
        #expect(acceptsGatewayOwner.contains("else { return false }"))
        #expect(replay.contains("WatchDeferredPayloadOrdering.indicesOldestFirst"))
        #expect(replay.contains("WatchDeferredPayloadOrdering.isExpired"))
        #expect(replay.contains("WatchDeferredPayloadOrdering.isNewerThanSnapshot"))
        #expect(replay.contains("WatchDeferredPayloadOrdering.isAtOrBeforeSnapshot"))
        #expect(replay.contains("case let .notification(message, transport):"))
        #expect(replay.contains("approvalSnapshotGatewayID,\n                    activeGatewayID"))
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
        #expect(identifier.contains("approvalKey.notificationComponent"))
        #expect(routeChange.contains("removeExecApprovalNotifications(approvals: invalidatedApprovals)"))
        #expect(!source.contains("identifier: \"watch.execApproval.\\(message.approval.id)\""))
        #expect(source.contains("let ownerlessApprovals = validApprovals.filter"))
        #expect(source.contains("self.lastExecApprovalSnapshotID = nil"))
        #expect(source.contains("approvalKey.notificationComponent"))
    }

    @Test func `watch terminal approvals cannot be resurrected by delayed deliveries`() throws {
        let source = try String(contentsOf: Self.watchInboxStoreSourceURL(), encoding: .utf8)
        let promptConsume = try Self.extract(
            source,
            from: "func consume(\n        execApprovalPrompt",
            to: "func consume(\n        execApprovalSnapshot")
        let snapshotConsume = try Self.extract(
            source,
            from: "func consume(\n        execApprovalSnapshot",
            to: "func consume(appSnapshot")
        let terminalConsumes = try Self.extract(
            source,
            from: "func consume(execApprovalResolved",
            to: "func selectExecApproval")
        let terminalHelpers = try Self.extract(
            source,
            from: "private static func execApprovalOwnerKey(",
            to: "private func pruneExpiredExecApprovals")
        let restore = try Self.extract(
            source,
            from: "private func restorePersistedState()",
            to: "private func persistState()")
        let merge = try Self.extract(
            source,
            from: "private func mergedExecApprovalRecord(",
            to: "private func removeExecApproval")
        let upsert = try Self.extract(
            source,
            from: "private func upsertExecApproval(",
            to: "private func mergedExecApprovalRecord(")

        #expect(promptConsume.contains("!self.isExecApprovalTerminal("))
        #expect(promptConsume.contains("expiresAtMs <= nowMs"))
        #expect(promptConsume.contains("self.isExecApprovalPromptSupersededBySnapshot(message)"))
        let promptPrune = try #require(promptConsume.range(of: "self.pruneExpiredExecApprovals(nowMs: nowMs)"))
        let promptExpiry = try #require(promptConsume.range(of: "expiresAtMs <= nowMs"))
        #expect(promptPrune.lowerBound < promptExpiry.lowerBound)
        #expect(snapshotConsume.contains("!self.isExecApprovalTerminal("))
        #expect(snapshotConsume.contains("Self.snapshotCanReplace("))
        #expect(snapshotConsume.contains("recordKey.gatewayID == WatchGatewayID.key(snapshotGatewayID)"))
        #expect(snapshotConsume.contains(
            "Self.gatewayIDsMatch(approval.gatewayStableID, snapshotGatewayID)"))
        #expect(snapshotConsume.contains("WatchExecApprovalOutcome(code: .resolvedElsewhere)"))
        #expect(snapshotConsume.contains("authoritativeOutcome: false"))
        #expect(terminalConsumes.components(separatedBy: "self.recordExecApprovalTerminal(").count == 3)
        #expect(terminalConsumes.contains("func terminalExecApprovalOutcomeText("))
        #expect(terminalHelpers.contains("WatchApprovalID.key(tombstone.approvalId) == key.approvalID"))
        #expect(terminalHelpers.contains("WatchGatewayID.key(tombstone.gatewayStableID) == key.gatewayID"))
        #expect(terminalHelpers.contains("maxExecApprovalTerminalTombstones"))
        #expect(terminalHelpers.contains("upgraded.recordedAt = Date()"))
        #expect(source.contains("execApprovalTerminalTombstoneLifetime: TimeInterval"))
        #expect(source.contains("execApprovalTerminalTombstones: [ExecApprovalTerminalTombstone]?"))
        // WatchExecApprovalRecord's transport timestamp lives in WatchInboxMessages.swift
        // since the watch message/model types were split out of WatchInboxStore.swift.
        let messagesSource = try String(
            contentsOf: Self.watchInboxMessagesSourceURL(),
            encoding: .utf8)
        #expect(messagesSource.contains("var sourceSentAtMs: Int64?"))
        #expect(source.contains("var outcomeIsAuthoritative: Bool?"))
        #expect(source.contains("guard let recordSentAtMs = record.sourceSentAtMs else { return true }"))
        #expect(restore.contains("state.execApprovalTerminalTombstones ?? []"))
        #expect(restore.contains("self.isExecApprovalTerminal("))

        // An explicit pending readback can clear an uncertain accepted or queued send.
        #expect(upsert.contains("guard Self.snapshotCanReplace("))
        #expect(upsert.contains("WatchOpaqueUTF8Key(resetResolutionAttemptID)"))
        #expect(upsert.contains("WatchOpaqueUTF8Key(activeResolutionAttemptID)"))
        #expect(merge.contains("let isResolving = resetResolvingState ? false"))
        #expect(merge.contains("let pendingDecision = resetResolvingState ? nil"))
        #expect(merge.contains("let activeResolutionAttemptID = resetResolvingState ? nil"))
        #expect(!source.contains("appliedResetDeliveryIDs"))
    }

    @Test func `setup route probes yield to newer manual actions`() throws {
        let onboardingSource = try Self.onboardingWizardSource()
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
        let onboardingSource = try Self.onboardingWizardSource()
        let actionsSource = try String(contentsOf: Self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let controllerSource = try Self.gatewayConnectionControllerSource()
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
            "self.requestLocalNetworkAccess(reason: \"connect_active_gateway\", allowAutoReconnect: false)"))

        #expect(rootSource.contains("self.maybeRequestLocalNetworkAccess(reason: \"root_appear\")"))
        #expect(rootSource.contains("self.maybeRequestLocalNetworkAccess(reason: \"scene_active\")"))
        #expect(rootSource.contains("self.maybeRequestLocalNetworkAccess(reason: \"onboarding_dismissed\")"))
        #expect(rootSource.contains("self.requestLocalNetworkAccess(reason: \"gateway_setup_deeplink\")"))
        #expect(rootSource.contains("guard self.didEvaluateOnboarding else { return }"))
        #expect(rootSource.contains("onRequestLocalNetworkAccess: { reason in"))

        #expect(onboardingSource.contains("self.requestLocalNetworkAccess(reason: \"onboarding_continue\")"))
        #expect(onboardingSource.contains("self.requestLocalNetworkAccessIfPastIntro(reason: \"onboarding_appear\")"))
        #expect(onboardingSource.contains(
            "self.applyPendingGatewaySetupLinkIfNeeded()\n"
                + "                self.attemptAutomaticPairingResumeIfNeeded()"))
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
}

extension RootTabsSourceGuardTests {
    @Test func `approval fetch revalidates captured operator route before interpreting response`() throws {
        let source = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let routeAdmission = try Self.extract(
            source,
            from: "private func isCurrentGatewaySessionRoute(",
            to: "private func ackPendingForegroundNodeAction(")
        let unified = try Self.extract(
            source,
            from: "private func fetchExecApprovalPrompt(",
            to: "private static func decodeUnifiedExecApprovalGet(")
        let legacy = try Self.extract(
            source,
            from: "private func fetchLegacyExecApprovalPrompt(",
            to: "func dismissPendingExecApprovalPrompt()")
        let unifiedSuccess = try Self.extract(
            unified,
            from: "let response = try await operatorGateway.request(",
            to: "} catch is CancellationError")
        let legacySuccess = try Self.extract(
            legacy,
            from: "let response = try await self.operatorGateway.request(",
            to: "} catch is CancellationError")
        let unifiedCatch = try #require(unified.range(of: "} catch {"))
        let legacyCatch = try #require(legacy.range(of: "} catch {"))
        let unifiedError = String(unified[unifiedCatch.lowerBound...])
        let legacyError = String(legacy[legacyCatch.lowerBound...])
        let unifiedAdmission = try #require(unifiedSuccess.range(of: "isCurrentGatewaySessionRoute"))
        let unifiedDecode = try #require(unifiedSuccess.range(of: "decodeUnifiedExecApprovalGet"))
        let unifiedErrorAdmission = try #require(unifiedError.range(of: "isCurrentGatewaySessionRoute"))
        let unifiedStale = try #require(unifiedError.range(of: "isApprovalNotificationStaleError"))
        let legacyAdmission = try #require(legacySuccess.range(of: "isCurrentGatewaySessionRoute"))
        let legacyDecode = try #require(legacySuccess.range(of: "JSONDecoder().decode"))
        let legacyErrorAdmission = try #require(legacyError.range(of: "isCurrentGatewaySessionRoute"))
        let legacyStale = try #require(legacyError.range(of: "isApprovalNotificationStaleError"))

        #expect(routeAdmission.contains("await session.currentRoute() == context.route"))
        #expect(unifiedSuccess.contains("guard await self.isCurrentGatewaySessionRoute("))
        #expect(unifiedSuccess.contains("session: self.operatorGateway"))
        #expect(unifiedAdmission.lowerBound < unifiedDecode.lowerBound)
        #expect(unifiedErrorAdmission.lowerBound < unifiedStale.lowerBound)
        #expect(legacySuccess.contains("guard await self.isCurrentGatewaySessionRoute("))
        #expect(legacySuccess.contains("session: self.operatorGateway"))
        #expect(legacyAdmission.lowerBound < legacyDecode.lowerBound)
        #expect(legacyErrorAdmission.lowerBound < legacyStale.lowerBound)
    }

    @Test func `approval resolve revalidates captured operator route before classifying replies`() throws {
        let source = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let unified = try Self.extract(
            source,
            from: "private func resolveExecApprovalNotificationDecision(",
            to: "private func execApprovalRPCFamily(")
        let legacy = try Self.extract(
            source,
            from: "private func resolveLegacyExecApproval(",
            to: "private func reconcileUnknownExecApprovalResolution(")
        let unifiedSuccess = try Self.extract(
            unified,
            from: "let response = try await self.operatorGateway.request(",
            to: "} catch {")
        let legacySuccess = try Self.extract(
            legacy,
            from: "let response = try await self.operatorGateway.request(",
            to: "} catch {")
        let unifiedCatch = try #require(unified.range(of: "} catch {"))
        let legacyCatch = try #require(legacy.range(of: "} catch {"))
        let unifiedError = String(unified[unifiedCatch.lowerBound...])
        let legacyError = String(legacy[legacyCatch.lowerBound...])

        let unifiedAdmission = try #require(unifiedSuccess.range(of: "isCurrentGatewaySessionRoute"))
        let unifiedSettled = try #require(unifiedSuccess.range(of: "markExecApprovalResolutionWriteSettled"))
        let unifiedDecode = try #require(unifiedSuccess.range(of: "JSONDecoder().decode"))
        let unifiedErrorAdmission = try #require(unifiedError.range(of: "isCurrentGatewaySessionRoute"))
        let unifiedErrorReconcile = try #require(unifiedError.range(of: "reconcileUnknownExecApprovalResolution"))
        let legacyAdmission = try #require(legacySuccess.range(of: "isCurrentGatewaySessionRoute"))
        let legacySettled = try #require(legacySuccess.range(of: "markExecApprovalResolutionWriteSettled"))
        let legacyDecode = try #require(legacySuccess.range(of: "JSONDecoder().decode"))
        let legacyErrorAdmission = try #require(legacyError.range(of: "isCurrentGatewaySessionRoute"))
        let legacyAlreadyResolved = try #require(legacyError.range(of: "isApprovalAlreadyResolvedError"))

        #expect(unified.contains("ifCurrentRoute: context.route"))
        #expect(unified.contains("distinguishPreDispatchRouteChange: true"))
        #expect(unifiedSuccess.contains("return .uncertain("))
        #expect(unifiedError.contains("case .routeChangedBeforeDispatch"))
        #expect(unifiedError.contains("return .uncertain("))
        #expect(unifiedAdmission.lowerBound < unifiedSettled.lowerBound)
        #expect(unifiedSettled.lowerBound < unifiedDecode.lowerBound)
        #expect(unifiedErrorAdmission.lowerBound < unifiedErrorReconcile.lowerBound)
        #expect(legacy.contains("ifCurrentRoute: context.route"))
        #expect(legacy.contains("distinguishPreDispatchRouteChange: true"))
        #expect(legacySuccess.contains("return .uncertain("))
        #expect(legacyError.contains("case .routeChangedBeforeDispatch"))
        #expect(legacyError.contains("return .uncertain("))
        #expect(legacyAdmission.lowerBound < legacySettled.lowerBound)
        #expect(legacySettled.lowerBound < legacyDecode.lowerBound)
        #expect(legacyErrorAdmission.lowerBound < legacyAlreadyResolved.lowerBound)
    }

    @Test func `phone approval write lease survives pending reconciliation`() throws {
        let source = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let resolution = try Self.extract(
            source,
            from: "func resolvePendingExecApprovalPrompt(decision: String) async",
            to: "private func resolveExecApprovalNotificationDecision(")
        let presentation = try Self.extract(
            source,
            from: "private func presentFetchedExecApprovalPrompt(",
            to: "private static func makeExecApprovalPrompt(")
        let begin = try #require(resolution.range(of: "beginExecApprovalResolutionAttempt"))
        let request = try #require(resolution.range(of: "await resolveExecApprovalNotificationDecision"))

        #expect(begin.lowerBound < request.lowerBound)
        #expect(resolution.contains("defer { self.finishExecApprovalResolutionAttempt(resolutionAttempt) }"))
        #expect(resolution.contains("guard self.isActiveExecApprovalResolutionAttempt(resolutionAttempt)"))
        #expect(presentation.contains("let preserveActiveResolution"))
        // Re-presenting while the write fence is held must render as resolving.
        #expect(presentation.contains("} else if preserveActiveResolution {"))
        #expect(presentation.contains("self.pendingExecApprovalPromptResolving = true"))
    }

    @Test func `uncertain approval remains dismissible on modal and settings surfaces`() throws {
        let modelSource = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let dialogSource = try String(contentsOf: Self.execApprovalPromptDialogSourceURL(), encoding: .utf8)
        let settingsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let approvals = try Self.extract(
            settingsSource,
            from: "var approvalsReviewCard: some View",
            to: "private var approvalOutcomeColor: Color")

        #expect(modelSource.contains("var pendingExecApprovalPromptCanDismiss: Bool"))
        #expect(modelSource.contains(
            "!self.pendingExecApprovalPromptResolving || self.pendingExecApprovalPromptErrorText != nil"))
        #expect(dialogSource.contains("canDismiss: self.appModel.pendingExecApprovalPromptCanDismiss"))
        #expect(dialogSource.contains(".disabled(!self.canDismiss)"))
        #expect(approvals.contains("self.appModel.pendingExecApprovalPromptResolving,"))
        #expect(approvals.contains("self.appModel.pendingExecApprovalPromptCanDismiss"))
        #expect(approvals.contains("self.appModel.dismissPendingExecApprovalPrompt()"))
    }

    @Test func `approval inbox stays reopenable and modal isolates accessibility`() throws {
        let rootSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let modelSource = try String(contentsOf: Self.nodeAppModelSourceURL(), encoding: .utf8)
        let dialogSource = try String(contentsOf: Self.execApprovalPromptDialogSourceURL(), encoding: .utf8)
        let settingsSource = try String(contentsOf: Self.settingsProTabSectionsSourceURL(), encoding: .utf8)

        #expect(rootSource.contains(".badge(self.appModel.pendingExecApprovalCount)"))
        #expect(modelSource.contains("var pendingExecApprovalInboxItems: [ExecApprovalInboxItem]"))
        #expect(modelSource.contains("self.dismissedExecApprovalPresentationKeys.insert(inboxKey)"))
        #expect(modelSource.contains("func presentPendingExecApprovalFromInbox("))
        #expect(settingsSource.contains("ForEach(self.appModel.pendingExecApprovalInboxItems)"))
        #expect(settingsSource.contains("self.appModel.presentPendingExecApprovalFromInbox(item.id)"))
        #expect(settingsSource.contains("Label(\"Allow Once\""))
        #expect(settingsSource.contains("Label(\"Allow Always\""))
        #expect(dialogSource.contains(".accessibilityHidden(prompt != nil)"))
        #expect(dialogSource.contains(".accessibilityAddTraits(.isModal)"))
        #expect(dialogSource.contains(".accessibilityFocused(self.$approvalCardFocused)"))
    }

    static func rootTabsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootTabs.swift")
    }

    static func nodeAppModelSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Model/NodeAppModel.swift")
    }

    private static func execApprovalPromptDialogSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Gateway/ExecApprovalPromptDialog.swift")
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

    static func settingsProTabSectionsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsProTabSections.swift")
    }

    static func settingsProTabSourceURL() -> URL {
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

    private static func gatewayQuickSetupSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Gateway/GatewayQuickSetupSheet.swift")
    }

    static func onboardingWizardSource() throws -> String {
        let sourceDirectory = self.onboardingWizardSourceURL().deletingLastPathComponent()
        return try self.sourceContents(at: [
            self.onboardingWizardSourceURL(),
            sourceDirectory.appendingPathComponent("OnboardingWizardConnectionSections.swift"),
            sourceDirectory.appendingPathComponent("OnboardingWizardTypes.swift"),
        ])
    }

    static func qrScannerSourceURL() -> URL {
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

    static func settingsProTabActionsSourceURL() -> URL {
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

    static func gatewayTrustPromptAlertSourceURL() -> URL {
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

    static func gatewayConnectionControllerSource() throws -> String {
        let sourceDirectory = self.gatewayConnectionControllerSourceURL().deletingLastPathComponent()
        return try self.sourceContents(at: [
            self.gatewayConnectionControllerSourceURL(),
            sourceDirectory.appendingPathComponent("GatewayConnectionController+Capabilities.swift"),
            sourceDirectory.appendingPathComponent("GatewayConnectionController+ManualAuth.swift"),
            sourceDirectory.appendingPathComponent("GatewayTLSFingerprintProbe.swift"),
        ])
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

    private static func watchInboxMessagesSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WatchApp/Sources/WatchInboxMessages.swift")
    }

    private static func channelsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsChannelsDestination.swift")
    }

    private static func settingsSkillsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Design/SettingsSkillsDestination.swift")
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

    static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }

    private static func sourceContents(at urls: [URL]) throws -> String {
        try urls
            .map { try String(contentsOf: $0, encoding: .utf8) }
            .joined(separator: "\n")
    }
}
