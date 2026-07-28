import Foundation
import OpenClawKit
import Testing

struct ShareDraftComposerTests {
    @Test(arguments: [
        "sHaReD fRoM iOs.",
        "tExT:",
        "sHaReD aTtAcHmEnT(s):",
        "pLeAsE hElP mE wItH tHiS.",
    ])
    func `removes exact legacy scaffold lines case insensitively`(_ marker: String) {
        let payload = SharedContentPayload(title: nil, url: nil, text: marker)
        #expect(ShareDraftComposer.compose(from: payload).isEmpty)
    }

    @Test(arguments: [
        "Shared from iOS.",
        "Text:",
        "Shared attachment(s):",
        "Please help me with this.",
    ])
    func `preserves content that starts with a legacy scaffold marker`(_ marker: String) {
        let text = "\(marker) legitimate content"
        let payload = SharedContentPayload(title: nil, url: nil, text: text)
        #expect(ShareDraftComposer.compose(from: payload) == text)
    }

    @Test func `removes only exact scaffold lines from multiline content`() {
        let payload = SharedContentPayload(
            title: nil,
            url: nil,
            text: "Text: keep this\nShared from iOS.\nsecond line")

        #expect(ShareDraftComposer.compose(from: payload) == "Text: keep this\nsecond line")
    }

    @Test func `composes sanitized title text and URL into the final draft`() throws {
        let url = try #require(URL(string: "https://example.com/article"))
        let payload = SharedContentPayload(
            title: "Text: title",
            url: url,
            text: "Shared attachment(s):\nText: body")

        #expect(ShareDraftComposer.compose(from: payload) ==
            "Text: title\n\nText: body\n\nhttps://example.com/article")
    }

    @Test func `omits nil and blank fragments`() {
        let payload = SharedContentPayload(title: nil, url: nil, text: "  \n")
        #expect(ShareDraftComposer.compose(from: payload).isEmpty)
    }

    @Test(arguments: [
        "Text: the quick brown fox",
        "tExT:",
        "mailto:hello@example.com",
        "https:",
    ])
    func `does not reinterpret ordinary shared text as a web URL`(_ text: String) {
        #expect(SharePayloadNormalizer.webURL(from: text) == nil)
    }

    @Test(arguments: [
        "https://example.com/article",
        " HTTP://example.com/path ",
    ])
    func `accepts web URLs supplied as plain text`(_ text: String) {
        #expect(SharePayloadNormalizer.webURL(from: text) != nil)
    }

    @Test func `deduplicates attributed content that mirrors provider text or URL`() throws {
        let url = try #require(URL(string: "https://example.com/article"))
        #expect(SharePayloadNormalizer.distinctAttributedText(
            " Text: the quick brown fox ",
            sharedText: "Text: the quick brown fox",
            sharedURL: nil) == nil)
        #expect(SharePayloadNormalizer.distinctAttributedText(
            "https://example.com/article",
            sharedText: nil,
            sharedURL: url) == nil)
    }

    @Test func `preserves attributed content that differs from provider data`() throws {
        let url = try #require(URL(string: "https://example.com/article"))
        #expect(SharePayloadNormalizer.distinctAttributedText(
            "Article summary",
            sharedText: "Article body",
            sharedURL: url) == "Article summary")
    }
}
