import Foundation
import Testing
@testable import OpenClaw

@Suite("Application Relocator Tests")
@MainActor
struct ApplicationRelocatorTests {
    private let home = URL(fileURLWithPath: "/Users/tester")
    private let current = ApplicationRelocator.ApplicationIdentity(
        bundleIdentifier: "ai.openclaw.mac",
        buildVersion: "100")

    @Test
    func `stable application locations continue normally`() {
        let paths = [
            "/Applications/OpenClaw.app",
            "/Users/tester/Applications/OpenClaw.app",
            "/Users/tester/Tools/OpenClaw.app",
            "/Volumes/External/Apps/OpenClaw.app",
        ]
        for path in paths {
            let recommendation = ApplicationRelocator.recommendation(
                for: self.environment(path: path, readOnlyVolume: false))
            #expect(recommendation == .continueLaunch)
        }
    }

    @Test
    func `debug and test builds never relocate`() {
        let recommendation = ApplicationRelocator.recommendation(
            for: self.environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                debugOrTesting: true))

        #expect(recommendation == .continueLaunch)
    }

    @Test
    func `transient copy offers system installation when available`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let recommendation = ApplicationRelocator.recommendation(
            for: self.environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                candidates: [self.missing(destination, writable: true)]))

        #expect(recommendation == .offerInstall(destination: destination, replacing: false))
    }

    @Test
    func `read only mounted copy offers installation`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let recommendation = ApplicationRelocator.recommendation(
            for: self.environment(
                path: "/Volumes/OpenClaw/OpenClaw.app",
                candidates: [self.missing(destination, writable: true)],
                readOnlyVolume: true))

        #expect(recommendation == .offerInstall(destination: destination, replacing: false))
    }

    @Test
    func `translocated copy offers installation`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let recommendation = ApplicationRelocator.recommendation(
            for: self.environment(
                path: "/private/var/folders/x/AppTranslocation/y/d/OpenClaw.app",
                candidates: [self.missing(destination, writable: true)]))

        #expect(recommendation == .offerInstall(destination: destination, replacing: false))
    }

    @Test
    func `equal or newer installed build receives handoff`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        for build in ["100", "110"] {
            let installed = ApplicationRelocator.ApplicationIdentity(
                bundleIdentifier: self.current.bundleIdentifier,
                buildVersion: build)
            let recommendation = ApplicationRelocator.recommendation(
                for: self.environment(
                    path: "/Users/tester/Downloads/OpenClaw.app",
                    candidates: [self.installed(destination, identity: installed)]))
            #expect(recommendation == .handOff(destination))
        }
    }

    @Test
    func `older installed build can be replaced`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let installed = ApplicationRelocator.ApplicationIdentity(
            bundleIdentifier: self.current.bundleIdentifier,
            buildVersion: "90")
        let recommendation = ApplicationRelocator.recommendation(
            for: self.environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                candidates: [self.installed(destination, identity: installed)]))

        #expect(recommendation == .offerInstall(destination: destination, replacing: true))
    }

    @Test
    func `different same named app is never replaced`() {
        let systemDestination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let userDestination = self.home.appendingPathComponent("Applications/OpenClaw.app")
        let unrelated = ApplicationRelocator.ApplicationIdentity(
            bundleIdentifier: "example.unrelated",
            buildVersion: "999")
        let recommendation = ApplicationRelocator.recommendation(
            for: self.environment(
                path: "/Users/tester/Desktop/OpenClaw.app",
                candidates: [
                    self.installed(systemDestination, identity: unrelated),
                    self.missing(userDestination, writable: true),
                ]))

        #expect(recommendation == .offerInstall(destination: userDestination, replacing: false))
    }

    @Test
    func `untrusted same identity app never receives handoff`() {
        let systemDestination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let userDestination = self.home.appendingPathComponent("Applications/OpenClaw.app")
        let recommendation = ApplicationRelocator.recommendation(
            for: self.environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                candidates: [
                    self.installed(systemDestination, identity: self.current, trusted: false),
                    self.missing(userDestination, writable: true),
                ]))

        #expect(recommendation == .offerInstall(destination: userDestination, replacing: false))
    }

    @Test
    func `unwritable destinations require manual installation`() {
        let recommendation = ApplicationRelocator.recommendation(
            for: self.environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                candidates: [
                    self.missing(URL(fileURLWithPath: "/Applications/OpenClaw.app"), writable: false),
                    self.missing(self.home.appendingPathComponent("Applications/OpenClaw.app"), writable: false),
                ]))

        #expect(recommendation == .cannotInstall)
    }

    @Test
    func `launch at login hydration does not persist the current bundle path`() {
        #expect(!AppState.shouldPersistLaunchAtLoginChange(
            isInitializing: false,
            isHydrating: true,
            isEnabling: true,
            bundleLocationAllowsPersistentIntegration: true))
        #expect(!AppState.shouldPersistLaunchAtLoginChange(
            isInitializing: false,
            isHydrating: false,
            isEnabling: true,
            bundleLocationAllowsPersistentIntegration: false))
        #expect(AppState.shouldPersistLaunchAtLoginChange(
            isInitializing: false,
            isHydrating: false,
            isEnabling: false,
            bundleLocationAllowsPersistentIntegration: false))
    }

    private func environment(
        path: String,
        candidates: [ApplicationRelocator.InstallCandidate] = [],
        readOnlyVolume: Bool = false,
        debugOrTesting: Bool = false) -> ApplicationRelocator.Environment
    {
        ApplicationRelocator.Environment(
            bundleURL: URL(fileURLWithPath: path),
            homeDirectory: self.home,
            currentIdentity: self.current,
            candidates: candidates,
            isReadOnlyVolume: readOnlyVolume,
            isDebugOrTesting: debugOrTesting)
    }

    private func missing(_ url: URL, writable: Bool) -> ApplicationRelocator.InstallCandidate {
        ApplicationRelocator.InstallCandidate(
            url: url,
            exists: false,
            isWritable: writable,
            isTrusted: false,
            identity: nil)
    }

    private func installed(
        _ url: URL,
        identity: ApplicationRelocator.ApplicationIdentity,
        trusted: Bool = true) -> ApplicationRelocator.InstallCandidate
    {
        ApplicationRelocator.InstallCandidate(
            url: url,
            exists: true,
            isWritable: true,
            isTrusted: trusted,
            identity: identity)
    }
}
