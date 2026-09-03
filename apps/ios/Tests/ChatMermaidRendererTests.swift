#if os(iOS) && canImport(WebKit)
import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatMermaidRendererTests {
    private let theme = ChatMermaidTheme(
        background: "#ffffff", foreground: "#111111", muted: "#666666",
        border: "#aaaaaa", accent: "#cc3333", fontFamily: "system-ui", darkMode: false)

    @Test func `canceling a coalesced subscriber leaves the other render alive`() async throws {
        let renderer = ChatMermaidRenderer()
        let request = self.request("flowchart LR\nA-->B")
        var canceledCompletionRan = false
        let token = try #require(renderer.render(request) { _ in canceledCompletionRan = true })
        let second = await withCheckedContinuation { continuation in
            renderer.render(request) { continuation.resume(returning: $0) }
            renderer.cancel(token)
        }
        let image = try second.get()
        #expect(!canceledCompletionRan)
        #expect(image.image.cgImage != nil)
        #expect(image.size.width == 320)
        #expect(image.size.height > 1)
    }

    @Test func `canceling the active document cannot publish into its replacement`() async throws {
        let renderer = ChatMermaidRenderer()
        var canceledCompletionRan = false
        let first = try #require(renderer.render(self.request("flowchart LR\nOld-->Gone")) { _ in
            canceledCompletionRan = true
        })
        renderer.cancel(first)

        let result = await self.render(self.request("flowchart LR\nCurrent-->Diagram"), using: renderer)
        let image = try result.get()
        #expect(!canceledCompletionRan)
        #expect(image.svg.contains("Current"))
        #expect(!image.svg.contains("Gone"))
    }

    @Test func `canceling a queued subscriber preserves the active and following requests`() async throws {
        let renderer = ChatMermaidRenderer()
        var firstResult: Result<ChatMermaidRenderedImage, ChatMermaidFailure>?
        var canceledCompletionRan = false
        _ = try #require(renderer.render(self.request("flowchart LR\nFirst-->Active")) { firstResult = $0 })
        let canceled = try #require(renderer.render(self.request("flowchart LR\nCanceled-->Queued")) { _ in
            canceledCompletionRan = true
        })
        let lastResult = await withCheckedContinuation { continuation in
            renderer.render(self.request("flowchart LR\nLast-->Retained")) { continuation.resume(returning: $0) }
            renderer.cancel(canceled)
        }
        let firstImage = try #require(firstResult).get()
        let lastImage = try lastResult.get()
        #expect(!canceledCompletionRan)
        #expect(firstImage.svg.contains("First"))
        #expect(lastImage.svg.contains("Retained"))
    }

    @Test func `a failed diagram cannot poison the next native render or its cache`() async throws {
        let renderer = ChatMermaidRenderer()
        let invalid = await self.render(self.request("flowchart LR\nA[unterminated"), using: renderer)
        guard case .failure = invalid else {
            Issue.record("Invalid Mermaid unexpectedly rendered")
            return
        }
        let request = self.request("flowchart LR\nRecovered-->Ready")
        let successful = await self.render(request, using: renderer)
        let image = try successful.get()
        var cacheImage: ChatMermaidRenderedImage?
        let pending = renderer.render(request) { result in cacheImage = try? result.get() }
        #expect(pending == nil)
        #expect(cacheImage?.image === image.image)
    }

    private func request(_ source: String) -> ChatMermaidRequest {
        ChatMermaidRequest(source: source, width: 320, displayScale: 2, theme: self.theme)
    }

    private func render(
        _ request: ChatMermaidRequest,
        using renderer: ChatMermaidRenderer) async -> Result<ChatMermaidRenderedImage, ChatMermaidFailure>
    {
        await withCheckedContinuation { continuation in
            renderer.render(request) { continuation.resume(returning: $0) }
        }
    }
}
#endif
