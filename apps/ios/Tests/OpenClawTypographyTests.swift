import CoreText
import Foundation
import Testing
import UIKit
@testable import OpenClaw

struct OpenClawTypographyTests {
    @Test func `session controls use branded typography`() throws {
        let support = try String(
            contentsOf: Self.sourceURL("Design/CommandCenterSupport.swift"),
            encoding: .utf8)
        let commandCenter = try String(
            contentsOf: Self.sourceURL("Design/CommandCenterTab.swift"),
            encoding: .utf8)

        #expect(support.contains("TextField(self.editorPlaceholder"))
        #expect(support.contains("Label(\"Move to Group\""))
        #expect(support.contains("Label(\"Delete…\""))
        #expect(support.contains(".font(OpenClawType.subhead)"))
        #expect(support.contains(".font(OpenClawType.subheadSemiBold)"))
        #expect(commandCenter.contains("Toggle(isOn: self.$showArchived)"))
        #expect(commandCenter.contains("Text(\"Show Archived\")"))
        #expect(commandCenter.contains(".font(OpenClawType.captionMedium)"))
    }

    @Test func `bundled fonts load from app bundle`() {
        for name in OpenClawType.registeredPostScriptNames {
            #expect(UIFont(name: name, size: 12) != nil, "Missing bundled font: \(name)")
        }
    }

    @Test func `dynamic type scales display fonts`() {
        guard let base = UIFont(name: "RedHatDisplay-Regular", size: 34) else {
            Issue.record("RedHatDisplay-Regular should be bundled")
            return
        }

        let defaultTraits = UITraitCollection(preferredContentSizeCategory: .large)
        let largeTraits = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
        let metrics = UIFontMetrics(forTextStyle: .largeTitle)

        let defaultSize = metrics.scaledFont(for: base, compatibleWith: defaultTraits).pointSize
        let largeSize = metrics.scaledFont(for: base, compatibleWith: largeTraits).pointSize

        #expect(largeSize > defaultSize)
    }

    @Test func `display variable weight axis instantiates heavy weights`() {
        guard UIFont(name: "RedHatDisplay-Regular", size: 15) != nil else {
            Issue.record("RedHatDisplay-Regular should be bundled")
            return
        }

        let weightAxis = NSNumber(value: 2_003_265_652) // "wght"
        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: "RedHatDisplay-Regular",
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [weightAxis: 900],
        ])
        let font = UIFont(descriptor: descriptor, size: 15)
        let variations = font.fontDescriptor.object(
            forKey: kCTFontVariationAttribute as UIFontDescriptor.AttributeName) as? [NSNumber: Any]
        let weightValue = variations?[weightAxis] as? NSNumber

        #expect(weightValue?.doubleValue == 900)
    }

    @Test func `app extensions register bundled branded fonts`() throws {
        let project = try String(contentsOf: Self.projectYmlURL(), encoding: .utf8)
        let activityPlist = try String(contentsOf: Self.activityWidgetInfoPlistURL(), encoding: .utf8)
        let watchPlist = try String(contentsOf: Self.watchInfoPlistURL(), encoding: .utf8)

        for targetName in ["OpenClawActivityWidget", "OpenClawWatchApp"] {
            let target = try Self.extract(
                project,
                from: "  \(targetName):",
                to: targetName == "OpenClawActivityWidget" ? "  OpenClawWatchApp:" : "  OpenClawTests:")
            #expect(target.contains("- path: Sources/Fonts"))
            #expect(target.contains("UIAppFonts:"))
            for font in Self.bundledFontFiles {
                #expect(target.contains("- \(font)"))
            }
        }

        for plist in [activityPlist, watchPlist] {
            #expect(plist.contains("<key>UIAppFonts</key>"))
            for font in Self.bundledFontFiles {
                #expect(plist.contains("<string>\(font)</string>"))
            }
        }
    }

    @Test func `extension text surfaces use branded typography helpers`() throws {
        let activityTypeSource = try String(contentsOf: Self.activityWidgetTypographySourceURL(), encoding: .utf8)
        let activitySource = try String(contentsOf: Self.activityWidgetSourceURL(), encoding: .utf8)
        let watchTypeSource = try String(contentsOf: Self.watchTypographySourceURL(), encoding: .utf8)
        let watchSource = try String(contentsOf: Self.watchInboxSourceURL(), encoding: .utf8)

        #expect(activityTypeSource.contains("relativeTo: .subheadline"))
        #expect(activityTypeSource.contains("relativeTo: .caption"))
        #expect(!activityTypeSource.contains(".custom(\"RedHatDisplay-Regular\", size: size).weight"))
        #expect(!activityTypeSource.contains(".custom(\"Inter-Regular\", size: size)"))
        #expect(activitySource.contains("OpenClawActivityType.subheadSemiBold"))
        #expect(activitySource.contains("OpenClawActivityType.subheadBold"))
        #expect(activitySource.contains("OpenClawActivityType.caption"))
        #expect(!activitySource.contains(".font(.subheadline"))
        #expect(!activitySource.contains(".font(.caption"))

        #expect(watchTypeSource.contains("relativeTo textStyle: Font.TextStyle"))
        #expect(watchTypeSource.contains("body(size: 12, weight: .semibold, relativeTo: .caption)"))
        #expect(watchTypeSource.contains("body(size: 12, weight: .bold, relativeTo: .caption)"))
        #expect(watchTypeSource.contains("body(size: 11, relativeTo: .caption2)"))
        #expect(watchTypeSource.contains("relativeTo: .caption2"))
        #expect(watchTypeSource.contains("relativeTo: .headline"))
        #expect(!watchTypeSource.contains(".custom(\"RedHatDisplay-Regular\", size: size).weight"))
        #expect(!watchTypeSource.contains(".custom(\"Inter-Regular\", size: size).weight"))
        #expect(watchSource.contains("WatchClawType.title"))
        #expect(watchSource.contains("WatchClawType.body"))
        #expect(watchSource.contains("WatchClawType.caption"))
        #expect(!watchSource.contains(".font(.system"))
        #expect(!watchSource.contains(".font(.caption"))
        #expect(!watchSource.contains(".font(.title"))
    }

    @Test func `UIKit typography refreshes when Dynamic Type changes`() throws {
        let appSource = try String(contentsOf: Self.appSourceURL(), encoding: .utf8)
        let typographySource = try String(
            contentsOf: Self.sourceURL("Design/OpenClawTypography.swift"),
            encoding: .utf8)

        #expect(appSource.contains("UIContentSizeCategory.didChangeNotification"))
        #expect(appSource.contains("OpenClawType.refreshUIKitAppearance(in: Self.connectedWindows())"))
        #expect(typographySource.contains("static func refreshUIKitAppearance(in windows: [UIWindow])"))
        #expect(typographySource.contains("applyUIKitTypography(fonts, to: window)"))
        #expect(typographySource.contains("maximumPointSize: 13"))
        #expect(typographySource.contains("maximumPointSize: 16"))
        #expect(typographySource.contains("maximumPointSize: 22"))
        #expect(typographySource.contains("maximumPointSize: 44"))
        #expect(typographySource.contains("scaledFont(for: base, maximumPointSize: maximumPointSize)"))
        #expect(typographySource.contains("case let searchTextField as UISearchTextField"))
        #expect(!typographySource.contains("case let textField as UITextField"))
        #expect(!typographySource.contains("case let textView as UITextView"))
    }

    @Test func `listed iOS app surfaces enforce branded control typography`() throws {
        let proComponents = try String(
            contentsOf: Self.sourceURL("Design/OpenClawProComponents.swift"),
            encoding: .utf8)
        let quickSetup = try String(contentsOf: Self.sourceURL("Gateway/GatewayQuickSetupSheet.swift"), encoding: .utf8)
        let gatewayProblem = try String(contentsOf: Self.sourceURL("Gateway/GatewayProblemView.swift"), encoding: .utf8)
        let onboardingSteps = try String(
            contentsOf: Self.sourceURL("Onboarding/OnboardingWizardSteps.swift"),
            encoding: .utf8)
        let onboardingWizard = try [
            "Onboarding/OnboardingWizardView.swift",
            "Onboarding/OnboardingWizardConnectionSections.swift",
            "Onboarding/OnboardingWizardTypes.swift",
        ].map { path in
            try String(contentsOf: Self.sourceURL(path), encoding: .utf8)
        }.joined(separator: "\n")
        let settingsSections = try String(
            contentsOf: Self.sourceURL("Design/SettingsProTabSections.swift"),
            encoding: .utf8)
        let settingsSupport = try String(
            contentsOf: Self.sourceURL("Design/SettingsProTabSupport.swift"),
            encoding: .utf8)
        let approvalDialog = try String(
            contentsOf: Self.sourceURL("Gateway/ExecApprovalPromptDialog.swift"),
            encoding: .utf8)
        let privacyAccess = try String(
            contentsOf: Self.sourceURL("Settings/PrivacyAccessSectionView.swift"),
            encoding: .utf8)
        let skillWorkshop = try String(
            contentsOf: Self.sourceURL("Design/IPadSkillWorkshopScreen.swift"),
            encoding: .utf8)
        let agentDestinations = try String(
            contentsOf: Self.sourceURL("Design/AgentProTab+Destinations.swift"),
            encoding: .utf8)
        let dreaming = try String(
            contentsOf: Self.sourceURL("Design/AgentProDreamingDestination.swift"),
            encoding: .utf8)
        let instances = try String(contentsOf: Self.sourceURL("Design/AgentProNodesDestination.swift"), encoding: .utf8)
        let channels = try String(
            contentsOf: Self.sourceURL("Design/SettingsChannelsDestination.swift"),
            encoding: .utf8)
        let skills = try String(
            contentsOf: Self.sourceURL("Design/SettingsSkillsDestination.swift"),
            encoding: .utf8)
        let automations = try String(
            contentsOf: Self.sourceURL("Design/AgentAutomationDetailScreen.swift"),
            encoding: .utf8)
        let docs = try String(contentsOf: Self.sourceURL("Design/OpenClawDocsScreen.swift"), encoding: .utf8)
        let chatTab = try String(contentsOf: Self.sourceURL("Design/ChatProTab.swift"), encoding: .utf8)
        let chatTypography = try String(
            contentsOf: Self.iosRootURL()
                .deletingLastPathComponent()
                .appendingPathComponent("shared/OpenClawKit/Sources/OpenClawChatUI/ChatTypography.swift"),
            encoding: .utf8)
        let chatMessageViews = try String(
            contentsOf: Self.iosRootURL()
                .deletingLastPathComponent()
                .appendingPathComponent("shared/OpenClawKit/Sources/OpenClawChatUI/ChatMessageViews.swift"),
            encoding: .utf8)
        let chatMarkdownRenderer = try String(
            contentsOf: Self.iosRootURL()
                .deletingLastPathComponent()
                .appendingPathComponent("shared/OpenClawKit/Sources/OpenClawChatUI/ChatMarkdownRenderer.swift"),
            encoding: .utf8)

        #expect(automations.contains(".font(OpenClawType.body)"))
        #expect(automations.contains(".font(OpenClawType.headline)"))
        #expect(automations.contains(".font(OpenClawType.subheadSemiBold)"))
        #expect(automations.contains(".font(OpenClawType.caption)"))
        #expect(!automations.contains(".font(.body"))
        #expect(!automations.contains(".font(.headline"))
        #expect(!automations.contains(".font(.caption"))

        #expect(proComponents.contains(".font(OpenClawType.subheadSemiBold)"))
        #expect(proComponents.contains("primaryActionTitle.text"))
        #expect(proComponents.contains("secondaryActionTitle.text"))

        #expect(chatTab.contains("Text(\"Export Transcript\")"))
        #expect(chatTab.contains(".font(OpenClawType.body)"))
        #expect(!chatTab.contains("Button(\"Export Transcript\")"))

        #expect(!quickSetup.contains("Button(\"Close\")"))
        #expect(quickSetup.contains(".navigationTitle(\"Quick Setup\")"))
        #expect(quickSetup.contains("Text(\"Close\")"))
        #expect(quickSetup.contains(".font(OpenClawType.subheadSemiBold)"))
        #expect(quickSetup.contains("let text: LocalizedStringKey"))
        #expect(!quickSetup.contains("Text(verbatim: self.text)"))

        #expect(gatewayProblem.contains("Text(\"Connection problem\")"))
        #expect(gatewayProblem.contains("Text(\"Copy request ID\")"))
        #expect(gatewayProblem.contains("Text(\"Copy command\")"))
        #expect(gatewayProblem.contains(".font(OpenClawType.subheadSemiBold)"))

        #expect(onboardingSteps.contains("title: \"Connect Gateway\""))
        #expect(onboardingSteps.contains("Text(\"Scan QR\")"))
        #expect(onboardingSteps.contains("Text(\"Connect Manually\")"))
        #expect(onboardingSteps.contains("Label(\"Go to Chat\", systemImage: \"bubble.left.and.bubble.right.fill\")"))
        #expect(onboardingSteps.contains(".font(OpenClawType.subheadSemiBold)"))
        #expect(onboardingSteps.contains("let title: LocalizedStringKey"))
        #expect(onboardingSteps.contains("let subtitle: LocalizedStringKey?"))
        #expect(onboardingSteps.contains("let text: LocalizedStringKey"))

        #expect(onboardingWizard.contains("Text(\"Scan Setup Code\")")
            || onboardingWizard.contains(".navigationTitle(\"Scan Setup Code\")"))
        #expect(onboardingWizard.contains("Label(\"Resume After Approval\", systemImage: \"arrow.clockwise\")"))
        #expect(onboardingWizard.contains("Label(\"Scan Setup Code Again\", systemImage: \"qrcode.viewfinder\")"))
        #expect(onboardingWizard.contains("Text(\"Apply\")"))
        #expect(onboardingWizard.contains(".font(OpenClawType.subheadSemiBold)"))
        #expect(onboardingWizard.contains("_ title: LocalizedStringKey"))
        #expect(onboardingWizard.contains("_ placeholder: LocalizedStringKey"))
        #expect(onboardingWizard.contains("if self.developerModeEnabled.wrappedValue {"))
        #expect(onboardingWizard.contains("title: \"Same Machine (Dev)\""))
        #expect(onboardingWizard.contains("if lastMode == .developerLocal"))
        #expect(onboardingWizard.contains("self.developerModeEnabled = true"))
        let onboardingSecurityPicker = try Self.extract(
            onboardingWizard,
            from: "private var manualConnectionSecurityRows",
            to: "    private func onboardingLabeledContent")
        let onboardingUnencryptedOption = try Self.extract(
            onboardingSecurityPicker,
            from: "Text(\"Unencrypted\")",
            to: ".tag(false)")
        let onboardingSecureOption = try Self.extract(
            onboardingSecurityPicker,
            from: "Text(\"Secure (TLS)\")",
            to: ".tag(true)")
        #expect(onboardingUnencryptedOption.contains(".font(OpenClawType.captionSemiBold)"))
        #expect(onboardingSecureOption.contains(".font(OpenClawType.captionSemiBold)"))

        #expect(settingsSections.contains(".font(OpenClawType.body)"))
        #expect(settingsSections.contains("Text(warningText)"))
        #expect(settingsSections.contains(".font(OpenClawType.caption)"))
        #expect(approvalDialog.contains("Text(warningText)"))
        #expect(approvalDialog.contains(".font(OpenClawType.footnote)"))
        #expect(approvalDialog.contains("ScrollView {"))
        #expect(approvalDialog.contains("self.actionFooter"))
        #expect(approvalDialog.contains("exec-approval-review-scroll"))
        #expect(approvalDialog.contains("exec-approval-actions"))
        #expect(approvalDialog.contains("ViewThatFits(in: .horizontal)"))
        #expect(settingsSections.contains("self.settingsToggle(\"Show Talk Control\", isOn: self.$talkButtonEnabled)"))
        #expect(settingsSections.contains("OpenClawToggleIndicator(isOn: isOn.wrappedValue)"))
        #expect(settingsSections.contains("TextField(\"Default Share Instruction\""))
        #expect(settingsSections.contains(".font(OpenClawType.subhead)"))
        #expect(settingsSections.contains("private struct AppearanceSettingsScreen"))
        #expect(settingsSections.contains("Section(\"Gateway\")"))
        #expect(settingsSections.contains("SettingsDetailRow(\"Address\", value: .verbatim(self.gatewayAddress))"))
        #expect(settingsSections.contains("func gatewayActionButton"))
        #expect(settingsSections.contains("func settingsToggle"))
        #expect(settingsSections.contains(".font(OpenClawType.subheadSemiBold)"))
        #expect(settingsSupport.contains("struct SettingsBuildMetadataStrip"))
        #expect(settingsSupport.contains(".font(OpenClawType.caption2SemiBold)"))
        #expect(settingsSupport.contains(".font(OpenClawType.monoSmall)"))
        #expect(settingsSupport.contains("Text(\"Copy Build Info\")"))
        #expect(settingsSections.contains("Text(\"Use Manual Gateway\")")
            || settingsSections.contains("\"Use Manual Gateway\""))
        #expect(settingsSections.contains("func gatewaySecureField"))
        #expect(settingsSections.contains("self.gatewaySecureField(\"Gateway Auth Token\""))
        #expect(settingsSections.contains("self.gatewaySecureField(\"Gateway Password\""))
        let gatewaySecureField = try Self.extract(
            settingsSections,
            from: "func gatewaySecureField",
            to: "    var voiceFeatureCard")
        #expect(gatewaySecureField.contains(".accessibilityLabel(Text(placeholder))"))
        #expect(gatewaySecureField.contains(".accessibilityHidden(true)"))
        #expect(gatewaySecureField.contains(".textInputAutocapitalization(.never)"))
        #expect(gatewaySecureField.contains(".autocorrectionDisabled()"))
        #expect(settingsSections.contains("Picker(\"Default Agent\", selection: self.$selectedAgentPickerId)"))
        #expect(settingsSections.contains("Text(\"Default\")"))
        let settingsSecurityPicker = try Self.extract(
            settingsSections,
            from: "Picker(selection: self.manualGatewayTLSBinding)",
            to: "            .pickerStyle(.segmented)")
        let settingsUnencryptedOption = try Self.extract(
            settingsSecurityPicker,
            from: "Text(\"Unencrypted\")",
            to: ".tag(false)")
        let settingsSecureOption = try Self.extract(
            settingsSecurityPicker,
            from: "Text(\"Secure (TLS)\")",
            to: ".tag(true)")
        #expect(settingsUnencryptedOption.contains(".font(OpenClawType.captionSemiBold)"))
        #expect(settingsSecureOption.contains(".font(OpenClawType.captionSemiBold)"))

        #expect(!privacyAccess.contains("DisclosureGroup(\"Privacy & Access\")"))
        #expect(privacyAccess.contains("Text(\"Privacy & Access\")"))
        let permissionRow = try String(
            contentsOf: Self.sourceURL("Permissions/DevicePermissionRow.swift"),
            encoding: .utf8)
        #expect(permissionRow.contains("Text(actionTitle)"))
        #expect(permissionRow.contains(".font(OpenClawType.footnoteSemiBold)"))

        #expect(!skillWorkshop.contains("Button(\"Done\")"))
        #expect(skillWorkshop.contains("Label(\"Refresh\", systemImage: \"arrow.clockwise\")"))
        #expect(skillWorkshop.contains("Text(\"Default agent\")"))
        #expect(skillWorkshop.contains("Text(\"Inspect\")"))
        #expect(skillWorkshop.contains("Text(\"Apply\")"))
        #expect(skillWorkshop.contains("Text(\"Reject\")"))

        #expect(skills.contains("Text(\"Gateway warning\").font(OpenClawType.headline)"))
        #expect(skills.contains("Text(\"Acknowledge and install\").font(OpenClawType.subheadSemiBold)"))
        #expect(skills.contains("prompt: Text(\"Search ClawHub\").font(OpenClawType.body)"))

        for source in [agentDestinations, dreaming, instances, channels, skills, docs] {
            #expect(source.contains(".font(OpenClawType.body)"))
        }

        #expect(chatMessageViews.contains("font: OpenClawChatTypography.body"))
        #expect(chatMessageViews.contains("OpenClawChatTypography.callout.italic()"))
        #expect(!chatMessageViews.contains("font: .body"))
        #expect(!chatMessageViews.contains("Font.body"))
        #expect(!chatMessageViews.contains("Font.callout"))
        #expect(chatMarkdownRenderer.contains(".font(self.font)"))
        #expect(chatTypography
            .contains("Font.custom(self.macSystemFontName(size: size), size: size, relativeTo: textStyle)"))
        #expect(chatTypography.contains(
            "Font.custom(self.macMonospacedSystemFontName(size: size), size: size, relativeTo: textStyle)"))
        #expect(!chatTypography.contains("Font.system(textStyle, design: .default)"))
        #expect(!chatTypography.contains("Font.system(textStyle, design: .monospaced)"))
    }

    @Test func `iOS app text and control calls keep branded font boundaries`() throws {
        let offenders = try Self.unbrandedTextCallOffenders()
        #expect(offenders.isEmpty, Comment(rawValue: offenders.joined(separator: "\n")))
    }

    @Test func `accessibility metadata text does not require visual typography`() throws {
        let accessibilityTextSamples = [
            ".accessibilityLabel(Text(title))",
            "Image(systemName: \"circle\").accessibilityLabel(Text(title))",
            ".accessibilityLabel(Text(title)).accessibilityIdentifier(\"status\")",
            "Image(systemName: \"circle\").accessibilityLabel(Text(title)).accessibilityHint(Text(hint))",
            ".accessibilityLabel(Text(self.statusLabel ?? LocalizedStringResource(\"Allowed\")))",
            ".accessibilityLabel(Text(title))\n)",
            ".accessibilityLabel(\n    Text(title)\n)",
            "Image(systemName: \"circle\")\n    .accessibilityLabel(\n        Text(title)\n    )",
            ".accessibilityValue(\n    Text(value))",
            ".accessibilityHint(\n\n    Text(hint))",
        ]
        for source in accessibilityTextSamples {
            let lines = source.components(separatedBy: .newlines)
            let idx = try #require(lines.firstIndex { Self.isTextOrLabelCall($0) })
            #expect(Self.isAccessibilityMetadataTextCall(at: idx, in: lines))
        }

        #expect(!Self.isAccessibilityMetadataTextCall(at: 0, in: ["Text(title)"]))
        #expect(!Self.isAccessibilityMetadataTextCall(at: 0, in: [".accessibilityLabel(title)"]))

        let nearbyVisualText = [
            ".accessibilityLabel(Text(title))",
            "Text(body)",
        ]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 1, in: nearbyVisualText))

        let sameLineVisualLabel = [
            "Label(\"Status\", systemImage: \"circle\").accessibilityLabel(Text(status))",
        ]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 0, in: sameLineVisualLabel))

        let trailingVisualText = [".accessibilityLabel(Text(status)); Text(body)"]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 0, in: trailingVisualText))

        let modifierTextInString = [
            "let sample = \".accessibilityLabel(\"",
            "Text(body)",
        ]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 1, in: modifierTextInString))

        let modifierTextInComment = [
            "// Example: .accessibilityLabel(",
            "Text(body)",
        ]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 1, in: modifierTextInComment))
    }

    @Test func `secure fields do not use platform placeholder text`() throws {
        let offenders = try Self.swiftSourcesForTypographyAudit().flatMap { url -> [String] in
            let source = try String(contentsOf: url, encoding: .utf8)
            return source
                .components(separatedBy: .newlines)
                .enumerated()
                .compactMap { offset, line in
                    guard line.range(
                        of: #"\bSecureField\("[^"]+""#,
                        options: .regularExpression) != nil
                    else { return nil }
                    return "\(Self.relativePath(url)):\(offset + 1): \(line.trimmingCharacters(in: .whitespaces))"
                }
        }
        #expect(offenders.isEmpty, Comment(rawValue: offenders.joined(separator: "\n")))
    }

    private static let bundledFontFiles = [
        "RedHatDisplay[wght].ttf",
        "Inter[opsz,wght].ttf",
        "Inter-Italic[opsz,wght].ttf",
        "JetBrainsMono-Regular.ttf",
        "JetBrainsMono-Medium.ttf",
        "JetBrainsMono-SemiBold.ttf",
    ]

    private static func projectYmlURL() -> URL {
        self.iosRootURL().appendingPathComponent("project.yml")
    }

    private static func activityWidgetInfoPlistURL() -> URL {
        self.iosRootURL().appendingPathComponent("ActivityWidget/Info.plist")
    }

    private static func watchInfoPlistURL() -> URL {
        self.iosRootURL().appendingPathComponent("WatchApp/Info.plist")
    }

    private static func activityWidgetSourceURL() -> URL {
        self.iosRootURL().appendingPathComponent("ActivityWidget/OpenClawLiveActivity.swift")
    }

    private static func activityWidgetTypographySourceURL() -> URL {
        self.iosRootURL().appendingPathComponent("ActivityWidget/OpenClawActivityTypography.swift")
    }

    private static func watchInboxSourceURL() -> URL {
        self.iosRootURL().appendingPathComponent("WatchApp/Sources/WatchInboxView.swift")
    }

    private static func watchTypographySourceURL() -> URL {
        self.iosRootURL().appendingPathComponent("WatchApp/Sources/WatchClawTypography.swift")
    }

    private static func appSourceURL() -> URL {
        self.sourceURL("OpenClawApp.swift")
    }

    private static func sourceURL(_ relativePath: String) -> URL {
        self.iosRootURL().appendingPathComponent("Sources/\(relativePath)")
    }

    private static func swiftSourcesForTypographyAudit() throws -> [URL] {
        let roots = [
            self.sourceURL(""),
            self.iosRootURL()
                .deletingLastPathComponent()
                .appendingPathComponent("shared/OpenClawKit/Sources/OpenClawChatUI"),
        ]
        return roots.flatMap { root -> [URL] in
            guard let enumerator = FileManager.default.enumerator(
                at: root,
                includingPropertiesForKeys: nil)
            else { return [] }
            return enumerator.compactMap { item -> URL? in
                guard let url = item as? URL, url.pathExtension == "swift" else { return nil }
                return url
            }
        }
        .sorted { $0.path < $1.path }
    }

    private static func unbrandedTextCallOffenders() throws -> [String] {
        let fontTokens = ["OpenClawType", "OpenClawChatTypography"]
        // Accessibility-only Text is spoken, never rendered, so no branded font applies.
        let allowedFragments = [".navigationTitle(", ".alert(\"", ".tabItem { Label("]
        return try self.swiftSourcesForTypographyAudit().flatMap { url -> [String] in
            let source = try String(contentsOf: url, encoding: .utf8)
            let lines = source.components(separatedBy: .newlines)
            let accessibilityMetadataTextLines = self.accessibilityMetadataTextLines(in: lines)
            return lines.indices.compactMap { idx -> String? in
                let rawLine = lines[idx]
                let line = rawLine.trimmingCharacters(in: .whitespaces)
                guard !line.hasPrefix("//") else { return nil }
                guard !allowedFragments.contains(where: rawLine.contains) else { return nil }

                let window = lines[idx..<min(lines.count, idx + 12)].joined(separator: "\n")
                let hasLocalFont = fontTokens.contains { window.contains($0) }
                    || self.hasAllowedBrandedFontParameter(window, line: rawLine, in: url)

                if self.isTextOrLabelCall(rawLine),
                   !accessibilityMetadataTextLines.contains(idx),
                   !hasLocalFont
                {
                    return "\(self.relativePath(url)):\(idx + 1): \(line)"
                }

                if self.isShorthandControlCall(rawLine), !hasLocalFont {
                    return "\(self.relativePath(url)):\(idx + 1): \(line)"
                }

                return nil
            }
        }
    }

    private static func isTextOrLabelCall(_ line: String) -> Bool {
        line.range(of: #"\b(Text|Label)\s*\("#, options: .regularExpression) != nil
    }

    private static func isAccessibilityMetadataTextCall(at idx: Int, in lines: [String]) -> Bool {
        self.accessibilityMetadataTextLines(in: lines).contains(idx)
    }

    private static func accessibilityMetadataTextLines(in lines: [String]) -> Set<Int> {
        let code = self.maskedSwiftCode(lines.joined(separator: "\n"))
        let textToken = Array("Text".utf8)
        let labelToken = Array("Label".utf8)
        let modifiers = [
            Array(".accessibilityLabel".utf8),
            Array(".accessibilityValue".utf8),
            Array(".accessibilityHint".utf8),
        ]
        var callCounts: [Int: Int] = [:]
        var metadataCallCounts: [Int: Int] = [:]
        var line = 0

        for offset in code.indices {
            if code[offset] == 10 {
                line += 1
                continue
            }
            if self.callOpeningParenthesis(after: textToken, at: offset, in: code) != nil ||
                self.callOpeningParenthesis(after: labelToken, at: offset, in: code) != nil
            {
                callCounts[line, default: 0] += 1
            }

            for modifier in modifiers {
                guard let modifierOpen = self.callOpeningParenthesis(after: modifier, at: offset, in: code)
                else { continue }
                let textOffset = self.skippingWhitespace(in: code, after: modifierOpen)
                guard let textOpen = self.callOpeningParenthesis(after: textToken, at: textOffset, in: code),
                      let textClose = self.matchingParenthesis(in: code, openingAt: textOpen)
                else { continue }
                let metadataClose = self.skippingWhitespace(in: code, after: textClose)
                guard metadataClose < code.count, code[metadataClose] == 41 else { continue }

                // Exempt only the direct Text argument; visible calls sharing its source line stay audited.
                let textLine = line + code[offset..<textOffset].count(where: { $0 == 10 })
                metadataCallCounts[textLine, default: 0] += 1
            }
        }

        return Set(metadataCallCounts.compactMap { line, count in
            callCounts[line] == count ? line : nil
        })
    }

    private static func callOpeningParenthesis(
        after token: [UInt8],
        at offset: Int,
        in code: [UInt8]) -> Int?
    {
        guard offset + token.count <= code.count,
              code[offset..<(offset + token.count)].elementsEqual(token),
              token.first == 46 || offset == 0 || !self.isSwiftIdentifierByte(code[offset - 1])
        else { return nil }
        let afterToken = offset + token.count
        guard afterToken == code.count || !self.isSwiftIdentifierByte(code[afterToken]) else { return nil }
        let opening = self.skippingWhitespace(in: code, after: afterToken - 1)
        return opening < code.count && code[opening] == 40 ? opening : nil
    }

    private static func skippingWhitespace(in code: [UInt8], after offset: Int) -> Int {
        var cursor = offset + 1
        while cursor < code.count, code[cursor] == 9 || code[cursor] == 10 || code[cursor] == 13 || code[cursor] == 32 {
            cursor += 1
        }
        return cursor
    }

    private static func matchingParenthesis(in code: [UInt8], openingAt offset: Int) -> Int? {
        var depth = 0
        for cursor in offset..<code.count {
            if code[cursor] == 40 {
                depth += 1
            } else if code[cursor] == 41 {
                depth -= 1
                if depth == 0 { return cursor }
            }
        }
        return nil
    }

    private static func isSwiftIdentifierByte(_ byte: UInt8) -> Bool {
        byte == 95 || (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) || byte >= 128
    }

    private static func maskedSwiftCode(_ source: String) -> [UInt8] {
        let sourceBytes = Array(source.utf8)
        var code = sourceBytes
        var cursor = 0

        func mask(_ range: Range<Int>) {
            for offset in range where code[offset] != 10 && code[offset] != 13 {
                code[offset] = 32
            }
        }

        while cursor < sourceBytes.count {
            if cursor + 1 < sourceBytes.count, sourceBytes[cursor] == 47, sourceBytes[cursor + 1] == 47 {
                let start = cursor
                while cursor < sourceBytes.count, sourceBytes[cursor] != 10 {
                    cursor += 1
                }
                mask(start..<cursor)
                continue
            }
            if cursor + 1 < sourceBytes.count, sourceBytes[cursor] == 47, sourceBytes[cursor + 1] == 42 {
                let start = cursor
                var depth = 1
                cursor += 2
                while cursor < sourceBytes.count, depth > 0 {
                    if cursor + 1 < sourceBytes.count, sourceBytes[cursor] == 47, sourceBytes[cursor + 1] == 42 {
                        depth += 1
                        cursor += 2
                    } else if cursor + 1 < sourceBytes.count,
                              sourceBytes[cursor] == 42,
                              sourceBytes[cursor + 1] == 47
                    {
                        depth -= 1
                        cursor += 2
                    } else {
                        cursor += 1
                    }
                }
                mask(start..<cursor)
                continue
            }

            let start = cursor
            var hashCount = 0
            while cursor < sourceBytes.count, sourceBytes[cursor] == 35 {
                hashCount += 1
                cursor += 1
            }
            guard cursor < sourceBytes.count, sourceBytes[cursor] == 34 else {
                cursor = start + 1
                continue
            }
            let quoteCount = cursor + 2 < sourceBytes.count &&
                sourceBytes[cursor + 1] == 34 && sourceBytes[cursor + 2] == 34 ? 3 : 1
            cursor += quoteCount
            while cursor < sourceBytes.count {
                if hashCount == 0, quoteCount == 1, sourceBytes[cursor] == 92 {
                    cursor = min(sourceBytes.count, cursor + 2)
                    continue
                }
                let closingEnd = cursor + quoteCount + hashCount
                if closingEnd <= sourceBytes.count,
                   sourceBytes[cursor..<(cursor + quoteCount)].allSatisfy({ $0 == 34 }),
                   sourceBytes[(cursor + quoteCount)..<closingEnd].allSatisfy({ $0 == 35 })
                {
                    cursor = closingEnd
                    break
                }
                cursor += 1
            }
            mask(start..<cursor)
        }
        return code
    }

    private static func isShorthandControlCall(_ line: String) -> Bool {
        line.range(
            of: #"\b(Button|Link|Picker|Toggle|TextField|SecureField|Menu|DisclosureGroup|LabeledContent)\s*\(""#,
            options: .regularExpression) != nil
    }

    private static func hasAllowedBrandedFontParameter(_ window: String, line: String, in url: URL) -> Bool {
        switch self.relativePath(url) {
        case "apps/ios/Sources/Design/OpenClawProComponents.swift":
            line.contains("Text(key)") ||
                line.contains("Text(verbatim: value)") ||
                window.contains(".font(self.titleFont)") ||
                window.contains(".font(self.subtitleFont)")
        case "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatMarkdownRenderer.swift":
            // Qualified values are composed here, then styled at the prose render boundary.
            line.contains("SwiftUI.Text(") || window.contains(".font(self.font)")
        default:
            false
        }
    }

    private static func relativePath(_ url: URL) -> String {
        let rootPath = self.iosRootURL()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .path + "/"
        return url.path.hasPrefix(rootPath) ? String(url.path.dropFirst(rootPath.count)) : url.path
    }

    private static func iosRootURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
