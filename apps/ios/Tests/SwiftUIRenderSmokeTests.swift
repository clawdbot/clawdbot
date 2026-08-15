import OpenClawKit
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw
@testable import OpenClawChatUI

struct SwiftUIRenderSmokeTests {
    @MainActor private static func host(_ view: some View, size: CGSize? = nil) -> UIWindow {
        let frame = CGRect(origin: .zero, size: size ?? UIScreen.main.bounds.size)
        let window = UIWindow(frame: frame)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    @Test @MainActor func `settings pro tab builds in light and dark mode`() {
        for scheme in [ColorScheme.light, ColorScheme.dark] {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsProTab()
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .preferredColorScheme(scheme)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func `settings About destination builds in light and dark mode`() {
        for scheme in [ColorScheme.light, ColorScheme.dark] {
            for typeSize in [DynamicTypeSize.large, .accessibility2] {
                let appModel = NodeAppModel()
                let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

                let root = SettingsProTab(directRoute: .about)
                    .environment(AppAppearanceModel())
                    .environment(appModel)
                    .environment(appModel.voiceWake)
                    .environment(gatewayController)
                    .environment(\.dynamicTypeSize, typeSize)
                    .preferredColorScheme(scheme)

                _ = Self.host(root, size: CGSize(width: 320, height: 852))
            }
        }
    }

    @Test @MainActor func `settings Privacy destination builds across appearance and type size`() {
        for scheme in [ColorScheme.light, ColorScheme.dark] {
            for typeSize in [DynamicTypeSize.large, .accessibility2] {
                let appModel = NodeAppModel()
                let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

                let root = SettingsProTab(directRoute: .privacy)
                    .environment(AppAppearanceModel())
                    .environment(appModel)
                    .environment(appModel.voiceWake)
                    .environment(gatewayController)
                    .preferredColorScheme(scheme)
                    .environment(\.dynamicTypeSize, typeSize)

                _ = Self.host(root, size: CGSize(width: 393, height: 852))
            }
        }
    }

    @Test @MainActor func `settings Licenses destination builds in light and dark mode`() {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        for scheme in [ColorScheme.light, ColorScheme.dark] {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsProTab(directRoute: .licenses)
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .preferredColorScheme(scheme)

            windows.append(Self.host(root, size: CGSize(width: 393, height: 852)))
        }
    }

    @Test @MainActor func `settings OpenClaw destination builds access gate across appearance and type size`() {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        for scheme in [ColorScheme.light, ColorScheme.dark] {
            for typeSize in [DynamicTypeSize.large, .accessibility2] {
                let appModel = NodeAppModel()
                let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)
                let root = SettingsProTab(directRoute: .systemAgent)
                    .environment(AppAppearanceModel())
                    .environment(appModel)
                    .environment(appModel.voiceWake)
                    .environment(gatewayController)
                    .environment(\.dynamicTypeSize, typeSize)
                    .preferredColorScheme(scheme)

                windows.append(Self.host(root, size: CGSize(width: 393, height: 852)))
            }
        }
    }

    @Test @MainActor func `settings pro tab appearance row builds for all preferences`() throws {
        for preference in AppAppearancePreference.allCases {
            let suiteName = "OpenClawTests.appearance.\(preference.rawValue).\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suiteName))
            defer { defaults.removePersistentDomain(forName: suiteName) }
            defaults.set(preference.rawValue, forKey: AppAppearancePreference.storageKey)

            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsProTab()
                .defaultAppStorage(defaults)
                .environment(AppAppearanceModel(userDefaults: defaults))
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func `hosted push relay disclosure builds A view hierarchy`() {
        for typeSize in [DynamicTypeSize.large, .accessibility5] {
            let root = HostedPushRelayDisclosureSheet(
                message: "Enabling this sends delivery data through OpenClaw's hosted push relay.",
                onContinue: {})
                .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 402, height: 450))
        }
    }

    @Test @MainActor func `display math builds valid and fallback view hierarchies`() {
        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = VStack {
                ChatMarkdownRenderer(
                    text: #"Inline math \(E = mc^2\) stays inside prose."#,
                    context: .assistant,
                    variant: .standard,
                    textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: #"\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"#,
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: #"\notARealCommand{"#,
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: "α + β = γ",
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: String(repeating: "{", count: 65) + "x",
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: String(repeating: #"\bar"#, count: 129) + "x",
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: #"x\textcolor{#fff}{}"#,
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
            }
            .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 393, height: 240))
        }
    }

    @Test @MainActor func `markdown heading hierarchy builds with inline formatting and table`() {
        let markdown = """
        # First **strong** heading
        ## Second [linked](https://example.com) heading
        ### Third `code` heading
        #### Fourth heading
        ##### Fifth heading
        ###### Sixth heading

        | Surface | State |
        | --- | --- |
        | iOS | Native |
        """
        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = ChatMarkdownRenderer(
                text: markdown,
                context: .assistant,
                variant: .standard,
                textColor: OpenClawChatTheme.assistantText)
                .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 393, height: 700))
        }
    }

    @Test @MainActor func `markdown lists and thematic breaks build across appearance and type size`() {
        let markdown = """
        Here are the options:

        9. **Option one heading** – a sentence describing it.
        10. **Option two heading** – another sentence.
           - Nested detail
           - [x] Completed detail

        ---

        Final paragraph.
        """
        for scheme in [ColorScheme.light, .dark] {
            for typeSize in [DynamicTypeSize.large, .accessibility2] {
                let root = ChatMarkdownRenderer(
                    text: markdown,
                    context: .assistant,
                    variant: .standard,
                    textColor: OpenClawChatTheme.assistantText)
                    .environment(\.dynamicTypeSize, typeSize)
                    .preferredColorScheme(scheme)

                _ = Self.host(root, size: CGSize(width: 320, height: 700))
            }
        }
    }

    @Test @MainActor func `long user prompt disclosure builds across dynamic type sizes`() {
        let text = Array(repeating: "A long user-authored prompt line.", count: 13).joined(separator: "\n")
        let message = OpenClawChatMessage(
            role: "user",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: nil)

        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = ChatMessageBubble(
                message: message,
                style: .standard,
                markdownVariant: .standard,
                userAccent: nil,
                displayOptions: [],
                assistantName: "OpenClaw",
                assistantAvatarText: "OC",
                assistantAvatarTint: nil,
                showsAssistantAvatar: true,
                isClean: false,
                contextWindowTokens: nil,
                userMessageExpanded: false,
                onToggleUserMessageExpanded: {},
                inlineWidgetResolverReady: true,
                inlineWidgetResourceResolver: { _, _ in nil },
                mediaArtifactResolverReady: false,
                mediaPlaybackAllowed: { true },
                loadMediaArtifact: { _, _, _ in nil })
                .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 320, height: 420))
        }
    }

    @Test @MainActor func `managed assistant image starts its artifact load`() async throws {
        let artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111"
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "image",
                text: nil,
                mimeType: "image/png",
                fileName: nil,
                artifactId: artifactId,
                url: "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full",
                alt: "Managed preview",
                content: nil)],
            timestamp: 1)
        var requestedArtifactId: String?
        let root = ChatMessageBubble(
            message: message,
            style: .standard,
            markdownVariant: .standard,
            userAccent: nil,
            displayOptions: [],
            assistantName: "OpenClaw",
            assistantAvatarText: "OC",
            assistantAvatarTint: nil,
            showsAssistantAvatar: true,
            isClean: false,
            contextWindowTokens: nil,
            userMessageExpanded: false,
            onToggleUserMessageExpanded: {},
            inlineWidgetResolverReady: true,
            inlineWidgetResourceResolver: { _, _ in nil },
            mediaArtifactResolverReady: true,
            mediaPlaybackAllowed: { true },
            loadMediaArtifact: { requested, kind, _ in
                requestedArtifactId = requested
                #expect(kind == .image)
                return OpenClawChatLoadedMedia.data(OpenClawChatMediaData(
                    data: Data(base64Encoded:
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8A" +
                            "AusB9Y9Zl1sAAAAASUVORK5CYII=")!,
                    mimeType: "image/png"))
            })
        let window = Self.host(root, size: CGSize(width: 393, height: 420))
        defer { window.isHidden = true }

        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while requestedArtifactId == nil, ContinuousClock().now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(requestedArtifactId == artifactId)
    }

    @Test @MainActor func `streaming assistant bubble builds mixed prose and code`() {
        let text = """
        Earlier prose stays visible.

        ```swift
        let answer = 42
        ```

        Trailing streamed words fade in.
        """

        let root = ChatStreamingAssistantBubble(
            text: text,
            markdownVariant: .standard,
            showsReasoning: false,
            assistantName: "OpenClaw",
            assistantAvatarText: "OC",
            assistantAvatarTint: nil,
            showsAssistantAvatar: true,
            isClean: false)

        _ = Self.host(root, size: CGSize(width: 393, height: 400))
    }

    @Test @MainActor func `completed and streaming assistant trace headings build across type sizes`() {
        let text = """
        <think>
        # Internal plan
        </think>
        <final>
        # Final answer
        </final>
        """
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: 1)

        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = VStack {
                ChatMessageBubble(
                    message: message,
                    style: .standard,
                    markdownVariant: .standard,
                    userAccent: nil,
                    displayOptions: [.reasoning],
                    assistantName: "OpenClaw",
                    assistantAvatarText: "OC",
                    assistantAvatarTint: nil,
                    showsAssistantAvatar: true,
                    isClean: false,
                    contextWindowTokens: nil,
                    userMessageExpanded: false,
                    onToggleUserMessageExpanded: {},
                    inlineWidgetResolverReady: true,
                    inlineWidgetResourceResolver: { _, _ in nil },
                    mediaArtifactResolverReady: false,
                    mediaPlaybackAllowed: { true },
                    loadMediaArtifact: { _, _, _ in nil })
                ChatStreamingAssistantBubble(
                    text: text,
                    markdownVariant: .standard,
                    showsReasoning: true,
                    assistantName: "OpenClaw",
                    assistantAvatarText: "OC",
                    assistantAvatarTint: nil,
                    showsAssistantAvatar: true,
                    isClean: false)
            }
            .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 393, height: 700))
        }
    }

    @Test @MainActor func `assistant usage footer builds across dynamic type sizes`() throws {
        let usage = try JSONDecoder().decode(
            OpenClawChatUsage.self,
            from: Data(#"{"input":12000,"output":300,"cacheRead":438400,"cacheWrite":307000,"cost":{"total":0.0123}}"#
                .utf8))
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: "A completed assistant response with per-run usage.",
                thinking: nil,
                thinkingSignature: nil,
                mimeType: nil,
                fileName: nil,
                content: nil,
                id: nil,
                name: nil,
                arguments: nil)],
            timestamp: nil,
            usage: usage)

        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = ChatMessageBubble(
                message: message,
                style: .standard,
                markdownVariant: .standard,
                userAccent: nil,
                displayOptions: [],
                assistantName: "OpenClaw",
                assistantAvatarText: "OC",
                assistantAvatarTint: nil,
                showsAssistantAvatar: true,
                isClean: false,
                contextWindowTokens: 1_000_000,
                userMessageExpanded: false,
                onToggleUserMessageExpanded: {},
                inlineWidgetResolverReady: true,
                inlineWidgetResourceResolver: { _, _ in nil },
                mediaArtifactResolverReady: false,
                mediaPlaybackAllowed: { true },
                loadMediaArtifact: { _, _, _ in nil })
                .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 320, height: 280))
        }
    }

    @Test @MainActor func `gateway trust prompt alert presents when prompt appears after initial render`() async {
        let appModel = NodeAppModel()
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .environment(gatewayController)

        let window = Self.host(root)
        await Self.triggerGatewayTrustPrompt(controller: gatewayController)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @Test @MainActor func `exec approval dialog builds on compact screens with accessibility text`() throws {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        let layouts: [(CGSize, DynamicTypeSize)] = [
            (CGSize(width: 320, height: 568), .accessibility5),
            (CGSize(width: 568, height: 320), .accessibility3),
        ]
        for (size, typeSize) in layouts {
            let appModel = NodeAppModel()
            let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-layout",
                commandText: String(repeating: "/usr/bin/find /private/var/mobile/Documents ", count: 12),
                warningText: String(
                    repeating: "This command can modify files outside the current workspace. ",
                    count: 12),
                allowedDecisions: ["allow-once", "allow-always", "deny"],
                host: "gateway.example.com",
                nodeId: "node-mobile",
                agentId: "main",
                expiresAtMs: Int64.max))
            appModel._test_presentExecApprovalPrompt(prompt)

            let root = Color.clear
                .execApprovalPromptDialog()
                .environment(appModel)
                .environment(\.dynamicTypeSize, typeSize)
            windows.append(Self.host(root, size: size))
        }
    }

    @Test @MainActor func `root prompt alert stack presents gateway trust prompt`() async {
        let appModel = NodeAppModel()
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .environment(appModel)
            .environment(gatewayController)

        let window = Self.host(root)
        await Self.triggerGatewayTrustPrompt(controller: gatewayController)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @Test @MainActor func `root prompt alert stack still presents deep link prompt`() async throws {
        let appModel = NodeAppModel()
        appModel.gatewayConnected = true
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .environment(appModel)
            .environment(gatewayController)

        let window = Self.host(root)
        let url = try #require(URL(string: "openclaw://agent?message=hello%20from%20deep%20link"))
        await appModel.handleDeepLink(url: url)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @MainActor private static func gatewayControllerWithCapturedTLSFingerprint(
        appModel: NodeAppModel)
        -> GatewayConnectionController
    {
        GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("abc123") })
    }

    @MainActor private static func triggerGatewayTrustPrompt(controller: GatewayConnectionController) async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.clearFingerprint(stableID: stableID)
        await controller.connectManual(host: host, port: port, useTLS: true)
    }

    @MainActor private static func waitForPresentedAlert(in window: UIWindow) async {
        for _ in 0..<10 {
            if window.rootViewController?.presentedViewController != nil { return }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

}
