import Foundation
import Testing
@testable import OpenClaw

struct MacGatewayProfilesTests {
    @Test func `canonical route identity normalizes authority but preserves path`() throws {
        let implicit = try MacGatewayProfileStore.canonicalURL(
            #require(URL(string: "WSS://Studio.Example/alpha")))
        let explicit = try MacGatewayProfileStore.canonicalURL(
            #require(URL(string: "wss://studio.example:443/alpha")))
        let otherPath = try MacGatewayProfileStore.canonicalURL(
            #require(URL(string: "wss://studio.example:443/beta")))

        #expect(implicit == explicit)
        #expect(MacGatewayProfileStore.profileID(url: implicit) ==
            MacGatewayProfileStore.profileID(url: explicit))
        #expect(MacGatewayProfileStore.profileID(url: implicit) !=
            MacGatewayProfileStore.profileID(url: otherPath))

        let emptyPath = try MacGatewayProfileStore.canonicalURL(
            #require(URL(string: "wss://studio.example")))
        let rootPath = try MacGatewayProfileStore.canonicalURL(
            #require(URL(string: "wss://studio.example/")))
        #expect(emptyPath == rootPath)
        #expect(MacGatewayProfileStore.profileID(url: emptyPath) ==
            MacGatewayProfileStore.profileID(url: rootPath))
    }

    @Test func `profile URL rejects dashboard schemes`() {
        #expect(throws: MacGatewayProfileError.invalidURL) {
            try MacGatewayProfileStore.canonicalURL(
                #require(URL(string: "https://studio.example")))
        }
    }

    @Test(arguments: [
        "ws://gateway.example:18789",
        "ws://203.0.113.10:18789",
        "ws://[2001:db8::10]:18789",
        "ws://[gateway.local]:18789",
        "ws://[192.168.1.20]:18789",
    ])
    func `profile URL rejects public plaintext hosts`(rawURL: String) throws {
        #expect(throws: MacGatewayProfileError.insecureRemoteURL) {
            try MacGatewayProfileStore.canonicalURL(#require(URL(string: rawURL)))
        }
    }

    @Test(arguments: [
        "ws://localhost",
        "ws://127.0.0.1",
        "ws://10.0.0.5",
        "ws://172.16.1.5",
        "ws://192.168.1.20",
        "ws://169.254.1.5",
        "ws://100.64.0.9",
        "ws://gateway.local",
        "ws://gateway.tailnet.ts.net",
        "ws://[fd00::1]",
        "ws://[fe80::1]",
    ])
    func `profile URL accepts trusted plaintext hosts`(rawURL: String) throws {
        let url = try MacGatewayProfileStore.canonicalURL(#require(URL(string: rawURL)))

        #expect(url.scheme == "ws")
        #expect(url.port == 18789)
    }

    @Test func `profile URL accepts public secure hosts`() throws {
        let url = try MacGatewayProfileStore.canonicalURL(
            #require(URL(string: "wss://gateway.example")))

        #expect(url.absoluteString == "wss://gateway.example:443/")
    }

    @Test func `blank profile form preserves saved credentials`() {
        let saved = MacGatewayProfileStore.Credentials(token: "saved-token", password: "saved-password")

        #expect(MacGatewayProfileStore.resolvedCredentials(
            saved: saved,
            submittedToken: "  ",
            submittedPassword: nil) == saved)
        #expect(MacGatewayProfileStore.resolvedCredentials(
            saved: saved,
            submittedToken: "replacement",
            submittedPassword: nil) == .init(token: "replacement", password: nil))
    }

    @Test func `newer profile registry is rejected`() throws {
        let data = Data(#"{"version":2,"profiles":[]}"#.utf8)

        #expect(throws: MacGatewayProfileError.self) {
            try MacGatewayProfileStore.validateRegistryData(data)
        }
    }

    @Test func `saved profiles are ordered by name then route`() throws {
        let zURL = try #require(URL(string: "wss://z.example"))
        let aURL = try #require(URL(string: "wss://a.example"))
        let bURL = try #require(URL(string: "wss://b.example"))
        let profiles = [
            MacGatewayProfile(
                id: "z",
                name: "Studio",
                url: zURL),
            MacGatewayProfile(
                id: "a",
                name: "alpha",
                url: aURL),
            MacGatewayProfile(
                id: "b",
                name: "Studio",
                url: bURL),
        ]

        #expect(MacGatewayProfileStore.sortedProfiles(profiles).map(\.id) == ["a", "b", "z"])
    }

    @Test func `new Gateway picker remembers a reusable profile`() throws {
        let oneURL = try #require(URL(string: "wss://one.example"))
        let twoURL = try #require(URL(string: "wss://two.example"))
        let profiles = [
            MacGatewayProfile(
                id: "one",
                name: "One",
                url: oneURL),
            MacGatewayProfile(
                id: "two",
                name: "Two",
                url: twoURL),
        ]

        #expect(WebChatManager.preferredProfileIndex(profiles: profiles, preferredID: "two") == 1)
        #expect(WebChatManager.preferredProfileIndex(profiles: profiles, preferredID: "missing") == 0)
    }
}
