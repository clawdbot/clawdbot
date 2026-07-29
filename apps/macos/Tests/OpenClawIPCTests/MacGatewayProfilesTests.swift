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

    @Test func `profiles sharing an authority keep independent TLS pin owners`() throws {
        let url = try #require(URL(string: "wss://studio.example"))
        let first = MacGatewayProfile(id: "first", name: "First", url: url)
        let second = MacGatewayProfile(id: "second", name: "Second", url: url)

        #expect(MacGatewayProfileStore.tlsRoute(for: first)?.params.storeKey == "profile:first")
        #expect(MacGatewayProfileStore.tlsRoute(for: second)?.params.storeKey == "profile:second")
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

    @Test func `legacy direct primary Gateway migrates once with credentials`() throws {
        let root = self.remoteRoot(
            url: "WSS://Studio.Example/alpha",
            token: " legacy-token ",
            password: " legacy-password ")
        let original = MacGatewayProfileStore.Registry()

        let migrated = MacGatewayProfileStore.migratingLegacyPrimaryConnection(
            root: root,
            registry: original)

        #expect(original.legacyPrimaryMigrationVersion == nil)
        #expect(migrated.legacyPrimaryMigrationVersion == 1)
        let stored = try #require(migrated.profiles.first)
        #expect(stored.profile.name == "studio.example")
        #expect(stored.profile.url.absoluteString == "wss://studio.example:443/alpha")
        #expect(stored.credentials.token == "legacy-token")
        #expect(stored.credentials.password == "legacy-password")
        #expect(MacGatewayProfileStore.migratingLegacyPrimaryConnection(
            root: root,
            registry: migrated) == migrated)
        #expect(MacGatewayProfileStore.migratingLegacyPrimaryConnection(
            root: root,
            registry: original) == migrated)
    }

    @Test func `legacy migration preserves an existing profile for the same route`() throws {
        let url = try MacGatewayProfileStore.canonicalURL(
            #require(URL(string: "wss://studio.example")))
        let existing = MacGatewayProfileStore.StoredProfile(
            profile: MacGatewayProfile(
                id: MacGatewayProfileStore.profileID(url: url),
                name: "My Studio",
                url: url),
            credentials: .init(token: "saved-token", password: "saved-password"))
        let registry = MacGatewayProfileStore.Registry(profiles: [existing])

        let migrated = MacGatewayProfileStore.migratingLegacyPrimaryConnection(
            root: self.remoteRoot(
                url: "wss://studio.example",
                token: "new-token",
                password: "new-password"),
            registry: registry)

        #expect(migrated.legacyPrimaryMigrationVersion == 1)
        #expect(migrated.profiles == [existing])
    }

    @Test func `legacy migration skips routes that are not active direct Gateways`() {
        let cases: [[String: Any]] = [
            self.remoteRoot(url: "ws://127.0.0.1:18789", transport: "ssh"),
            self.remoteRoot(url: "wss://studio.example", mode: "local"),
            self.remoteRoot(url: "https://studio.example"),
            [:],
        ]

        for root in cases {
            let migrated = MacGatewayProfileStore.migratingLegacyPrimaryConnection(
                root: root,
                registry: .init())
            #expect(migrated.legacyPrimaryMigrationVersion == 1)
            #expect(migrated.profiles.isEmpty)
        }
    }

    private func remoteRoot(
        url: String,
        mode: String = "remote",
        transport: String? = nil,
        token: String? = nil,
        password: String? = nil) -> [String: Any]
    {
        var remote: [String: Any] = ["url": url]
        if let transport { remote["transport"] = transport }
        if let token { remote["token"] = token }
        if let password { remote["password"] = password }
        return ["gateway": ["mode": mode, "remote": remote]]
    }
}
