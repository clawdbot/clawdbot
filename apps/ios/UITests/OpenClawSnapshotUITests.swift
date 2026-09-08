import UIKit
import XCTest

@MainActor
final class OpenClawSnapshotUITests: XCTestCase {
    private struct ScreenshotTarget {
        let initialTab: String
        let initialDestination: String
        let name: String
    }

    private static let controlScreenshotTarget = ScreenshotTarget(
        initialTab: "control",
        initialDestination: "overview",
        name: "01-control-connected")
    private static let chatScreenshotTarget = ScreenshotTarget(
        initialTab: "chat",
        initialDestination: "chat",
        name: "02-chat-connected")
    private static let agentScreenshotTarget = ScreenshotTarget(
        initialTab: "agent",
        initialDestination: "agents",
        name: "03-agent-connected")
    private static let settingsScreenshotTarget = ScreenshotTarget(
        initialTab: "settings",
        initialDestination: "gateway",
        name: "04-settings-connected")
    private static let settingsFallbackTarget = ScreenshotTarget(
        initialTab: "settings",
        initialDestination: "settings",
        name: "settings-fallback")
    private static let appReadinessAccessibilityIdentifier = "RootTabs.Ready"

    private var app: XCUIApplication?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        self.terminateCurrentApp()
        try super.tearDownWithError()
    }

    func testReleaseControlScreenshot() {
        self.captureReleaseScreenshot(Self.controlScreenshotTarget)
    }

    func testReleaseChatScreenshot() {
        self.captureReleaseScreenshot(Self.chatScreenshotTarget) { app in
            let input = self.chatMessageInput(in: app)
            XCTAssertTrue(input.waitForExistence(timeout: 8))
            input.tap()
            let keyboard = app.keyboards.firstMatch
            if UIDevice.current.userInterfaceIdiom == .phone {
                XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
            }
            let focusProbe = "focus"
            input.typeText(focusProbe)
            XCTAssertEqual(input.value as? String, focusProbe)
            self.clearTextField(input)
            XCTAssertEqual(input.value as? String, "")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
            if keyboard.exists {
                XCTAssertTrue(keyboard.waitForNonExistence(timeout: 3))
            }
        }
    }

    func testReleaseAgentScreenshot() {
        self.captureReleaseScreenshot(Self.agentScreenshotTarget)
    }

    func testReleaseSettingsScreenshot() {
        self.captureReleaseScreenshot(Self.settingsScreenshotTarget)
    }

    func testWatchMessageDeliveryIsReachableFromSettings() throws {
        self.launchApp(for: Self.settingsFallbackTarget)
        let app = try XCTUnwrap(self.app)
        XCTAssertTrue(app.descendants(matching: .any)["SettingsHub.Fallback"].waitForExistence(timeout: 8))
        let watch = app.buttons["settings-watch-row"]
        for _ in 0..<12 where !watch.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(watch.isHittable)
        watch.tap()
        let delivery = app.buttons.containing(.staticText, identifier: "Message Delivery").firstMatch
        XCTAssertTrue(delivery.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "watch-delivery-settings")
        XCTAssertTrue(app.buttons["Connect Apple Watch"].exists)
        XCTAssertFalse(app.buttons["Enable Standalone Voice"].exists)
        XCTAssertFalse(app.buttons["Enable Direct Gateway Connection"].exists)
        delivery.tap()
        XCTAssertTrue(app.navigationBars["Message Delivery"].waitForExistence(timeout: 8))
        let loaded = app.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR label == %@", "No saved Watch messages", "Discard…")).firstMatch
        XCTAssertTrue(loaded.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "watch-message-delivery")
    }

    func testAgentsNavigateToSettingsThroughSidebar() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar navigation only")
        self.launchApp(for: Self.agentScreenshotTarget)

        XCTAssertTrue(self.app?.buttons["agent-status-filter-menu"].waitForExistence(timeout: 8) == true)
        try self.selectSidebarDestination("Settings")
        XCTAssertTrue(
            self.app?.descendants(matching: .any)["SettingsHub.Fallback"]
                .waitForExistence(timeout: 8) == true)
    }

    func testOnboardingExplainsCapabilitiesAndTrust() {
        let app = XCUIApplication()
        app.launchArguments += ["--openclaw-reset-onboarding"]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Security notice"].exists)
        let disclosure = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS[c] 'camera' AND label CONTAINS[c] 'trust the gateway and agent'")).firstMatch
        XCTAssertTrue(disclosure.exists)
        self.attachScreenshot(named: "onboarding-capabilities-and-trust")
    }

    func testSidebarOverviewNavigation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "overview",
            name: "control-overview-navigation"))

        XCTAssertTrue(self.app?.staticTexts["Agent session"].waitForExistence(timeout: 8) == true)
        try self.selectSidebarDestination("Overview")

        XCTAssertTrue(self.app?.buttons["RootTabs.Sidebar.Show"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Gateway settings"].waitForExistence(timeout: 5) == true)
        XCTAssertEqual(self.app?.state, .runningForeground)
    }

    func testLiveGatewayApprovalNotificationsFromOverview() async throws {
        try await self.verifyApprovalNotificationsNavigation(fromOverview: true)
    }

    func testLiveGatewayApprovalNotificationsFromSettings() async throws {
        try await self.verifyApprovalNotificationsNavigation(fromOverview: false)
    }

    func testTabletSidebarRootsRenderWithPersistentSidebar() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Tablet split navigation only")
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        for target in [
            Self.controlScreenshotTarget,
            Self.chatScreenshotTarget,
            Self.agentScreenshotTarget,
            Self.settingsFallbackTarget,
        ] {
            self.launchApp(for: target)
            let app = try XCTUnwrap(self.app)
            XCTAssertGreaterThan(app.frame.width, app.frame.height)
            XCTAssertTrue(self.destinationAnchor(in: app, destination: target.initialDestination).exists)
            self.tapSidebarReveal(in: app)
            let hideSidebar = app.buttons["RootTabs.Sidebar.Hide"]
            XCTAssertTrue(hideSidebar.waitForExistence(timeout: 5))
            self.attachScreenshot(named: "tablet-split-\(target.initialDestination)")
            hideSidebar.tap()
            XCTAssertTrue(app.buttons["RootTabs.Sidebar.Show"].waitForExistence(timeout: 5))
        }
    }

    func testSidebarAgentSelectorShowsAllAgentsAndKeepsFooterVisible() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "sidebar-agent-selector"))

        let showSidebar = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Show"])
        XCTAssertTrue(showSidebar.waitForExistence(timeout: 8))
        showSidebar.tap()

        let agentSelector = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.AgentSelector"])
        XCTAssertTrue(agentSelector.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(agentSelector.frame.height, 44)
        XCTAssertEqual(agentSelector.value as? String, "Molty")

        let newChat = try XCTUnwrap(self.app?.buttons["New Chat"])
        XCTAssertTrue(newChat.exists)
        XCTAssertGreaterThanOrEqual(newChat.frame.height, 44)
        XCTAssertGreaterThan(newChat.frame.minY, agentSelector.frame.maxY)

        let gatewayFooter = try XCTUnwrap(self.app?.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "OpenClaw Gateway")).firstMatch)
        XCTAssertTrue(gatewayFooter.exists)
        let settings = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Destination.settings"])
        XCTAssertTrue(settings.exists)
        XCTAssertGreaterThan(settings.frame.midX, gatewayFooter.frame.midX)
        XCTAssertEqual(settings.frame.midY, gatewayFooter.frame.midY, accuracy: 2)
        self.attachScreenshot(named: "sidebar-agent-selector")

        agentSelector.tap()

        XCTAssertTrue(self.app?.buttons["Molty"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Research"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Automation"].exists == true)
        self.attachScreenshot(named: "sidebar-agent-selector-open")

        self.app?.buttons["Research"].tap()
        XCTAssertEqual(agentSelector.value as? String, "Research")
        agentSelector.tap()
        XCTAssertTrue(self.app?.buttons["Molty"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Research"].exists == true)
        XCTAssertTrue(self.app?.buttons["Automation"].exists == true)
    }

    func testSidebarSlowEdgeDragOpensFromEveryRootDestination() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar only")
        let destinations = [
            "chat", "overview", "activity", "agents", "workboard", "skillWorkshop",
            "instances", "sessions", "files", "dreaming", "usage", "cron", "terminal",
            "docs", "settings", "gateway",
        ]
        var testedDestinations: [String] = []

        for destination in destinations {
            self.launchApp(for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: destination,
                name: "sidebar-slow-edge-drag-\(destination)"))

            let showSidebar = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Show"])
            XCTAssertTrue(showSidebar.waitForExistence(timeout: 8), destination)
            XCTAssertTrue(showSidebar.isHittable, destination)
            if destination == "overview" {
                showSidebar.tap()
                let hideSidebar = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Hide"])
                self.waitForHittable(true, of: hideSidebar)
                hideSidebar.tap()
                self.waitForHittable(true, of: showSidebar)
            }
            try self.openSidebarWithSlowEdgeDrag()
            if destination == "overview" {
                self.attachScreenshot(named: "sidebar-slow-edge-drag-overview")
            }
            try self.closeSidebarWithSlowDrag()
            testedDestinations.append(destination)
        }
        XCTAssertEqual(testedDestinations, destinations)
    }

    func testSidebarEdgeDragPreservesPushedScreenBackGesture() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "settings",
                initialDestination: "settings",
                name: "sidebar-pushed-screen-back-gesture"),
            appearance: nil,
            screenshotMode: false)

        if self.app?.buttons["Close"].waitForExistence(timeout: 2) == true {
            self.app?.buttons["Close"].tap()
        }
        // A clean normal-state launch can auto-route to Gateway setup.
        try self.selectSidebarDestination("Settings")
        let app = try XCTUnwrap(self.app)
        let licenses = app.buttons["settings-licenses-row"]
        for _ in 0..<12 where !licenses.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(licenses.isHittable)
        licenses.tap()
        XCTAssertTrue(self.app?.navigationBars["Licenses"].waitForExistence(timeout: 5) == true)

        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.78, dy: 0.5))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.1)
        self.attachScreenshot(named: "sidebar-pushed-screen-after-back-swipe")

        self.waitForHittable(false, of: app.buttons["RootTabs.Sidebar.Hide"])
        self.waitForHittable(true, of: licenses)
        XCTAssertFalse(app.navigationBars["Licenses"].exists)
    }

    func testGatewaySettingsOpenedFromChatUsesRootSidebarNavigation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar navigation only")

        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-settings-back"))

        try self.openChatGatewaySettings()
        let gatewayNavigationBar = try XCTUnwrap(self.app?.navigationBars["Gateway"])
        XCTAssertTrue(gatewayNavigationBar.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.buttons["RootTabs.Sidebar.Show"].exists == true)
        XCTAssertFalse(gatewayNavigationBar.buttons["BackButton"].exists)
        self.attachScreenshot(named: "chat-gateway-root")

        let showSidebar = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Show"])
        showSidebar.tap()
        let settings = try XCTUnwrap(self.app?.buttons["Settings"])
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()

        XCTAssertTrue(self.app?.navigationBars["Settings"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["RootTabs.Sidebar.Show"].exists == true)
        self.attachScreenshot(named: "gateway-to-settings-via-sidebar")
    }

    func testChatComposerStartsCompactAndGrowsWithDraft() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone composer proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-composer-growth"))

        let app = try XCTUnwrap(self.app)
        let textField = self.chatMessageInput(in: app)
        XCTAssertTrue(textField.waitForExistence(timeout: 8))
        let talkButton = app.buttons["chat-realtime-control"]
        XCTAssertTrue(talkButton.waitForExistence(timeout: 5))
        let attachmentButton = app.buttons["chat-attachment-picker"]
        XCTAssertTrue(attachmentButton.waitForExistence(timeout: 5))
        let dictationButton = app.buttons["chat-dictation-control"]
        XCTAssertTrue(dictationButton.waitForExistence(timeout: 5))
        let composerSurface = app.otherElements["chat-composer-surface"]
        XCTAssertTrue(composerSurface.waitForExistence(timeout: 5))
        let agentIdentity = self.agentIdentity(in: app)
        XCTAssertTrue(agentIdentity.waitForExistence(timeout: 5))
        XCTAssertEqual(agentIdentity.value as? String, "Collapsed")
        agentIdentity.tap()
        self.waitForValue("Expanded", of: agentIdentity)
        let sendButton = app.buttons["chat-send-message"]
        XCTAssertFalse(sendButton.exists)
        XCTAssertLessThanOrEqual(agentIdentity.frame.maxY, composerSurface.frame.minY)
        XCTAssertGreaterThanOrEqual(attachmentButton.frame.minX, composerSurface.frame.minX)
        XCTAssertLessThanOrEqual(attachmentButton.frame.maxX, composerSurface.frame.maxX)
        XCTAssertGreaterThanOrEqual(dictationButton.frame.minX, composerSurface.frame.minX)
        XCTAssertLessThanOrEqual(dictationButton.frame.maxX, composerSurface.frame.maxX)
        XCTAssertGreaterThanOrEqual(talkButton.frame.minX, composerSurface.frame.minX)
        XCTAssertLessThanOrEqual(talkButton.frame.maxX, composerSurface.frame.maxX)
        self.assertMinimumTouchTarget(attachmentButton)
        self.assertMinimumTouchTarget(dictationButton)
        self.assertMinimumTouchTarget(talkButton)
        let contextUsage = app.buttons["chat-context-usage"]
        XCTAssertTrue(contextUsage.waitForExistence(timeout: 5))
        let inlinePermissions = app.buttons["chat-composer-inline-permissions"]
        let inlineModel = app.buttons["chat-composer-inline-model"]
        let inlineEffort = app.buttons["chat-composer-inline-effort"]
        XCTAssertTrue(inlinePermissions.waitForExistence(timeout: 5))
        XCTAssertTrue(inlineModel.waitForExistence(timeout: 5))
        XCTAssertTrue(inlineEffort.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(inlinePermissions)
        self.assertMinimumTouchTarget(inlineModel)
        self.assertMinimumTouchTarget(inlineEffort)
        for inlineControl in [inlinePermissions, contextUsage, inlineModel, inlineEffort] {
            XCTAssertGreaterThanOrEqual(inlineControl.frame.minX, composerSurface.frame.minX)
            XCTAssertLessThanOrEqual(inlineControl.frame.maxX, composerSurface.frame.maxX)
            XCTAssertLessThanOrEqual(abs(inlineControl.frame.midY - dictationButton.frame.midY), 1)
        }
        XCTAssertEqual(inlinePermissions.value as? String, "Guarded")
        XCTAssertFalse((inlineModel.value as? String ?? "").isEmpty)
        XCTAssertFalse((inlineEffort.value as? String ?? "").isEmpty)
        self.assertMinimumTouchTarget(contextUsage)
        self.assertNoHorizontalOverlap([
            attachmentButton,
            inlinePermissions,
            contextUsage,
            inlineModel,
            inlineEffort,
            dictationButton,
            talkButton,
        ])
        XCTAssertEqual(contextUsage.value as? String, "19 percent of the context window used")
        let compactHeight = textField.frame.height
        let compactSurfaceHeight = composerSurface.frame.height
        XCTAssertGreaterThanOrEqual(compactSurfaceHeight, 96)
        XCTAssertLessThanOrEqual(compactHeight, 44)
        XCTAssertLessThanOrEqual(textField.frame.maxY, attachmentButton.frame.minY + 2)
        XCTAssertLessThanOrEqual(abs(attachmentButton.frame.midY - dictationButton.frame.midY), 1)
        XCTAssertLessThanOrEqual(abs(talkButton.frame.midY - dictationButton.frame.midY), 1)
        self.attachScreenshot(named: "chat-composer-inline-controls")

        inlinePermissions.tap()
        XCTAssertTrue(app.buttons["Default (inherited)"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Read-only"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Guarded"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Workspace"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Full"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-permissions")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        inlineModel.tap()
        let inlineModelSelectionTarget = app.buttons["chat-composer-model-selection-target"]
        XCTAssertTrue(inlineModelSelectionTarget.waitForExistence(timeout: 3))
        XCTAssertEqual(inlineModelSelectionTarget.label, "Changes the global default")
        let inlineSelectedModel = app.buttons["openai/gpt-5.6-sol"]
        XCTAssertTrue(inlineSelectedModel.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Default: openai/gpt-5.6-sol"].exists)
        let inlineNonDefaultModel = app.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(inlineNonDefaultModel.waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-model")
        inlineNonDefaultModel.tap()
        let updatedInlineModel = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(updatedInlineModel.waitForExistence(timeout: 3))
        self.waitForValue("claude-opus-4-1", of: updatedInlineModel)
        updatedInlineModel.tap()
        let updatedInlineModelSelectionTarget = app.buttons["chat-composer-model-selection-target"]
        XCTAssertTrue(updatedInlineModelSelectionTarget.waitForExistence(timeout: 3))
        XCTAssertEqual(updatedInlineModelSelectionTarget.label, "Changes the global default")
        let selectedInlineModel = app.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(selectedInlineModel.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["openai/gpt-5.6-sol"].exists)
        app.buttons["openai/gpt-5.6-sol"].tap()
        let restoredInlineModel = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(restoredInlineModel.waitForExistence(timeout: 3))
        self.waitForValue("gpt-5.6-sol", of: restoredInlineModel)

        inlineEffort.tap()
        XCTAssertTrue(app.buttons["Thinking"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Fast"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-effort")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        contextUsage.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["24.0k of 128.0k tokens used"]
                .waitForExistence(timeout: 3))
        let compactThread = app.buttons["Compact Thread"]
        XCTAssertTrue(compactThread.waitForExistence(timeout: 3))
        XCTAssertTrue(compactThread.isEnabled)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        attachmentButton.tap()
        let photoLibrary = app.buttons["Photo Library"]
        XCTAssertTrue(photoLibrary.waitForExistence(timeout: 3))
        XCTAssertTrue(photoLibrary.isEnabled)
        XCTAssertTrue(app.buttons["Camera"].waitForExistence(timeout: 3))
        let mediaFile = app.buttons["Choose Media File"]
        XCTAssertTrue(mediaFile.waitForExistence(timeout: 3))
        XCTAssertTrue(mediaFile.isEnabled)
        XCTAssertTrue(app.buttons["Verbosity"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Web Search"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Skills"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Connectors"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Permissions"].exists)
        XCTAssertEqual(
            app.buttons.matching(NSPredicate(format: "label == %@", "Model")).count,
            1)
        XCTAssertFalse(app.buttons["Thinking"].exists)
        XCTAssertFalse(app.buttons["Fast"].exists)
        XCTAssertFalse(self.app?.buttons["Voice Memo"].exists == true)
        self.attachScreenshot(named: "chat-composer-capabilities")
        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        attachmentButton.tap()
        app.buttons["Skills"].tap()
        XCTAssertTrue(app.buttons["Auto Review"].waitForExistence(timeout: 3))
        let disabledSkill = app.buttons["Disabled Skill — Disabled in the Gateway configuration."]
        XCTAssertTrue(disabledSkill.waitForExistence(timeout: 3))
        XCTAssertFalse(disabledSkill.isEnabled)
        self.attachScreenshot(named: "chat-composer-skills")
        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        attachmentButton.tap()
        app.buttons["Connectors"].tap()
        XCTAssertTrue(app.buttons["GitHub"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Linear"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-connectors")
        app.buttons["GitHub"].tap()
        XCTAssertTrue(app.buttons["Enabled for this session"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Tool Access"].waitForExistence(timeout: 3))
        app.buttons["Tool Access"].tap()
        XCTAssertTrue(app.buttons["Search code"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Create issue"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-tool-access")
        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        self.attachScreenshot(named: "chat-composer-compact")

        textField.tap()
        textField.typeText(
            "Draft a polished launch note that covers the new design, validation, rollout plan, " +
                "and follow-up details for the team.")
        let composerGrew = expectation(
            for: NSPredicate { _, _ in textField.frame.height >= compactHeight + 12 },
            evaluatedWith: textField)
        wait(for: [composerGrew], timeout: 4)
        XCTAssertTrue(sendButton.waitForExistence(timeout: 3))
        XCTAssertTrue(talkButton.waitForNonExistence(timeout: 3))
        self.assertMinimumTouchTarget(sendButton)
        XCTAssertGreaterThanOrEqual(composerSurface.frame.height, compactSurfaceHeight + 12)
        XCTAssertLessThanOrEqual(textField.frame.maxY, attachmentButton.frame.minY + 2)
        XCTAssertLessThanOrEqual(abs(attachmentButton.frame.midY - dictationButton.frame.midY), 1)
        XCTAssertLessThanOrEqual(abs(sendButton.frame.midY - dictationButton.frame.midY), 1)
        self.attachScreenshot(named: "chat-composer-expanded")

        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(self.app?.keyboards.firstMatch.waitForNonExistence(timeout: 3) == true)
    }

    func testChatComposerReturnInsertsNewlineWithoutSending() throws {
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-composer-return"))

        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("first line\nsecond line")

        XCTAssertEqual(input.value as? String, "first line\nsecond line")
        XCTAssertTrue(app.buttons["chat-send-message"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["first line\nsecond line"].exists)
        self.attachScreenshot(named: "chat-composer-return")
    }

    func testVoiceNoteDraftKeepsStopAvailableDuringActiveResponse() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone voice-note composer proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-voice-note-stop-active-response"),
            additionalArguments: ["--openclaw-hold-initial-chat-run"])

        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Keep this response running while I record a voice note.")

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(send.isEnabled)
        send.tap()

        let stop = app.buttons["Stop response"]
        XCTAssertTrue(stop.waitForExistence(timeout: 8))
        XCTAssertTrue(stop.isEnabled)

        let microphone = app.buttons["chat-dictation-control"]
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        microphone.press(forDuration: 0.8)

        let recordVoiceNote = app.buttons["Record Voice Note"]
        XCTAssertTrue(recordVoiceNote.waitForExistence(timeout: 5))
        recordVoiceNote.tap()

        let finishVoiceNote = app.buttons["Finish voice note"]
        XCTAssertTrue(finishVoiceNote.waitForExistence(timeout: 8))
        finishVoiceNote.tap()

        let voiceNote = app.staticTexts["Voice note"]
        XCTAssertTrue(voiceNote.waitForExistence(timeout: 8))
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        XCTAssertTrue(stop.isEnabled)
        self.attachScreenshot(named: "voice-note-stop-active-response")

        stop.tap()
        XCTAssertTrue(send.waitForExistence(timeout: 8))
        self.waitForEnabled(send)
        XCTAssertTrue(voiceNote.exists)
        send.tap()

        XCTAssertTrue(voiceNote.waitForNonExistence(timeout: 8))
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I can help with"))
                .firstMatch.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "voice-note-sent-after-stopping-response")
    }

    func testKeyboardOpenPreservesTranscriptAndFollowsLiveEdgeAfterSend() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone keyboard proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "keyboard-follow"),
            additionalArguments: ["--openclaw-long-chat-fixture"])
        let app = try XCTUnwrap(self.app)

        let latestSeededReply = app.staticTexts["OPENCLAW_LONG_CHAT_LATEST"]
        XCTAssertTrue(latestSeededReply.waitForExistence(timeout: 8))

        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
        func visibleAreaAboveKeyboard() -> CGRect {
            CGRect(
                x: app.frame.minX,
                y: app.frame.minY,
                width: app.frame.width,
                height: keyboard.frame.minY - app.frame.minY)
        }
        XCTAssertTrue(latestSeededReply.exists)
        XCTAssertTrue(latestSeededReply.frame.intersects(visibleAreaAboveKeyboard()))
        XCTAssertLessThanOrEqual(latestSeededReply.frame.maxY, keyboard.frame.minY + 1)
        self.assertElementHasRenderedContent(latestSeededReply, named: "seeded reply after keyboard opens")

        let promptPrefix =
            "Give me a long, detailed status update covering the release plan, review feedback, " +
            "open follow-ups, "
        let promptSuffix = "and the next steps for the team."
        let prompt = promptPrefix + promptSuffix
        input.typeText(promptPrefix)
        XCTAssertTrue(latestSeededReply.exists)
        XCTAssertTrue(latestSeededReply.frame.intersects(visibleAreaAboveKeyboard()))
        self.assertElementHasRenderedContent(latestSeededReply, named: "seeded reply while typing")
        input.typeText(promptSuffix)
        XCTAssertEqual(input.value as? String, prompt)
        XCTAssertTrue(latestSeededReply.exists)
        XCTAssertTrue(latestSeededReply.frame.intersects(visibleAreaAboveKeyboard()))
        XCTAssertLessThanOrEqual(latestSeededReply.frame.maxY, keyboard.frame.minY + 1)
        self.attachScreenshot(named: "keyboard-transcript-visible-while-typing")

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()

        // Regression proof for #108692 and #135214: the transcript remains rendered while typing,
        // then the sent turn follows the live edge without a manual redraw or scroll.
        XCTAssertTrue(keyboard.exists)
        let sentPrompt = app.staticTexts.matching(
            NSPredicate(format: "label == %@", prompt))
            .firstMatch
        XCTAssertTrue(sentPrompt.waitForExistence(timeout: 8))
        let reply = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "keep the mobile workflow connected to the gateway"))
            .firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 8))
        Thread.sleep(forTimeInterval: 1.0)
        let visibleArea = visibleAreaAboveKeyboard()
        XCTAssertTrue(sentPrompt.frame.intersects(visibleArea))
        XCTAssertTrue(reply.frame.intersects(visibleArea))
        XCTAssertLessThanOrEqual(reply.frame.maxY, keyboard.frame.minY + 1)
        self.assertElementHasRenderedContent(sentPrompt, named: "sent prompt after send")
        self.assertElementHasRenderedContent(reply, named: "reply after send")
        XCTAssertFalse(app.buttons["Jump to latest reply"].exists)
        self.attachScreenshot(named: "keyboard-transcript-visible-after-send")
    }

    func testExistingSessionRestoresLatestOutput() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone reader positioning proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "existing-session-latest-output"),
            additionalArguments: ["--openclaw-long-chat-fixture"])
        let app = try XCTUnwrap(self.app)

        let latest = app.staticTexts["OPENCLAW_LONG_CHAT_LATEST"]
        XCTAssertTrue(latest.waitForExistence(timeout: 8))
        let composer = app.otherElements["chat-composer-surface"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertLessThanOrEqual(latest.frame.maxY, composer.frame.minY + 1)
        XCTAssertFalse(app.buttons["Jump to latest reply"].exists)
        self.attachScreenshot(named: "existing-session-latest-output")
    }

    func testChatPresentationInLightAppearance() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone chat proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-light"),
            appearance: "light")

        XCTAssertTrue(self.app.map { self.agentIdentity(in: $0).waitForExistence(timeout: 8) } == true)
        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].exists == true)
        self.attachScreenshot(named: "chat-light")
    }

    func testChatKeepsLayeredCanvasInDarkAppearance() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone chat proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-dark-layered-canvas"))

        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].waitForExistence(timeout: 8) == true)
        self.assertChatCanvasIsNotSolidBlack()
        self.attachScreenshot(named: "chat-dark-layered-canvas")

        self.sendFixtureChatMessage("Check the release status and prepare the next steps.")
        self.attachScreenshot(named: "chat-dark-soft-bottom-edge")
    }

    func testAssistantLongPressKeepsTranscriptVisibleAndActionsReachable() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone message interaction proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "assistant-message-actions"))
        let app = try XCTUnwrap(self.app)

        let assistant = app.staticTexts[
            "Ready when you are. I can check a project, coordinate an agent, or prepare the next step.",
        ]
        XCTAssertTrue(assistant.waitForExistence(timeout: 8))
        assistant.press(forDuration: 0.8)
        XCTAssertTrue(assistant.exists)
        XCTAssertTrue(app.otherElements["chat-composer-surface"].exists)
        self.attachScreenshot(named: "assistant-message-selection")

        let actions = app.buttons["chat-message-actions"]
        XCTAssertTrue(actions.waitForExistence(timeout: 3))
        actions.tap()
        XCTAssertTrue(app.buttons["Copy Message"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "assistant-message-actions")

        app.buttons["Select Text"].tap()
        let selectableText = app.textViews["chat-selectable-text"]
        XCTAssertTrue(selectableText.waitForExistence(timeout: 3))
        XCTAssertTrue((selectableText.value as? String)?.contains("Ready when you are") == true)
        self.attachScreenshot(named: "assistant-select-text")
        app.buttons["Close"].tap()
        XCTAssertTrue(selectableText.waitForNonExistence(timeout: 3))
    }

    func testCodeBlockCopyButtonCopiesRawCode() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone code block copy proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "code-block-copy"))
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("```swift\nlet copied = true\n```")
        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        send.tap()

        // The user's block precedes any code parsed from the fixture's echoed reply.
        let copyCode = app.buttons["Copy code"].firstMatch
        XCTAssertTrue(copyCode.waitForExistence(timeout: 8))
        app.scrollViews.firstMatch.swipeDown()
        self.attachScreenshot(named: "code-block-copy")
        // iOS prompts before another process reads pasteboard contents, so the runner can only
        // observe that the tap wrote a string; ChatPasteboardTests covers the exact bytes in-process.
        UIPasteboard.general.items = []
        XCTAssertFalse(UIPasteboard.general.hasStrings)
        copyCode.tap()
        XCTAssertTrue(UIPasteboard.general.hasStrings)
        self.attachScreenshot(named: "code-block-copied")
    }

    func testEmptyChatStarterPromptSendsMessage() throws {
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-empty-starters"),
            additionalArguments: ["--openclaw-empty-chat-fixture"])

        let starter = try XCTUnwrap(self.app?.buttons["chat-starter-summarize-status"])
        XCTAssertTrue(starter.waitForExistence(timeout: 8))
        XCTAssertTrue(self.app?.staticTexts["What would you like to work on?"].exists == true)
        self.attachScreenshot(named: "chat-empty-starters")

        starter.tap()
        let sentText = "Summarize the current OpenClaw status and tell me what needs attention."
        let sentRows = self.app?.staticTexts.matching(NSPredicate(format: "label == %@", sentText))
        XCTAssertTrue(sentRows?.firstMatch.waitForExistence(timeout: 5) == true)
        XCTAssertEqual(sentRows?.count, 1)
        XCTAssertTrue(
            self.app?.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I can help with"))
                .firstMatch.waitForExistence(timeout: 5) == true)
        self.attachScreenshot(named: "chat-starter-response")
    }

    func testEmptyChatStarterPromptsLocalizeInGerman() throws {
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-empty-starters-german"),
            additionalArguments: [
                "--openclaw-empty-chat-fixture",
                "-AppleLanguages",
                "(de)",
                "-AppleLocale",
                "de_DE",
            ])

        XCTAssertTrue(self.app?.staticTexts["Woran möchtest du arbeiten?"].waitForExistence(timeout: 8) == true)
        let starter = try XCTUnwrap(self.app?.buttons["OpenClaw-Status prüfen"])
        XCTAssertTrue(starter.exists)
        starter.tap()
        XCTAssertTrue(
            self.app?.staticTexts[
                "Fasse den aktuellen OpenClaw-Status zusammen und sage mir, was Aufmerksamkeit erfordert.",
            ].waitForExistence(timeout: 5) == true)
        self.attachScreenshot(named: "chat-empty-starters-german")
    }

    func testOnboardingPairCommandAndCompletionOpenChat() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone onboarding proof only")
        self.addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }

        let app = XCUIApplication()
        app.launchArguments += ["--openclaw-reset-onboarding"]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertFalse(app.staticTexts["Allow access"].exists)

        let copySetupCommand = app.buttons["Copy setup code command"]
        XCTAssertTrue(copySetupCommand.waitForExistence(timeout: 8))
        copySetupCommand.tap()
        XCTAssertEqual(copySetupCommand.value as? String, "Copied")
        self.attachScreenshot(named: "onboarding-copy-setup-code-command")

        app.buttons["Connect Manually"].tap()
        let setupCode = app.textFields["Enter setup code"]
        XCTAssertTrue(setupCode.waitForExistence(timeout: 5))
        setupCode.tap()
        setupCode.typeText("APPLE-REVIEW-DEMO")
        app.buttons["Dismiss Keyboard"].tap()
        app.buttons["Apply"].tap()

        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Apple Review Demo Gateway"].exists)
        XCTAssertTrue(app.staticTexts["Local demo mode"].exists)
        self.attachScreenshot(named: "onboarding-connected-go-to-chat")

        app.buttons["Go to Chat"].tap()
        XCTAssertTrue(self.agentIdentity(in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Show"].exists)
    }

    func testChatAndOverviewNavigateThroughSidebar() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "overview",
            name: "control-chat-return"))

        let agentSession = try XCTUnwrap(self.app?.staticTexts["Agent session"])
        XCTAssertTrue(agentSession.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "control-overview-before-chat")

        try self.startNewChatFromSidebar()
        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].waitForExistence(timeout: 8) == true)
        self.attachScreenshot(named: "chat-return-to-overview")

        try self.selectSidebarDestination("Overview")
        XCTAssertTrue(agentSession.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "control-overview-after-chat")

        let agentSessionRow = try XCTUnwrap(self.app?.buttons.matching(NSPredicate(
            format: "label BEGINSWITH[c] %@",
            "Molty, chat")).firstMatch)
        XCTAssertTrue(agentSessionRow.waitForExistence(timeout: 8))
        agentSessionRow.tap()

        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].waitForExistence(timeout: 8) == true)
        self.attachScreenshot(named: "chat-session-return-to-overview")
        try self.selectSidebarDestination("Overview")
        XCTAssertTrue(self.app?.staticTexts["Agent session"].waitForExistence(timeout: 8) == true)
    }

    func testAgentUsesToolbarFilter() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Agent proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "agent",
            initialDestination: "agents",
            name: "agent-toolbar-filter"))

        let menu = try XCTUnwrap(app?.buttons["agent-status-filter-menu"])
        XCTAssertTrue(menu.waitForExistence(timeout: 8))
        XCTAssertFalse(self.app?.segmentedControls["Agent status"].exists == true)
        menu.tap()
        XCTAssertTrue(self.app?.buttons["All"].waitForExistence(timeout: 3) == true)
        XCTAssertTrue(self.app?.buttons["Online"].exists == true)
        XCTAssertTrue(self.app?.buttons["Ready"].exists == true)
        self.attachScreenshot(named: "agent-toolbar-filter")

        // Native context menus must finish their dismissal before teardown. Killing
        // the app with this menu open can leave the next app scene inactive.
        self.app?.buttons["Ready"].tap()
        self.waitForValue("Ready", of: menu)
        menu.tap()
        let all = try XCTUnwrap(self.app?.buttons["All"])
        XCTAssertTrue(all.waitForExistence(timeout: 3))
        all.tap()
        self.waitForValue("All", of: menu)
    }

    func testLiveGatewayFreshInstallSetupAndRelaunch() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone setup proof only")
        let app = try self.launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        XCTAssertEqual(app.state, .runningForeground)

        let controlApp = self.relaunchConnectedLiveGatewayApp(
            initialTab: "control",
            initialDestination: "overview")
        XCTAssertTrue(controlApp.staticTexts["Agent session"].waitForExistence(timeout: 8))
        XCTAssertTrue(controlApp.buttons["RootTabs.Sidebar.Show"].exists)
        XCTAssertEqual(controlApp.state, .runningForeground)
    }

    func testLiveGatewayChatRoundTripAndControlOverview() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone chat proof only")
        let app = try launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")

        // Build scrollable history through the paired app before checking reader behavior.
        for index in 0..<3 {
            let seedMarker = "OPENCLAW_E2E_SEED_\(index)_\(Int(Date().timeIntervalSince1970 * 1000))"
            let seedContext = String(repeating: "Reader context \(index). ", count: 6)
            self.sendLiveGatewayMessage(
                "\(seedContext)Reply exactly with \(seedMarker) and no other text.",
                expecting: seedMarker,
                in: app)
        }

        let replyMarker = "OPENCLAW_E2E_OK_\(Int(Date().timeIntervalSince1970 * 1000))"
        self.sendLiveGatewayMessage(
            "Reply exactly with \(replyMarker) and no other text.",
            expecting: replyMarker,
            in: app)
        let jumpToLatest = app.buttons["Jump to latest reply"]
        XCTAssertTrue(jumpToLatest.waitForExistence(timeout: 3))
        self.attachScreenshot(named: "live-gateway-chat-reply-anchored")

        jumpToLatest.tap()
        XCTAssertTrue(jumpToLatest.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts[replyMarker].exists)
        Thread.sleep(forTimeInterval: 0.5)
        self.attachScreenshot(named: "live-gateway-chat-jumped-to-latest")

        let transcript = app.scrollViews.firstMatch
        XCTAssertTrue(transcript.exists)
        transcript.swipeDown()
        XCTAssertTrue(jumpToLatest.waitForExistence(timeout: 3))
        self.attachScreenshot(named: "live-gateway-chat-manual-departure")
        jumpToLatest.tap()
        XCTAssertTrue(jumpToLatest.waitForNonExistence(timeout: 3))

        let controlApp = self.relaunchConnectedLiveGatewayApp(
            initialTab: "control",
            initialDestination: "overview")
        XCTAssertTrue(controlApp.staticTexts["Agent session"].waitForExistence(timeout: 8))
        self.attachScreenshot(named: "live-gateway-control")
        try self.selectSidebarDestination("Overview")
        XCTAssertTrue(controlApp.buttons["Gateway settings"].waitForExistence(timeout: 5))
        self.attachScreenshot(named: "live-gateway-overview")
        XCTAssertEqual(controlApp.state, .runningForeground)
    }

    func testManualAuthRetryUsesEditedToken() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_RETRY_E2E"] == "1",
            "Set OPENCLAW_IOS_RETRY_E2E=1 with a local token-auth Gateway on port 18920")
        let token = try XCTUnwrap(ProcessInfo.processInfo.environment["OPENCLAW_IOS_RETRY_TOKEN"])

        let app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments += ["--openclaw-reset-onboarding"]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 8))
        app.buttons["Connect Manually"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Home Network")).firstMatch.tap()
        app.buttons["Continue"].tap()

        let host = app.textFields["Host"]
        XCTAssertTrue(host.waitForExistence(timeout: 5))
        host.tap()
        self.clearTextField(host)
        host.typeText("localhost")

        let port = app.textFields["Port"]
        XCTAssertTrue(port.waitForExistence(timeout: 5))
        port.tap()
        self.clearTextField(port)
        port.typeText("18920")
        let unencrypted = app.buttons["Unencrypted"]
        XCTAssertTrue(unencrypted.waitForExistence(timeout: 5))
        unencrypted.tap()
        app.buttons["Connect"].tap()

        let tokenField = app.secureTextFields["Gateway Auth Token"]
        XCTAssertTrue(tokenField.waitForExistence(timeout: 20))
        tokenField.tap()
        tokenField.typeText(token)
        app.buttons["Dismiss Keyboard"].tap()
        app.buttons["Retry Connection"].tap()

        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 30))
        self.attachScreenshot(named: "manual-auth-retry-connected")
    }
}

extension OpenClawSnapshotUITests {
    func testUnavailableModelRejectsElementAndCoordinateActivationInInlinePicker() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-unavailable-model-fixture"])
        let app = try XCTUnwrap(self.app)
        let inlineModel = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(inlineModel.waitForExistence(timeout: 8))
        let originalValue = inlineModel.value as? String
        inlineModel.tap()

        let unavailable = app.buttons["anthropic/claude-opus-4-1 — Sign-in needed"]
        XCTAssertTrue(unavailable.waitForExistence(timeout: 3))
        unavailable.tap()
        XCTAssertEqual(app.buttons["chat-composer-inline-model"].value as? String, originalValue)

        if !unavailable.waitForExistence(timeout: 1) {
            inlineModel.tap()
            XCTAssertTrue(unavailable.waitForExistence(timeout: 3))
        }
        self.attachScreenshot(named: "chat-composer-model-unavailable")
        unavailable.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(app.buttons["chat-composer-inline-model"].value as? String, originalValue)
    }

    func testUnavailableModelIsDisabledInChatActions() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: [
                "--openclaw-unavailable-model-fixture",
                "-openclaw.chat.modelFavorites", "",
                "-openclaw.chat.modelRecents", "",
            ])
        let app = try XCTUnwrap(self.app)
        app.buttons["Chat actions"].tap()
        let popover = app.descendants(matching: .any)["chat-actions-popover"]
        XCTAssertTrue(popover.waitForExistence(timeout: 5))
        let drawer = popover.buttons["chat-model-provider-drawer-anthropic"]
        XCTAssertTrue(drawer.waitForExistence(timeout: 3))
        drawer.tap()

        let unavailable = popover.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(unavailable.waitForExistence(timeout: 3))
        XCTAssertFalse(unavailable.isEnabled)
        XCTAssertTrue(popover.staticTexts["Sign-in needed"].exists)
        unavailable.tap()
        XCTAssertTrue(popover.exists)

        unavailable.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(popover.exists)
        self.attachScreenshot(named: "chat-actions-model-unavailable")
    }

    func testSelectedAuthFailedModelDisablesOnlineSend() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-selected-model-auth-failure-fixture"])
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("This send should stay local")

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        XCTAssertFalse(send.isEnabled)
        XCTAssertTrue(app.staticTexts[
            "Authentication failed. Review the provider credential or sign-in, then retry.",
        ].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-model-auth-failed")
    }

    func testModelSelectionTargetVariantsPersistAcrossBothPickers() throws {
        for (target, disclosure) in [
            ("session", "Changes this session only"),
            ("agent", "Changes this agent's default"),
            ("global", "Changes the global default"),
        ] {
            self.launchApp(
                for: Self.chatScreenshotTarget,
                additionalArguments: [
                    "--openclaw-model-selection-target", target,
                    "-openclaw.chat.modelFavorites", "",
                    "-openclaw.chat.modelRecents", "",
                ])
            let app = try XCTUnwrap(self.app)
            let inlineModel = app.buttons["chat-composer-inline-model"]
            XCTAssertTrue(inlineModel.waitForExistence(timeout: 8))
            inlineModel.tap()
            XCTAssertTrue(app.buttons[disclosure].waitForExistence(timeout: 3))

            let alternateModel = app.buttons["anthropic/claude-opus-4-1"]
            XCTAssertTrue(alternateModel.waitForExistence(timeout: 3))
            alternateModel.tap()
            self.waitForValue("claude-opus-4-1", of: inlineModel)

            inlineModel.tap()
            XCTAssertTrue(app.buttons[disclosure].waitForExistence(timeout: 3))
            XCTAssertTrue(app.buttons["anthropic/claude-opus-4-1"].waitForExistence(timeout: 3))
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()

            let actions = app.buttons["Chat actions"]
            XCTAssertTrue(actions.waitForExistence(timeout: 3))
            actions.tap()
            XCTAssertTrue(app.staticTexts[disclosure].waitForExistence(timeout: 3))
            XCTAssertTrue(app.descendants(matching: .any)["chat-actions-popover"].exists)
            self.attachScreenshot(named: "chat-model-selection-target-\(target)")
        }
    }

    func testChatActionsModelRowsScreenshot() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: [
                "-openclaw.chat.modelFavorites", "",
                "-openclaw.chat.modelRecents", "",
            ])
        let app = try XCTUnwrap(self.app)
        let actions = app.buttons["Chat actions"]
        XCTAssertTrue(actions.waitForExistence(timeout: 8))
        self.assertMinimumTouchTarget(actions)
        self.assertMinimumTouchTarget(app.buttons["RootTabs.Sidebar.Show"])
        self.attachScreenshot(named: "chat-actions-header")
        actions.tap()

        let popover = app.descendants(matching: .any)["chat-actions-popover"]
        XCTAssertTrue(popover.waitForExistence(timeout: 5))
        XCTAssertFalse(popover.buttons["New Chat"].exists)
        XCTAssertFalse(popover.buttons["Sessions…"].exists)
        XCTAssertFalse(popover.buttons["Dashboard"].exists)
        XCTAssertTrue(popover.buttons["New session options…"].exists)
        let defaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue(defaultModel.waitForExistence(timeout: 5))
        let defaultLogo = defaultModel.images["chat-model-provider-icon-openai"]
        XCTAssertTrue(defaultLogo.exists)

        let providerDrawer = app.buttons["chat-model-provider-drawer-openai"]
        XCTAssertTrue(providerDrawer.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(providerDrawer)
        XCTAssertEqual(providerDrawer.value as? String, "Collapsed")
        let explicitModel = app.buttons["openai/gpt-5.6-sol"]
        let initialExplicitModelCount = app.buttons.matching(
            NSPredicate(format: "label == %@", "openai/gpt-5.6-sol")).count
        providerDrawer.tap()
        XCTAssertEqual(providerDrawer.value as? String, "Expanded")
        XCTAssertTrue(explicitModel.exists)
        XCTAssertTrue(explicitModel.images["chat-model-provider-icon-openai"].exists)
        XCTAssertGreaterThan(
            app.buttons.matching(NSPredicate(format: "label == %@", "openai/gpt-5.6-sol")).count,
            initialExplicitModelCount)
        let explicitIsSelected = explicitModel.value as? String == "Selected"
        let selectedModel = explicitIsSelected ? explicitModel : defaultModel
        self.assertMinimumTouchTarget(selectedModel)
        let selectedCheckmark = selectedModel.images["chat-menu-selection-checkmark"]
        XCTAssertTrue(selectedCheckmark.exists)
        XCTAssertGreaterThan(selectedCheckmark.frame.minX, selectedModel.frame.midX)
        self.attachScreenshot(named: "chat-actions-model-rows")

        let expandedProviderDrawer = app.buttons["chat-model-provider-drawer-openai"]
        XCTAssertTrue(expandedProviderDrawer.waitForExistence(timeout: 5))
        expandedProviderDrawer.tap()
        let collapsedProviderDrawer = app.buttons["chat-model-provider-drawer-openai"]
        self.waitForValue("Collapsed", of: collapsedProviderDrawer)
        let anthropicDrawer = app.buttons["chat-model-provider-drawer-anthropic"]
        XCTAssertTrue(anthropicDrawer.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(anthropicDrawer)
        XCTAssertEqual(anthropicDrawer.value as? String, "Collapsed")
        anthropicDrawer.tap()
        let expandedAnthropicDrawer = app.buttons["chat-model-provider-drawer-anthropic"]
        self.waitForValue("Expanded", of: expandedAnthropicDrawer)
        let nonDefaultModel = app.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(nonDefaultModel.waitForExistence(timeout: 5))
        XCTAssertTrue(nonDefaultModel.images["chat-model-provider-icon-anthropic"].exists)
        self.assertMinimumTouchTarget(nonDefaultModel)
        nonDefaultModel.tap()
        XCTAssertTrue(popover.waitForNonExistence(timeout: 3))

        actions.tap()
        let selectedNextModel = app.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(selectedNextModel.waitForExistence(timeout: 5))
        XCTAssertEqual(selectedNextModel.value as? String, "Selected")
        XCTAssertGreaterThan(
            selectedNextModel.images["chat-menu-selection-checkmark"].frame.minX,
            selectedNextModel.frame.midX)
        let restoredDefaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue(restoredDefaultModel.waitForExistence(timeout: 5))
        restoredDefaultModel.tap()
        XCTAssertTrue(popover.waitForNonExistence(timeout: 3))

        actions.tap()
        let reselectedDefaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue(reselectedDefaultModel.waitForExistence(timeout: 5))
        XCTAssertEqual(reselectedDefaultModel.value as? String, "Selected")
        XCTAssertGreaterThan(
            reselectedDefaultModel.images["chat-menu-selection-checkmark"].frame.minX,
            reselectedDefaultModel.frame.midX)

        let thinkingSlider = app.sliders["chat-thinking-slider"]
        XCTAssertTrue(thinkingSlider.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(app.descendants(matching: .any)["chat-thinking-slider-hit-target"])
        let thinkingNotches = app.descendants(matching: .any)["chat-thinking-notches"]
        XCTAssertTrue(thinkingNotches.waitForExistence(timeout: 5))
        XCTAssertEqual(thinkingNotches.value as? String, "4 stops")
        let thinkingValues = ["Default (Auto)", "Low", "Medium", "High"]
        self.waitForValue(thinkingValues[0], of: thinkingSlider)
        for (index, expectedValue) in thinkingValues.enumerated().dropFirst() {
            thinkingSlider.adjust(
                toNormalizedSliderPosition: CGFloat(index) / CGFloat(thinkingValues.count - 1))
            self.waitForValue(expectedValue, of: thinkingSlider)
        }
        let thinkingDefault = app.buttons["chat-thinking-use-default"]
        XCTAssertTrue(thinkingDefault.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(thinkingDefault)
        self.waitForEnabled(thinkingSlider)
        let selectedThinkingValue = try XCTUnwrap(thinkingSlider.value as? String)
        XCTAssertFalse(selectedThinkingValue.hasPrefix("Default"))
        XCTAssertTrue(popover.exists)

        let fastMode = app.switches["chat-fast-mode-toggle"]
        XCTAssertTrue(fastMode.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(app.descendants(matching: .any)["chat-fast-mode-hit-target"])
        self.assertMinimumTouchTarget(fastMode)
        self.waitForEnabled(fastMode)
        XCTAssertFalse(app.buttons["chat-fast-mode-use-default"].exists)
        fastMode.tap()
        self.waitForValue("1", of: fastMode)
        let fastModeDefault = app.buttons["chat-fast-mode-use-default"]
        XCTAssertTrue(fastModeDefault.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(fastModeDefault)
        self.waitForEnabled(fastModeDefault)
        self.attachScreenshot(named: "chat-actions-compact-controls")
        XCTAssertTrue(popover.exists)

        let verbosity = app.segmentedControls["chat-verbosity-control"]
        XCTAssertTrue(verbosity.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(app.descendants(matching: .any)["chat-verbosity-hit-target"])
        XCTAssertEqual(verbosity.buttons.count, 3)
        verbosity.buttons["Full"].tap()
        let verbosityDefault = app.buttons["chat-verbosity-use-default"]
        XCTAssertTrue(verbosityDefault.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(verbosityDefault)
        self.waitForEnabled(verbosityDefault)
        verbosityDefault.tap()
        XCTAssertTrue(verbosityDefault.waitForNonExistence(timeout: 5))
        let restoredVerbosity = app.segmentedControls["chat-verbosity-control"]
        XCTAssertTrue(restoredVerbosity.waitForExistence(timeout: 5))
        self.waitForEnabled(restoredVerbosity)
        let settledDefaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue((settledDefaultModel.value as? String)?.contains("Selected") == true)
        XCTAssertTrue(popover.exists)

        let toolDetails = app.staticTexts["Tool details"]
        let reasoning = app.buttons["chat-show-reasoning-toggle"]
        let backgroundTasks = popover.buttons["Background tasks"]
        XCTAssertTrue(toolDetails.exists)
        XCTAssertTrue(reasoning.exists)
        XCTAssertTrue(backgroundTasks.exists)
        XCTAssertGreaterThan(reasoning.frame.minY, toolDetails.frame.maxY)
        XCTAssertGreaterThanOrEqual(backgroundTasks.frame.minY, reasoning.frame.maxY)

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
        XCTAssertTrue(popover.waitForNonExistence(timeout: 3))
        let reopenedActions = app.buttons["Chat actions"]
        XCTAssertTrue(reopenedActions.waitForExistence(timeout: 5))
        self.waitForHittable(true, of: reopenedActions)
        reopenedActions.tap()
        let reopenedDefaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue(reopenedDefaultModel.waitForExistence(timeout: 5))
        XCTAssertEqual(reopenedDefaultModel.label, "Default: openai/gpt-5.6-sol")
        XCTAssertTrue((reopenedDefaultModel.value as? String)?.contains("Selected") == true)
        let reopenedThinkingSlider = app.sliders["chat-thinking-slider"]
        XCTAssertTrue(reopenedThinkingSlider.waitForExistence(timeout: 5))
        self.waitForValue(selectedThinkingValue, of: reopenedThinkingSlider)
        XCTAssertTrue(app.buttons["chat-thinking-use-default"].exists)
        let reopenedFastMode = app.switches["chat-fast-mode-toggle"]
        XCTAssertTrue(reopenedFastMode.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-fast-mode-use-default"].exists)
        XCTAssertFalse(app.buttons["chat-verbosity-use-default"].exists)

        let sidebarFrame = app.buttons["RootTabs.Sidebar.Show"].frame
        let thinkingHitTargetFrame = app.descendants(matching: .any)["chat-thinking-slider-hit-target"].frame
        let fastHitTargetFrame = app.descendants(matching: .any)["chat-fast-mode-hit-target"].frame
        let verbosityHitTargetFrame = app.descendants(matching: .any)["chat-verbosity-hit-target"].frame
        let receipt = XCTAttachment(string: [
            "header.sidebar=\(sidebarFrame)",
            "header.chatActions=\(reopenedActions.frame)",
            "provider.openai=collapsed-expanded-collapsed",
            "provider.anthropic=collapsed-expanded",
            "model.nonDefault=selected-with-trailing-checkmark",
            "model.default=restored-selected-with-trailing-checkmark",
            "thinking.stops=4;exercised=\(thinkingValues.joined(separator: ","));selected=\(selectedThinkingValue)",
            "thinking.hitTarget=\(thinkingHitTargetFrame)",
            "fast.hitTarget=\(fastHitTargetFrame)",
            "toolDetails.hitTarget=\(verbosityHitTargetFrame)",
            "reopen=thinking-and-fast-selected-tool-details-default",
        ].joined(separator: "\n"))
        receipt.name = "chat-actions-observations"
        receipt.lifetime = .keepAlways
        self.add(receipt)

        popover.buttons["New session options…"].tap()
        XCTAssertTrue(app.staticTexts["New Thread Options"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["No agents are available on this gateway."].exists)
        let create = app.buttons["Create"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        self.waitForEnabled(create)
        create.tap()
        XCTAssertTrue(app.staticTexts["New Thread Options"].waitForNonExistence(timeout: 5))
    }

    private func verifyApprovalNotificationsNavigation(fromOverview: Bool) async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_APPROVAL_FIXTURE_URL"] != nil,
            "Requires a task-owned synthetic Gateway approval fixture")
        let fixtureURL = try XCTUnwrap(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_APPROVAL_FIXTURE_URL"]
                .flatMap(URL.init(string:)),
            "Provide a task-owned synthetic Gateway approval fixture")
        let app = try self.launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        let (_, response) = try await URLSession.shared.data(from: fixtureURL.appendingPathComponent("approval"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        if app.buttons["Not Now"].waitForExistence(timeout: 8) {
            app.buttons["Not Now"].tap()
        }
        let approvalDialog = app.descendants(matching: .any)["exec-approval-review-scroll"]
        XCTAssertTrue(approvalDialog.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 8))
        app.buttons["Cancel"].tap()

        if fromOverview {
            try self.selectSidebarDestination("Overview")
            let approvals = app.buttons.containing(.staticText, identifier: "Pending approvals").firstMatch
            XCTAssertTrue(approvals.waitForExistence(timeout: 8))
            approvals.tap()
        } else {
            try self.selectSidebarDestination("Settings")
            let approvals = app.buttons.containing(.staticText, identifier: "Approvals").firstMatch
            XCTAssertTrue(approvals.waitForExistence(timeout: 8))
            approvals.tap()
        }

        let origin = fromOverview ? "overview" : "settings"
        let review = app.buttons["Review exec approval"].firstMatch
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        review.tap()
        XCTAssertTrue(app.staticTexts["Reviewing"].waitForExistence(timeout: 5))
        let notifications = app.buttons["Open Notifications"]
        XCTAssertTrue(notifications.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "\(origin)-approvals-before-notifications")
        notifications.tap()
        let reachedNotifications = app.navigationBars["Notifications"].waitForExistence(timeout: 8)
        self.attachScreenshot(named: "\(origin)-approvals-notifications-result")
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(origin)-approvals-notifications-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        XCTAssertTrue(
            reachedNotifications,
            "Open Notifications must open Dashboard notification settings from \(origin) Approvals")
        let dashboard = app.webViews.firstMatch
        XCTAssertTrue(
            dashboard.waitForExistence(timeout: 8),
            "Notification settings must render in the embedded Dashboard")
        XCTAssertTrue(dashboard.staticTexts["Notifications"].waitForExistence(timeout: 8))
        XCTAssertFalse(
            approvalDialog.exists,
            "The approval being reviewed must not cover Dashboard notification settings")
        let close = app.buttons["DashboardPage.Close"]
        XCTAssertTrue(close.exists)
        close.tap()
        XCTAssertTrue(notifications.waitForExistence(timeout: 5), "Done must return to Approvals")
        self.attachScreenshot(named: "\(origin)-approvals-after-back")
    }

    private func agentIdentity(in app: XCUIApplication) -> XCUIElement {
        app.otherElements.matching(identifier: "chat-agent-identity").firstMatch
    }

    private func readinessMarker(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)[Self.appReadinessAccessibilityIdentifier]
    }

    private func destinationAnchor(in app: XCUIApplication, destination: String) -> XCUIElement {
        switch destination {
        case "overview": app.staticTexts["Agent session"]
        case "chat": app.otherElements["chat-composer-surface"]
        case "agents": app.buttons["agent-status-filter-menu"]
        case "settings": app.descendants(matching: .any)["SettingsHub.Fallback"]
        case "gateway": app.navigationBars["Gateway"]
        default: self.readinessMarker(in: app)
        }
    }

    private func launchApp(
        for target: ScreenshotTarget,
        appearance: String? = "dark",
        screenshotMode: Bool = true,
        additionalArguments: [String] = [])
    {
        self.terminateCurrentApp()

        let app = self.configuredApp(
            for: target,
            appearance: appearance,
            screenshotMode: screenshotMode,
            additionalArguments: additionalArguments)
        app.launch()
        self.app = app
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        let readiness = self.readinessMarker(in: app)
        XCTAssertTrue(
            readiness.waitForExistence(timeout: 8),
            "OpenClaw root readiness marker did not appear")
        if screenshotMode {
            self.waitForValue("ready:\(target.initialDestination)", of: readiness, timeout: 8)
        }
    }

    private func configuredApp(
        for target: ScreenshotTarget,
        appearance: String?,
        screenshotMode: Bool,
        additionalArguments: [String]) -> XCUIApplication
    {
        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchArguments += [
            "--openclaw-initial-tab",
            target.initialTab,
            "--openclaw-initial-destination",
            target.initialDestination,
            "--openclaw-sidebar-visibility",
            "hidden",
            "--openclaw-ui-test-readiness",
        ]
        if screenshotMode {
            app.launchArguments.append("--openclaw-screenshot-mode")
        }
        app.launchArguments += additionalArguments
        if let appearance {
            app.launchArguments += ["--openclaw-appearance", appearance]
        }
        return app
    }

    private func captureReleaseScreenshot(
        _ target: ScreenshotTarget,
        beforeCapture: ((XCUIApplication) -> Void)? = nil)
    {
        self.launchApp(for: target)
        self.waitForReleaseScreenshotTarget(target)
        guard let app = self.app else {
            XCTFail("OpenClaw is not running for screenshot target \(target.name)")
            return
        }
        beforeCapture?(app)
        snapshot(target.name, timeWaitingForIdle: 5)
        self.attachScreenshot(named: target.name)
    }

    private func waitForReleaseScreenshotTarget(_ target: ScreenshotTarget) {
        guard let app = self.app else {
            XCTFail("OpenClaw is not running for screenshot target \(target.name)")
            return
        }
        let anchor = self.destinationAnchor(in: app, destination: target.initialDestination)
        XCTAssertTrue(
            anchor.waitForExistence(timeout: 8),
            "Screenshot target \(target.name) did not render its readiness anchor")
    }

    private func terminateCurrentApp(
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        guard let app = self.app else { return }
        app.terminate()
        XCTAssertTrue(
            app.wait(for: .notRunning, timeout: 5),
            "OpenClaw did not terminate before the next launch",
            file: file,
            line: line)
        self.app = nil
    }

    private func waitForValue(
        _ value: String,
        of element: XCUIElement,
        timeout: TimeInterval = 3)
    {
        XCTAssertTrue(self.element(element, hasValue: value, timeout: timeout))
    }

    private func assertMinimumTouchTarget(
        _ element: XCUIElement,
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        let minimum: CGFloat = 44
        // XCUI converts screen coordinates through floating-point transforms.
        // Permit rounding noise without accepting a genuinely undersized target.
        let tolerance = minimum.ulp * 16
        XCTAssertGreaterThanOrEqual(element.frame.width + tolerance, minimum, file: file, line: line)
        XCTAssertGreaterThanOrEqual(element.frame.height + tolerance, minimum, file: file, line: line)
    }

    private func assertNoHorizontalOverlap(
        _ elements: [XCUIElement],
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        let ordered = elements.sorted { $0.frame.minX < $1.frame.minX }
        for (left, right) in zip(ordered, ordered.dropFirst()) {
            XCTAssertLessThanOrEqual(
                left.frame.maxX,
                right.frame.minX + 0.5,
                "\(left.identifier) overlaps \(right.identifier)",
                file: file,
                line: line)
        }
    }

    private func element(_ element: XCUIElement, hasValue value: String, timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", value),
            object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForEnabled(_ element: XCUIElement) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "enabled == true"),
            object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed)
    }

    private func waitForHittable(_ isHittable: Bool, of element: XCUIElement) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "hittable == %@", NSNumber(value: isHittable)),
            object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed)
    }

    private func tapSidebarReveal(
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        let reveal = app.buttons["RootTabs.Sidebar.Show"]
        XCTAssertTrue(reveal.waitForExistence(timeout: 5), file: file, line: line)
        if reveal.isHittable {
            reveal.tap()
            return
        }

        // iOS 18 can mirror the nested SwiftUI button's accessibility frame
        // while the visible control remains at the navigation bar's leading edge.
        let navigationBar = app.navigationBars.firstMatch
        XCTAssertTrue(navigationBar.waitForExistence(timeout: 5), file: file, line: line)
        let appFrame = app.frame
        let navigationFrame = navigationBar.frame
        let coordinate = app.coordinate(withNormalizedOffset: CGVector(
            dx: (navigationFrame.minX + 38) / appFrame.width,
            dy: (navigationFrame.minY + 22) / appFrame.height))
        coordinate.tap()
    }

    private func openSidebarWithSlowEdgeDrag(
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let app = try XCTUnwrap(self.app, file: file, line: line)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.78, dy: 0.5))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.1)

        self.waitForHittable(true, of: app.buttons["RootTabs.Sidebar.Hide"])
    }

    private func closeSidebarWithSlowDrag(
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let app = try XCTUnwrap(self.app, file: file, line: line)
        // Start inside the exposed sidebar, not on the translated detail card.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.1)

        self.waitForHittable(true, of: app.buttons["RootTabs.Sidebar.Show"])
    }

    private func selectSidebarDestination(
        _ title: String,
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let app = try XCTUnwrap(self.app, file: file, line: line)
        let hideSidebar = app.buttons["RootTabs.Sidebar.Hide"]
        if !hideSidebar.isHittable {
            self.tapSidebarReveal(in: app, file: file, line: line)
            self.waitForHittable(true, of: hideSidebar)
        }

        let destination = app.buttons.matching(NSPredicate(
            format: "label == %@ OR label BEGINSWITH %@",
            title,
            "\(title),")).firstMatch
        XCTAssertTrue(destination.waitForExistence(timeout: 5), file: file, line: line)
        self.waitForHittable(true, of: destination)
        destination.tap()

        self.waitForHittable(false, of: hideSidebar)
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Show"].waitForExistence(timeout: 5), file: file, line: line)
    }

    private func startNewChatFromSidebar(
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let app = try XCTUnwrap(self.app, file: file, line: line)
        let hideSidebar = app.buttons["RootTabs.Sidebar.Hide"]
        if !hideSidebar.isHittable {
            self.tapSidebarReveal(in: app, file: file, line: line)
            self.waitForHittable(true, of: hideSidebar)
        }

        let newChat = app.buttons["New Chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 5), file: file, line: line)
        XCTAssertTrue(newChat.isEnabled, file: file, line: line)
        self.waitForHittable(true, of: newChat)
        newChat.tap()

        self.waitForHittable(false, of: hideSidebar)
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Show"].waitForExistence(timeout: 5), file: file, line: line)
    }

    private func launchPairedLiveGatewayApp(
        initialTab: String,
        initialDestination: String) throws -> XCUIApplication
    {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1",
            "Set OPENCLAW_IOS_LIVE_GATEWAY=1 and provide a fresh setup code")

        if let setupCode = ProcessInfo.processInfo.environment["OPENCLAW_IOS_LIVE_SETUP_CODE"] {
            UIPasteboard.general.string = setupCode
        }

        let app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments += [
            "--openclaw-reset-onboarding",
            "--openclaw-initial-tab",
            initialTab,
            "--openclaw-initial-destination",
            initialDestination,
        ]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 8))
        app.buttons["Connect Manually"].tap()

        let setupCodeField = app.textFields["Enter setup code"]
        XCTAssertTrue(setupCodeField.waitForExistence(timeout: 5))
        setupCodeField.tap()
        setupCodeField.press(forDuration: 1)
        XCTAssertTrue(app.menuItems["Paste"].waitForExistence(timeout: 3))
        app.menuItems["Paste"].tap()
        app.buttons["Apply"].tap()

        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 45))
        app.buttons["Go to Chat"].tap()
        return app
    }

    private func relaunchConnectedLiveGatewayApp(
        initialTab: String,
        initialDestination: String) -> XCUIApplication
    {
        self.app?.terminate()
        let app = XCUIApplication()
        app.launchArguments += [
            "--openclaw-initial-tab",
            initialTab,
            "--openclaw-initial-destination",
            initialDestination,
        ]
        app.launch()
        self.app = app
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        return app
    }

    private func sendLiveGatewayMessage(
        _ text: String,
        expecting replyMarker: String,
        in app: XCUIApplication)
    {
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText(text)

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        XCTAssertTrue(send.isEnabled)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        XCTAssertTrue(app.staticTexts[replyMarker].waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["Writing"].waitForNonExistence(timeout: 5))
    }

    private func openChatGatewaySettings(
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let actions = try XCTUnwrap(self.app?.buttons["Chat actions"], file: file, line: line)
        XCTAssertTrue(actions.waitForExistence(timeout: 8), file: file, line: line)
        actions.tap()

        let app = try XCTUnwrap(self.app, file: file, line: line)
        let gatewaySettings = app.buttons["chat-gateway-settings"]
        let actionsMenu = app.collectionViews.firstMatch
        for _ in 0..<3 {
            if gatewaySettings.waitForExistence(timeout: 1) { break }
            actionsMenu.swipeUp()
        }
        XCTAssertTrue(gatewaySettings.waitForExistence(timeout: 3), file: file, line: line)
        gatewaySettings.tap()
    }

    private func assertElementHasRenderedContent(
        _ element: XCUIElement,
        named name: String,
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        guard let app, let image = app.screenshot().image.cgImage else {
            XCTFail("App screenshot has no CGImage", file: file, line: line)
            return
        }

        let appFrame = app.frame
        let elementFrame = element.frame.intersection(appFrame)
        guard !elementFrame.isNull, elementFrame.width > 1, elementFrame.height > 1 else {
            XCTFail("\(name) has no visible screenshot region", file: file, line: line)
            return
        }

        let scaleX = CGFloat(image.width) / appFrame.width
        let scaleY = CGFloat(image.height) / appFrame.height
        let crop = CGRect(
            x: (elementFrame.minX - appFrame.minX) * scaleX,
            y: (elementFrame.minY - appFrame.minY) * scaleY,
            width: elementFrame.width * scaleX,
            height: elementFrame.height * scaleY).integral
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let cropped = image.cropping(to: crop), crop.width > 1, crop.height > 1 else {
            XCTFail("Could not crop screenshot for \(name)", file: file, line: line)
            return
        }

        let width = cropped.width
        let height = cropped.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else {
                return false
            }
            context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else {
            XCTFail("Could not render screenshot crop for \(name)", file: file, line: line)
            return
        }

        func luminance(at offset: Int) -> Int {
            (Int(pixels[offset]) * 299 + Int(pixels[offset + 1]) * 587 + Int(pixels[offset + 2]) * 114) / 1000
        }

        var contrastingEdges = 0
        var comparedEdges = 0
        for y in 0..<height {
            for x in 1..<width {
                let offset = (y * width + x) * 4
                let previousOffset = offset - 4
                if abs(luminance(at: offset) - luminance(at: previousOffset)) >= 12 {
                    contrastingEdges += 1
                }
                comparedEdges += 1
            }
        }

        XCTAssertGreaterThan(
            Double(contrastingEdges) / Double(max(1, comparedEdges)),
            0.002,
            "\(name) must contain rendered glyph edges, not only an accessibility frame",
            file: file,
            line: line)
    }

    private func assertChatCanvasIsNotSolidBlack(
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        guard let app, let image = app.screenshot().image.cgImage else {
            XCTFail("App screenshot has no CGImage", file: file, line: line)
            return
        }
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else {
                return false
            }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else {
            XCTFail("Could not render the chat screenshot", file: file, line: line)
            return
        }

        // The fixture leaves this canvas region empty. A pure-black host makes
        // both system scroll-edge effects collapse into hard black clipping.
        let sampleX = (width / 8)..<(width * 7 / 8)
        let sampleY = (height * 2 / 5)..<(height * 7 / 10)
        var layeredPixels = 0
        for y in sampleY {
            for x in sampleX {
                let offset = (y * width + x) * 4
                if pixels[offset] > 3 || pixels[offset + 1] > 3 || pixels[offset + 2] > 3 {
                    layeredPixels += 1
                }
            }
        }
        let sampledPixels = max(1, sampleX.count * sampleY.count)
        XCTAssertGreaterThan(
            Double(layeredPixels) / Double(sampledPixels),
            0.95,
            "Dark Chat must retain a layered canvas behind its translucent edge chrome",
            file: file,
            line: line)
    }

    private func sendFixtureChatMessage(_ text: String) {
        guard let app else {
            XCTFail("Fixture app is unavailable")
            return
        }
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText(text)

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        send.tap()

        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I can help with"))
                .firstMatch.waitForExistence(timeout: 5))
    }

    private func attachScreenshot(named name: String) {
        guard let app else { return }
        let screenshot = UIDevice.current.userInterfaceIdiom == .pad
            ? XCUIScreen.main.screenshot()
            : app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func chatMessageInput(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["chat-message-input"]
    }

    /// A burst of synthetic key events can drop a keystroke under simulator load, so one
    /// delete-per-character `typeText` does not reliably empty a field. Re-send against
    /// whatever is actually left instead of assuming the first burst landed in full.
    private func clearTextField(_ element: XCUIElement, attempts: Int = 4) {
        for _ in 0..<attempts {
            let value = element.value as? String ?? ""
            if value.isEmpty {
                return
            }
            element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
    }
}
