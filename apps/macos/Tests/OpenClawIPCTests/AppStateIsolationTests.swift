import Foundation
import Security
import Testing
@testable import OpenClaw

@MainActor
struct AppStateIsolationTests {
    @Test
    func `preview constructor uses launch namespace and owned config`() async throws {
        // Fail before touching defaults when the bundle was launched without its resource owner.
        let profile = try #require(AppProfile.current.name)
        try #require(profile.hasPrefix("test-"))
        let suiteName = try #require(AppProfile.current.defaultsSuiteName)
        let fm = FileManager()
        let home = try #require(OpenClawEnv.path("HOME"))
        // Check the platform's actual default before any fixture or catalog writes.
        // A profile name alone cannot keep Security away from an operator's Keychain.
        var defaultKeychain: SecKeychain?
        try #require(SecKeychainCopyDefault(&defaultKeychain) == errSecSuccess)
        let keychain = try #require(defaultKeychain)
        var pathBytes = [CChar](repeating: 0, count: 4096)
        var pathLength = UInt32(pathBytes.count)
        try #require(SecKeychainGetPath(keychain, &pathLength, &pathBytes) == errSecSuccess)
        let keychainPath = try #require(String(
            bytes: pathBytes.prefix(Int(pathLength)).map { UInt8(bitPattern: $0) },
            encoding: .utf8))
        let keychainURL = URL(fileURLWithPath: keychainPath).resolvingSymlinksInPath()
        try #require(keychainURL.deletingLastPathComponent().path ==
            URL(fileURLWithPath: home).appendingPathComponent("Library/Keychains").resolvingSymlinksInPath().path)
        let fixture = fm.temporaryDirectory.appendingPathComponent("app-state-\(UUID().uuidString)")
        try fm.createDirectory(at: fixture, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: fixture) }
        let configURL = fixture.appendingPathComponent("openclaw.json")
        let seededKeys = [
            iconAnimationsEnabledKey,
            showDockIconKey,
            talkPhaseSoundsEnabledKey,
            talkShiftToStopEnabledKey,
            heartbeatsEnabledKey,
            iconOverrideKey,
        ]
        var defaults = Dictionary(uniqueKeysWithValues: seededKeys.map { ($0, nil as Any?) })
        defaults[swabbleEnabledKey] = false
        defaults[talkEnabledKey] = false
        defaults[talkRealtimeRelayEnabledKey] = true

        let launchState = try await TestIsolation.withEnvValues([:]) {
            let home = try #require(OpenClawEnv.path("HOME"))
            #expect(OpenClawEnv.path("CFFIXED_USER_HOME") == home)
            let root = URL(fileURLWithPath: home).deletingLastPathComponent()
            #expect(fm.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path ==
                URL(fileURLWithPath: home).resolvingSymlinksInPath().path)
            // Foundation uses Darwin's per-user temp directory independently of TMPDIR.
            // Fixtures there remain test-owned on the disposable worker.
            let tmp = try #require(OpenClawEnv.path("TMPDIR"))
            #expect(URL(fileURLWithPath: tmp).resolvingSymlinksInPath().path ==
                root.appendingPathComponent("tmp").resolvingSymlinksInPath().path)
            #expect(OpenClawPaths.stateDirURL == root.appendingPathComponent("state", isDirectory: true))
            #expect(OpenClawPaths.configURL == OpenClawPaths.stateDirURL.appendingPathComponent("openclaw.json"))
            return OpenClawPaths.stateDirURL
        }

        let fixtureState = try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configURL.path],
            defaults: defaults)
        {
            let preferences = try #require(UserDefaults(suiteName: suiteName))
            // Other tests may already have constructed AppState. Remove only these keys
            // under the cooperative lock instead of assuming this test runs first.
            for key in seededKeys {
                #expect(preferences.object(forKey: key) == nil)
            }
            #expect(!fm.fileExists(atPath: configURL.path))
            let absent = AppState(preview: true)
            #expect(absent.iconAnimationsEnabled)
            #expect(absent.showDockIcon)
            #expect(absent.talkPhaseSoundsEnabled)
            #expect(absent.talkShiftToStopEnabled)
            #expect(absent.heartbeatsEnabled)
            #expect(absent.iconOverride == .system)
            #expect(absent.talkRealtimeRelayEnabled)
            for key in seededKeys.dropLast() {
                #expect(preferences.object(forKey: key) as? Bool == true)
            }
            #expect(preferences.string(forKey: iconOverrideKey) == IconOverrideSelection.system.rawValue)
            #expect(!fm.fileExists(atPath: configURL.path))

            let stateDirectory = OpenClawPaths.stateDirURL
            #expect(stateDirectory != launchState)
            #expect(stateDirectory.path.hasPrefix(fm.temporaryDirectory.path))
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://fixture.example.invalid:9443",
                    ],
                ],
            ]))
            preferences.set(false, forKey: showDockIconKey)
            let configured = AppState(preview: true)
            #expect(!configured.showDockIcon)
            #expect(configured.connectionMode == .remote)
            #expect(configured.remoteTransport == .direct)
            #expect(configured.remoteUrl == "wss://fixture.example.invalid:9443")
            #expect(AppProfile.current.name == profile)

            // Catalog reads commit legacy migration through SecItemAdd on a fresh Keychain.
            let catalog = try await MacGatewayProfileStore().catalogProfiles()
            #expect(catalog.count == 1)
            let migrated = try #require(catalog.first)
            #expect(migrated.profile.url.absoluteString == "wss://fixture.example.invalid:9443/")
            #expect(!migrated.canPromote)
            // A fresh store must read the committed registry, not the first actor's cache.
            #expect(try await MacGatewayProfileStore().catalogProfiles() == catalog)

            // Preview still reads config; malformed input must keep its snapshot and audit in owned paths.
            try Data("{ invalid fixture".utf8).write(to: configURL)
            _ = AppState(preview: true)
            let auditURL = stateDirectory.appendingPathComponent("logs/config-audit.jsonl")
            let audit = try String(contentsOf: auditURL, encoding: .utf8)
            #expect(audit.contains("config.write"))
            #expect(audit.contains("config.observe"))
            #expect(try fm.contentsOfDirectory(atPath: fixture.path).contains {
                $0.hasPrefix("openclaw.json.clobbered.")
            })
            return stateDirectory
        }
        #expect(!fm.fileExists(atPath: fixtureState.path))
        await TestIsolation.withEnvValues([:]) {
            #expect(OpenClawPaths.stateDirURL == launchState)
            #expect(fm.fileExists(atPath: launchState.path))
        }
    }

    @Test
    func `config fixture cleans audit after throwing body`() async throws {
        enum FixtureError: Error {
            case expected
        }
        let fm = FileManager()
        let configPath = TestIsolation.tempConfigPath()
        defer { try? fm.removeItem(atPath: configPath) }
        var fixtureState: URL?
        do {
            try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
                fixtureState = OpenClawPaths.stateDirURL
                #expect(OpenClawConfigFile.saveDict(["gateway": ["mode": "local"]]))
                await Task.yield()
                #expect(fm.fileExists(atPath: OpenClawPaths.stateDirURL
                        .appendingPathComponent("logs/config-audit.jsonl").path))
                throw FixtureError.expected
            }
        } catch FixtureError.expected {}
        let removed = try #require(fixtureState)
        #expect(!fm.fileExists(atPath: removed.path))
    }
}
