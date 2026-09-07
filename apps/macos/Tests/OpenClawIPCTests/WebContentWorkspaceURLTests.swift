import Foundation
import Testing
@testable import OpenClaw

struct WebContentWorkspaceURLTests {
    @Test(arguments: [
        "https://docs.openclaw.ai/",
        "http://127.0.0.1:18789/",
        "mailto:hello@example.com",
        "MAILTO:hello@example.com",
        "tel:+15555550100",
        "TEL:+15555550100",
    ])
    func `workspace open allowlist accepts Control UI schemes`(_ address: String) throws {
        let url = try #require(URL(string: address))
        #expect(WebContentWorkspaceURL.isAllowed(url))
    }

    @Test(arguments: [
        "file:///etc/passwd",
        "smb://files.example/share",
        "slack://open",
        "vscode://file/tmp/secret",
        "javascript:alert(1)",
        "data:text/html,hi",
        "about:blank",
        "ftp://files.example/pub",
    ])
    func `workspace open allowlist rejects arbitrary schemes`(_ address: String) throws {
        let url = try #require(URL(string: address))
        #expect(!WebContentWorkspaceURL.isAllowed(url))
    }

    @Test func `http and https require a host`() throws {
        let noHost = try #require(URL(string: "https:"))
        #expect(!WebContentWorkspaceURL.isAllowed(noHost))
    }
}
