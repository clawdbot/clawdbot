import Foundation
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
            #expect(fm.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path == home)
            #expect(fm.temporaryDirectory.resolvingSymlinksInPath().path ==
                root.appendingPathComponent("tmp").path)
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
