#if os(macOS)
import AppKit
import SwiftMath
import SwiftUI
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatMathBlockViewTests {
    @Test(arguments: [false, true])
    func `display math retains its typeset bounds in transcript layout`(usesSplitView: Bool) throws {
        _ = NSApplication.shared
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: "Before the equation.\n\n$$E = mc^2$$\n\nAfter the equation.",
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: nil)
        let content = ScrollView {
            LazyVStack(alignment: .leading) {
                ChatMessageBubble(
                    message: message,
                    style: .standard,
                    markdownVariant: .standard,
                    userAccent: nil,
                    displayOptions: [],
                    assistantName: "OpenClaw",
                    assistantAvatarText: "OC",
                    assistantAvatarTint: nil,
                    showsAssistantAvatar: usesSplitView,
                    isClean: true,
                    contextWindowTokens: nil,
                    userMessageExpanded: false,
                    onToggleUserMessageExpanded: {},
                    inlineWidgetResolverReady: false,
                    inlineWidgetResourceResolver: { _, _ in nil },
                    mediaArtifactResolverReady: false,
                    mediaPlaybackAllowed: { false },
                    loadMediaArtifact: { _, _, _ in nil })
            }
            .frame(maxWidth: .infinity)
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 680),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        let host: NSView
        if usesSplitView {
            // Full chat's split-view host can collapse an equation that sizes
            // correctly in Quick Chat's direct host. Exercise both containers.
            let controller = NSHostingController(rootView: NavigationSplitView {
                Text("Sessions")
                    .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 340)
            } detail: {
                content
            })
            window.contentViewController = controller
            controller.sceneBridgingOptions = [.toolbars]
            host = controller.view
        } else {
            host = NSHostingView(rootView: content)
            window.contentView = host
        }
        defer {
            window.contentViewController = nil
            window.contentView = nil
        }

        for layoutWidth in [CGFloat(960), CGFloat(620), CGFloat(960)] {
            window.setContentSize(NSSize(width: layoutWidth, height: 400))
            host.layoutSubtreeIfNeeded()
            let label = try #require(Self.mathLabel(in: host))
            #expect(label.error == nil)
            let typesetSize = label.fittingSize
            #expect(typesetSize.width > 0)
            #expect(typesetSize.height > 0)
            #expect(label.bounds.width + 0.5 >= typesetSize.width)
            #expect(label.bounds.height + 0.5 >= typesetSize.height)
        }
    }

    private static func mathLabel(in view: NSView) -> MTMathUILabel? {
        if let label = view as? MTMathUILabel { return label }
        return view.subviews.lazy.compactMap { Self.mathLabel(in: $0) }.first
    }
}
#endif
