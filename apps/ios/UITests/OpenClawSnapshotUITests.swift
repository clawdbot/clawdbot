import UIKit
import XCTest

@MainActor
final class OpenClawSnapshotUITests: XCTestCase {
    private struct ScreenshotTarget {
        let initialTab: String
        let initialDestination: String
        let name: String
    }

    private static let screenshotTargets = [
        ScreenshotTarget(initialTab: "control", initialDestination: "overview", name: "01-control-connected"),
        ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "02-chat-connected"),
        ScreenshotTarget(initialTab: "talk", initialDestination: "talk", name: "03-talk-connected"),
        ScreenshotTarget(initialTab: "agent", initialDestination: "agents", name: "04-agent-connected"),
        ScreenshotTarget(initialTab: "settings", initialDestination: "settings", name: "05-settings-connected"),
    ]

    private var app: XCUIApplication?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        self.app?.terminate()
        self.app = nil
        try super.tearDownWithError()
    }

    func testConnectedGatewayTabs() {
        for target in Self.screenshotTargets {
            self.launchApp(for: target)
            snapshot(target.name, timeWaitingForIdle: 5)
            self.attachScreenshot(named: target.name)
        }
    }

    func testAutomationManagementScreenshot() {
        self.launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "cron",
            name: "automation-management"))

        XCTAssertTrue(self.app?.staticTexts["Release briefing"].waitForExistence(timeout: 8) == true)
        XCTAssertTrue(self.app?.staticTexts["Weekly project review"].exists == true)
        self.attachScreenshot(named: "automation-management")
    }

    func testSkillsManagementScreenshot() throws {
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "skills-management"))

        let skills = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Skills").firstMatch)
        XCTAssertTrue(skills.waitForExistence(timeout: 8))
        skills.tap()
        XCTAssertTrue(self.app?.staticTexts["github"].waitForExistence(timeout: 8) == true)
        XCTAssertTrue(self.app?.staticTexts["calendar"].exists == true)
        self.attachScreenshot(named: "skills-management")
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

    func testControlOverviewNavigation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone control hub only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "control",
            name: "control-overview-navigation"))

        let overview = self.app?.buttons.containing(.staticText, identifier: "Overview").firstMatch
        XCTAssertTrue(overview?.waitForExistence(timeout: 5) == true)
        overview?.tap()

        XCTAssertTrue(self.app?.navigationBars.buttons["Control"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Gateway settings"].waitForExistence(timeout: 5) == true)
        XCTAssertEqual(self.app?.state, .runningForeground)
    }

    func testLocationAlwaysWaitsForSlowSystemPermissionResponse() throws {
        XCUIApplication().resetAuthorizationStatus(for: .location)
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "location-always-slow-prompt"))

        let permissions = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Permissions").firstMatch)
        XCTAssertTrue(permissions.waitForExistence(timeout: 8))
        permissions.tap()

        let offMode = try XCTUnwrap(self.app?.buttons["Off"])
        if !offMode.isSelected {
            offMode.tap()
            XCTAssertTrue(offMode.isSelected)
        }
        let alwaysMode = try XCTUnwrap(self.app?.buttons["Always"])
        XCTAssertTrue(alwaysMode.waitForExistence(timeout: 5))
        alwaysMode.tap()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let prompt = springboard.alerts.firstMatch
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 3)
        XCTAssertTrue(prompt.exists)
        XCTAssertTrue(alwaysMode.isSelected)
        XCTAssertTrue(self.app?.staticTexts["Requesting iOS location permission…"].exists == true)
        self.attachFullScreenScreenshot(named: "location-always-first-prompt-after-3s")

        let firstAllow = prompt.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] 'While Using'")).firstMatch
        XCTAssertTrue(firstAllow.exists)
        firstAllow.tap()

        if prompt.waitForExistence(timeout: 5) {
            Thread.sleep(forTimeInterval: 3)
            XCTAssertTrue(prompt.exists)
            XCTAssertTrue(alwaysMode.isSelected)
            XCTAssertTrue(self.app?.staticTexts["Requesting iOS location permission…"].exists == true)
            self.attachFullScreenScreenshot(named: "location-always-upgrade-prompt-after-3s")

            let changeToAlways = prompt.buttons.matching(
                NSPredicate(format: "label CONTAINS[c] 'Change to Always'")).firstMatch
            XCTAssertTrue(changeToAlways.exists)
            changeToAlways.tap()
        }

        self.app?.activate()
        XCTAssertTrue(alwaysMode.waitForExistence(timeout: 5))
        XCTAssertTrue(alwaysMode.isSelected)
        XCTAssertFalse(self.app?.staticTexts["Requesting iOS location permission…"].exists == true)
        let backgroundAllowed = try XCTUnwrap(self.app?.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Background location requests")).firstMatch)
        XCTAssertTrue(backgroundAllowed.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)
        self.attachScreenshot(named: "location-always-granted-after-slow-prompt")
    }

    func testLocationWhileUsingStaysSelectedAfterSlowSystemPermissionResponse() throws {
        XCUIApplication().resetAuthorizationStatus(for: .location)
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "location-while-using-slow-prompt"))

        let permissions = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Permissions").firstMatch)
        XCTAssertTrue(permissions.waitForExistence(timeout: 8))
        permissions.tap()

        let offMode = try XCTUnwrap(self.app?.buttons["Off"])
        if !offMode.isSelected {
            offMode.tap()
            XCTAssertTrue(offMode.isSelected)
        }
        let whileUsingMode = try XCTUnwrap(self.app?.buttons["While Using"])
        XCTAssertTrue(whileUsingMode.waitForExistence(timeout: 5))
        whileUsingMode.tap()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let prompt = springboard.alerts.firstMatch
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 3)
        XCTAssertTrue(prompt.exists)
        XCTAssertTrue(whileUsingMode.isSelected)
        XCTAssertTrue(self.app?.staticTexts["Requesting iOS location permission…"].exists == true)

        let allow = prompt.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] 'While Using'")).firstMatch
        XCTAssertTrue(allow.exists)
        allow.tap()

        self.app?.activate()
        XCTAssertTrue(whileUsingMode.waitForExistence(timeout: 5))
        XCTAssertTrue(whileUsingMode.isSelected)
        XCTAssertFalse(self.app?.staticTexts["Requesting iOS location permission…"].exists == true)
        let foregroundAllowed = try XCTUnwrap(self.app?.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Foreground location requests")).firstMatch)
        XCTAssertTrue(foregroundAllowed.waitForExistence(timeout: 5))

        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "location-while-using-relaunch"))
        let relaunchedPermissions = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Permissions").firstMatch)
        XCTAssertTrue(relaunchedPermissions.waitForExistence(timeout: 8))
        relaunchedPermissions.tap()
        XCTAssertTrue(self.app?.buttons["While Using"].isSelected == true)
    }

    func testSettingsBackReturnsToOriginatingPhoneTab() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone settings navigation only")

        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-settings-back"))

        let gatewaySettings = try XCTUnwrap(self.app?.buttons["chat-gateway-status"])
        XCTAssertTrue(gatewaySettings.waitForExistence(timeout: 8))
        gatewaySettings.tap()
        let gatewayNavigationBar = try XCTUnwrap(self.app?.navigationBars["Gateway"])
        XCTAssertTrue(gatewayNavigationBar.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.tabBars.buttons["Chat"].isSelected == true)
        self.attachScreenshot(named: "chat-gateway-origin-stack")

        gatewayNavigationBar.buttons["BackButton"].tap()
        XCTAssertTrue(gatewaySettings.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.tabBars.buttons["Chat"].isSelected == true)
        self.attachScreenshot(named: "chat-after-settings-back")

        self.launchApp(for: ScreenshotTarget(
            initialTab: "talk",
            initialDestination: "talk",
            name: "talk-settings-back"))

        let voiceSettings = try XCTUnwrap(self.app?.buttons["talk-voice-settings-control"])
        for _ in 0..<3 where !voiceSettings.exists {
            self.app?.swipeUp()
        }
        XCTAssertTrue(voiceSettings.waitForExistence(timeout: 8))
        voiceSettings.tap()
        let voiceNavigationBar = try XCTUnwrap(self.app?.navigationBars["Voice & Talk"])
        XCTAssertTrue(voiceNavigationBar.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.tabBars.buttons["Talk"].isSelected == true)

        voiceNavigationBar.buttons["BackButton"].tap()
        XCTAssertTrue(voiceSettings.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.tabBars.buttons["Talk"].isSelected == true)
    }

    func testVoiceWakeResumesAfterTalkModeToggle() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Settings proof only")
        self.addUIInterruptionMonitor(withDescription: "Microphone and speech permissions") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "voice-wake-talk-lifecycle"))

        let voiceSettings = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Voice & Talk").firstMatch)
        XCTAssertTrue(voiceSettings.waitForExistence(timeout: 8))
        voiceSettings.tap()

        let voiceWake = try XCTUnwrap(self.app?.switches["Voice Wake"])
        let talkMode = try XCTUnwrap(self.app?.switches["Talk Mode"])
        XCTAssertTrue(voiceWake.waitForExistence(timeout: 5))
        XCTAssertTrue(talkMode.exists)

        if talkMode.value as? String == "1" {
            talkMode.tap()
        }
        if voiceWake.value as? String == "1" {
            voiceWake.tap()
        }

        voiceWake.tap()
        XCTAssertEqual(voiceWake.value as? String, "1")
        talkMode.tap()
        XCTAssertEqual(talkMode.value as? String, "1")
        talkMode.tap()
        XCTAssertEqual(talkMode.value as? String, "0")
        XCTAssertEqual(voiceWake.value as? String, "1")
        XCTAssertEqual(self.app?.state, .runningForeground)
        self.attachScreenshot(named: "voice-wake-after-talk-resume")

        let voiceNavigationBar = try XCTUnwrap(self.app?.navigationBars["Voice & Talk"])
        voiceNavigationBar.buttons["BackButton"].tap()
        let diagnostics = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Diagnostics").firstMatch)
        XCTAssertTrue(diagnostics.waitForExistence(timeout: 5))
        diagnostics.tap()
        let voiceWakeStatus = try XCTUnwrap(
            self.app?.descendants(matching: .any)["diagnostics-voice-wake-status"])
        XCTAssertTrue(voiceWakeStatus.waitForExistence(timeout: 5))
        let resumed = expectation(
            for: NSPredicate(
                format: "value == %@",
                "Voice Wake isn’t supported on Simulator"),
            evaluatedWith: voiceWakeStatus)
        wait(for: [resumed], timeout: 5)

        let diagnosticsNavigationBar = try XCTUnwrap(self.app?.navigationBars["Diagnostics"])
        diagnosticsNavigationBar.buttons["BackButton"].tap()
        voiceSettings.tap()
        XCTAssertTrue(voiceWake.waitForExistence(timeout: 5))
        voiceWake.tap()
        XCTAssertEqual(voiceWake.value as? String, "0")
    }

    func testChatComposerStartsCompactAndGrowsWithDraft() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone composer proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-composer-growth"))

        let textField = try XCTUnwrap(app?.textFields["chat-message-input"])
        XCTAssertTrue(textField.waitForExistence(timeout: 8))
        let talkButton = try XCTUnwrap(app?.buttons["chat-realtime-control"])
        XCTAssertTrue(talkButton.waitForExistence(timeout: 5))
        let attachmentButton = try XCTUnwrap(app?.buttons["chat-attachment-picker"])
        XCTAssertTrue(attachmentButton.waitForExistence(timeout: 5))
        let composerSurface = try XCTUnwrap(app?.otherElements["chat-composer-surface"])
        XCTAssertTrue(composerSurface.waitForExistence(timeout: 5))
        let gatewayStatus = try XCTUnwrap(app?.buttons["chat-gateway-status"])
        XCTAssertTrue(gatewayStatus.waitForExistence(timeout: 5))
        let sendButton = try XCTUnwrap(app?.buttons["chat-send-message"])
        XCTAssertFalse(sendButton.exists)
        XCTAssertLessThanOrEqual(attachmentButton.frame.maxX, composerSurface.frame.minX)
        XCTAssertLessThanOrEqual(composerSurface.frame.maxX, talkButton.frame.minX)
        XCTAssertGreaterThanOrEqual(attachmentButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(attachmentButton.frame.height, 44)
        XCTAssertGreaterThanOrEqual(talkButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(talkButton.frame.height, 44)
        let compactHeight = textField.frame.height
        XCTAssertLessThanOrEqual(compactHeight, 44)
        XCTAssertLessThanOrEqual(abs(talkButton.frame.midY - textField.frame.midY), 1)
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
        XCTAssertGreaterThanOrEqual(sendButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(sendButton.frame.height, 44)
        self.attachScreenshot(named: "chat-composer-expanded")

        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(self.app?.keyboards.firstMatch.waitForNonExistence(timeout: 3) == true)
    }

    func testChatPresentationInLightAppearance() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone chat proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-light"),
            appearance: "light")

        XCTAssertTrue(self.app?.buttons["chat-gateway-status"].waitForExistence(timeout: 8) == true)
        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].exists == true)
        self.attachScreenshot(named: "chat-light")
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
        setupSnapshot(app)
        app.launchArguments += [
            "--openclaw-reset-onboarding",
            "--openclaw-initial-tab",
            "settings",
            "--openclaw-initial-destination",
            "settings",
        ]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.staticTexts["Allow access"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()

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
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["Chat"].isSelected)
    }

    func testTalkUsesNativeControls() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Talk controls only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "talk",
            initialDestination: "talk",
            name: "talk-native-controls"))

        let speakerphone = try XCTUnwrap(app?.switches["talk-speakerphone-control"])
        let backgroundListening = try XCTUnwrap(app?.switches["talk-background-listening-control"])
        let voiceSettings = try XCTUnwrap(app?.buttons["talk-voice-settings-control"])
        for _ in 0..<3 where !speakerphone.exists {
            self.app?.swipeUp()
        }
        XCTAssertTrue(speakerphone.waitForExistence(timeout: 8))
        XCTAssertTrue(backgroundListening.exists)
        XCTAssertTrue(voiceSettings.exists)

        let originalValue = speakerphone.value as? String
        defer {
            if speakerphone.value as? String != originalValue {
                speakerphone.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            }
        }
        if originalValue == "0" {
            speakerphone.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            self.waitForValue("1", of: speakerphone)
        }
        XCTAssertEqual(speakerphone.value as? String, "1")
        self.attachScreenshot(named: "talk-native-controls")

        speakerphone.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        self.waitForValue("0", of: speakerphone)
    }

    func testAppearanceUsesSettingsRow() throws {
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "appearance-compact"), appearance: nil, screenshotMode: false)

        if self.app?.buttons["Close"].waitForExistence(timeout: 2) == true {
            self.app?.buttons["Close"].tap()
        }
        let row = try XCTUnwrap(self.app?.buttons["settings-appearance-row"])
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        XCTAssertFalse(self.app?.buttons["settings-appearance-menu"].exists == true)
        XCTAssertFalse(self.app?.segmentedControls["settings-appearance-picker"].exists == true)

        row.tap()
        let navigationBar = try XCTUnwrap(self.app?.navigationBars["Appearance"])
        XCTAssertTrue(navigationBar.waitForExistence(timeout: 3))
        let system = try XCTUnwrap(self.app?.buttons["settings-appearance-system"])
        let light = try XCTUnwrap(self.app?.buttons["settings-appearance-light"])
        let dark = try XCTUnwrap(self.app?.buttons["settings-appearance-dark"])
        XCTAssertTrue(system.exists)
        XCTAssertTrue(light.exists)
        XCTAssertTrue(dark.exists)
        if system.value as? String != "Selected" {
            system.tap()
            XCTAssertTrue(row.waitForExistence(timeout: 3))
            self.waitForValue("System", of: row)
            row.tap()
            XCTAssertTrue(navigationBar.waitForExistence(timeout: 3))
            self.waitForValue("Selected", of: system)
        }
        Thread.sleep(forTimeInterval: 1)
        self.attachScreenshot(named: "appearance-system")

        dark.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        self.waitForValue("Dark", of: row)
        self.assertDarkAppearanceTextVisible()
        self.attachScreenshot(named: "settings-dark")

        row.tap()
        XCTAssertTrue(navigationBar.waitForExistence(timeout: 3))
        system.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        self.waitForValue("System", of: row)
        Thread.sleep(forTimeInterval: 1)
        self.attachScreenshot(named: "appearance-system-restored")
    }

    func testChatReturnsToOriginatingControlDetail() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Control proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "activity",
            name: "control-chat-return"))

        let chatTab = try XCTUnwrap(self.app?.tabBars.buttons["Chat"])
        let controlTab = try XCTUnwrap(self.app?.tabBars.buttons["Control"])

        // Retain an embedded Chat Settings route, then prove contextual routing pops it.
        chatTab.tap()
        let gatewaySettings = try XCTUnwrap(self.app?.buttons["chat-gateway-status"])
        XCTAssertTrue(gatewaySettings.waitForExistence(timeout: 5))
        gatewaySettings.tap()
        XCTAssertTrue(self.app?.navigationBars["Gateway"].waitForExistence(timeout: 5) == true)

        controlTab.tap()
        XCTAssertTrue(self.app?.navigationBars["Control"].waitForExistence(timeout: 8) == true)
        let activity = try XCTUnwrap(self.app?.buttons["Activity"])
        XCTAssertTrue(activity.waitForExistence(timeout: 5))
        activity.tap()

        let recentActivity = try XCTUnwrap(self.app?.staticTexts["Recent activity"])
        XCTAssertTrue(recentActivity.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "control-activity-before-chat")

        let activityChat = try self.controlDetailChatButton(above: chatTab)
        activityChat.tap()
        XCTAssertTrue(chatTab.isSelected)

        let returnButton = try XCTUnwrap(self.app?.buttons["OpenClawChatBackToControlDetailButton"])
        XCTAssertTrue(returnButton.waitForExistence(timeout: 5))
        XCTAssertEqual(returnButton.label, "Back to Activity")
        self.attachScreenshot(named: "chat-return-to-activity")

        returnButton.tap()
        XCTAssertTrue(recentActivity.waitForExistence(timeout: 8))
        XCTAssertTrue(controlTab.isSelected)
        self.attachScreenshot(named: "control-activity-after-chat")

        try self.controlDetailChatButton(above: chatTab).tap()
        XCTAssertTrue(chatTab.isSelected)
        controlTab.tap()
        XCTAssertTrue(self.app?.navigationBars["Control"].waitForExistence(timeout: 8) == true)
        let overview = try XCTUnwrap(self.app?.buttons["Overview"])
        XCTAssertTrue(overview.exists)
        self.attachScreenshot(named: "control-tab-returns-to-root")

        overview.tap()
        XCTAssertTrue(self.app?.staticTexts["Agent session"].waitForExistence(timeout: 8) == true)
        let agentSession = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Molty").firstMatch)
        XCTAssertTrue(agentSession.waitForExistence(timeout: 8))
        agentSession.tap()

        XCTAssertTrue(returnButton.waitForExistence(timeout: 8))
        XCTAssertEqual(returnButton.label, "Back to Overview")
        self.attachScreenshot(named: "chat-session-return-to-overview")
        returnButton.tap()
        XCTAssertTrue(self.app?.navigationBars["Overview"].waitForExistence(timeout: 8) == true)
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
    }

    func testLiveGatewayFreshInstallSetupAndRelaunch() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone setup proof only")
        let app = try self.launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        XCTAssertEqual(app.state, .runningForeground)

        let controlApp = self.relaunchConnectedLiveGatewayApp(
            initialTab: "control",
            initialDestination: "control")
        let overview = controlApp.buttons.containing(.staticText, identifier: "Overview").firstMatch
        XCTAssertTrue(overview.waitForExistence(timeout: 8))
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
            initialDestination: "control")
        let overview = controlApp.buttons.containing(.staticText, identifier: "Overview").firstMatch
        XCTAssertTrue(overview.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "live-gateway-control")
        overview.tap()
        XCTAssertTrue(controlApp.navigationBars.buttons["Control"].waitForExistence(timeout: 8))
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
        XCTAssertTrue(app.staticTexts["Allow access"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 8))
        app.buttons["Connect Manually"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Home Network")).firstMatch.tap()
        app.buttons["Continue"].tap()

        let host = app.textFields["Host"]
        XCTAssertTrue(host.waitForExistence(timeout: 5))
        host.tap()
        host.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 32) + "localhost")

        let port = app.textFields["Port"]
        XCTAssertTrue(port.waitForExistence(timeout: 5))
        port.tap()
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + "18920")
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

    func testPhotosLimitedAccess() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_PHOTOS_E2E"] == "1",
            "Set OPENCLAW_IOS_PHOTOS_E2E=1 to exercise the system Photos prompt")
        addUIInterruptionMonitor(withDescription: "Photos access") { alert in
            for title in ["Limit Access…", "Select Photos…"] where alert.buttons[title].exists {
                alert.buttons[title].tap()
                return true
            }
            return false
        }
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "photos-limited-access"))

        let permissions = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Permissions").firstMatch)
        XCTAssertTrue(permissions.waitForExistence(timeout: 8))
        permissions.tap()

        let privacy = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Privacy & Access").firstMatch)
        XCTAssertTrue(privacy.waitForExistence(timeout: 8))
        privacy.tap()

        let request = try XCTUnwrap(self.app?.buttons["privacy-access-photos-action"])
        XCTAssertTrue(request.waitForExistence(timeout: 5))
        request.tap()
        self.app?.tap()

        // The limited picker is an out-of-process system surface without stable accessibility identifiers.
        // Normalized taps are confined to this opt-in simulator test; app-owned state proves completion below.
        let screen = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        screen.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.43)).tap()
        screen.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.16)).tap()

        self.app?.activate()
        let limitedStatus = try XCTUnwrap(self.app?.staticTexts.matching(
            NSPredicate(
                format: "identifier == %@ AND label == %@",
                "privacy-access-photos-status",
                "Limited")).firstMatch)
        XCTAssertTrue(limitedStatus.waitForExistence(timeout: 8))
        XCTAssertEqual(self.app?.buttons["privacy-access-photos-action"].label, "Manage Access")
        self.attachScreenshot(named: "photos-limited-access")
    }

    private func launchApp(
        for target: ScreenshotTarget,
        appearance: String? = "dark",
        screenshotMode: Bool = true,
        additionalArguments: [String] = [])
    {
        self.app?.terminate()

        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchArguments += [
            "--openclaw-initial-tab",
            target.initialTab,
            "--openclaw-initial-destination",
            target.initialDestination,
            "--openclaw-sidebar-visibility",
            "hidden",
        ]
        if screenshotMode {
            app.launchArguments.append("--openclaw-screenshot-mode")
        }
        app.launchArguments += additionalArguments
        if let appearance {
            app.launchArguments += ["--openclaw-appearance", appearance]
        }
        app.launch()
        self.app = app

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
    }

    private func waitForValue(_ value: String, of element: XCUIElement) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", value),
            object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 3), .completed)
    }

    private func controlDetailChatButton(above chatTab: XCUIElement) throws -> XCUIElement {
        let buttons = try XCTUnwrap(self.app?.buttons.matching(NSPredicate(format: "label == 'Chat'")))
        return try XCTUnwrap(buttons.allElementsBoundByIndex.first { $0.frame.maxY < chatTab.frame.minY })
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
        XCTAssertTrue(app.staticTexts["Allow access"].waitForExistence(timeout: 8))
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
        let input = app.textFields["chat-message-input"]
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

    private func assertDarkAppearanceTextVisible(
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
            XCTFail("Could not render the appearance screenshot", file: file, line: line)
            return
        }

        // Sample the full List content, excluding navigation/tab chrome. The regression left
        // entire labels transparent while isolated row crops could still look healthy.
        let sampleX = (width / 12)..<(width * 11 / 12)
        let sampleY = (height / 8)..<(height * 4 / 5)
        var brightPixels = 0
        for y in sampleY {
            for x in sampleX {
                let offset = (y * width + x) * 4
                if pixels[offset] > 190, pixels[offset + 1] > 190, pixels[offset + 2] > 190 {
                    brightPixels += 1
                }
            }
        }
        let sampledPixels = max(1, sampleX.count * sampleY.count)
        XCTAssertGreaterThan(
            Double(brightPixels) / Double(sampledPixels),
            0.002,
            "Dark appearance must keep the settings labels visibly light",
            file: file,
            line: line)
    }

    private func attachScreenshot(named name: String) {
        guard let app else { return }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachFullScreenScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
