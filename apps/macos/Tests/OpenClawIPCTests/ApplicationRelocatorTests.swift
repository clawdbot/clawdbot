import Foundation
@testable import OpenClaw
import Testing

@Suite("Application Relocator Tests")
@MainActor
struct ApplicationRelocatorTests {
    private let home = URL(fileURLWithPath: "/Users/tester")
    private let current = ApplicationRelocator.ApplicationIdentity(
        bundleIdentifier: "ai.openclaw.mac",
        buildVersion: "100"
    )

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
                for: environment(path: path, readOnlyVolume: false)
            )
            #expect(recommendation == .continueLaunch)
        }
    }

    @Test
    func `debug and test builds never relocate`() {
        let recommendation = ApplicationRelocator.recommendation(
            for: environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                debugOrTesting: true
            )
        )

        #expect(recommendation == .continueLaunch)
    }

    @Test
    func `transient copy offers system installation when available`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let recommendation = ApplicationRelocator.recommendation(
            for: environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                candidates: [missing(destination, writable: true)]
            )
        )

        #expect(recommendation == .offerInstall(destination: destination, replacing: false))
    }

    @Test
    func `read only mounted copy offers installation`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let recommendation = ApplicationRelocator.recommendation(
            for: environment(
                path: "/Volumes/OpenClaw/OpenClaw.app",
                candidates: [missing(destination, writable: true)],
                readOnlyVolume: true
            )
        )

        #expect(recommendation == .offerInstall(destination: destination, replacing: false))
    }

    @Test
    func `translocated copy offers installation`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let recommendation = ApplicationRelocator.recommendation(
            for: environment(
                path: "/private/var/folders/x/AppTranslocation/y/d/OpenClaw.app",
                candidates: [missing(destination, writable: true)]
            )
        )

        #expect(recommendation == .offerInstall(destination: destination, replacing: false))
    }

    @Test
    func `equal or newer installed build receives handoff`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        for build in ["100", "110"] {
            let installed = ApplicationRelocator.ApplicationIdentity(
                bundleIdentifier: current.bundleIdentifier,
                buildVersion: build
            )
            let recommendation = ApplicationRelocator.recommendation(
                for: environment(
                    path: "/Users/tester/Downloads/OpenClaw.app",
                    candidates: [self.installed(destination, identity: installed)]
                )
            )
            #expect(recommendation == .handOff(destination))
        }
    }

    @Test
    func `older installed build can be replaced`() {
        let destination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let installed = ApplicationRelocator.ApplicationIdentity(
            bundleIdentifier: current.bundleIdentifier,
            buildVersion: "90"
        )
        let recommendation = ApplicationRelocator.recommendation(
            for: environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                candidates: [self.installed(destination, identity: installed)]
            )
        )

        #expect(recommendation == .offerInstall(destination: destination, replacing: true))
    }

    @Test
    func `different same named app is never replaced`() {
        let systemDestination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let userDestination = home.appendingPathComponent("Applications/OpenClaw.app")
        let unrelated = ApplicationRelocator.ApplicationIdentity(
            bundleIdentifier: "example.unrelated",
            buildVersion: "999"
        )
        let recommendation = ApplicationRelocator.recommendation(
            for: environment(
                path: "/Users/tester/Desktop/OpenClaw.app",
                candidates: [
                    installed(systemDestination, identity: unrelated),
                    missing(userDestination, writable: true),
                ]
            )
        )

        #expect(recommendation == .offerInstall(destination: userDestination, replacing: false))
    }

    @Test
    func `untrusted same identity app never receives handoff`() {
        let systemDestination = URL(fileURLWithPath: "/Applications/OpenClaw.app")
        let userDestination = home.appendingPathComponent("Applications/OpenClaw.app")
        let recommendation = ApplicationRelocator.recommendation(
            for: environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                candidates: [
                    installed(systemDestination, identity: current, trusted: false),
                    missing(userDestination, writable: true),
                ]
            )
        )

        #expect(recommendation == .offerInstall(destination: userDestination, replacing: false))
    }

    @Test
    func `unwritable destinations require manual installation`() {
        let recommendation = ApplicationRelocator.recommendation(
            for: environment(
                path: "/Users/tester/Downloads/OpenClaw.app",
                candidates: [
                    missing(URL(fileURLWithPath: "/Applications/OpenClaw.app"), writable: false),
                    missing(home.appendingPathComponent("Applications/OpenClaw.app"), writable: false),
                ]
            )
        )

        #expect(recommendation == .cannotInstall)
    }

    @Test
    func `unchanged executable does not relaunch`() {
        let launched = Data([10])

        let action = ApplicationRelocator.replacementAction(
            launchedCodeDirectoryHash: launched,
            installedCodeDirectoryHash: launched,
            sameBundleIdentifier: true,
            trusted: true
        )

        #expect(action == .unchanged)
    }

    @Test
    func `missing or untrusted replacement waits`() {
        let launched = Data([10])
        let replacement = Data([11])

        #expect(ApplicationRelocator.replacementAction(
            launchedCodeDirectoryHash: launched,
            installedCodeDirectoryHash: nil,
            sameBundleIdentifier: true,
            trusted: true
        ) == .waitForTrustedReplacement)
        #expect(ApplicationRelocator.replacementAction(
            launchedCodeDirectoryHash: launched,
            installedCodeDirectoryHash: replacement,
            sameBundleIdentifier: true,
            trusted: false
        ) == .waitForTrustedReplacement)
        #expect(ApplicationRelocator.replacementAction(
            launchedCodeDirectoryHash: launched,
            installedCodeDirectoryHash: replacement,
            sameBundleIdentifier: false,
            trusted: true
        ) == .waitForTrustedReplacement)
    }

    @Test
    func `trusted replacement relaunches`() {
        let launched = Data([10])
        let replacement = Data([11])

        let action = ApplicationRelocator.replacementAction(
            launchedCodeDirectoryHash: launched,
            installedCodeDirectoryHash: replacement,
            sameBundleIdentifier: true,
            trusted: true
        )

        #expect(action == .relaunch)
    }

    @Test
    func `unauthenticated replacement marker cannot bypass duplicate launch rejection`() {
        let forgedHandoff = [
            "OPENCLAW_REPLACEMENT_SOURCE_BUNDLE": "/Applications/OpenClaw.app",
            "OPENCLAW_REPLACEMENT_PARENT_PID": "1",
            "OPENCLAW_REPLACEMENT_CODE_HASH": "ZmFrZQ==",
            "OPENCLAW_REPLACEMENT_READY_FD": "19",
        ]
        #expect(ApplicationRelocator.hasReplacementHandoffMetadata(environment: forgedHandoff))
        #expect(!ApplicationRelocator.acceptReplacementHandoff(environment: forgedHandoff))
        #expect(!ApplicationRelocator.acceptReplacementHandoff(environment: [:]))
        #expect(!ApplicationRelocator.acceptReplacementHandoff(environment: [
            "OPENCLAW_REPLACEMENT_SOURCE_BUNDLE": "relative/OpenClaw.app",
        ]))
    }

    @Test
    func `kernel team identifier skips csops token header`() {
        let teamBlob = [UInt8](repeating: 0, count: 8) + Array("example-team".utf8) + [0]

        #expect(ApplicationRelocator.teamIdentifier(fromCSOpsToken: teamBlob) == "example-team")
        #expect(ApplicationRelocator.teamIdentifier(fromCSOpsToken: [0, 0, 0]) == nil)
    }

    @Test
    func `replacement requirement preserves Developer ID certificate class`() {
        let requirement = ApplicationRelocator.developerIDRequirementString(
            bundleIdentifier: "ai.openclaw.mac",
            teamIdentifier: "Y5PE65HELJ"
        )

        #expect(requirement?.contains("1.2.840.113635.100.6.2.6") == true)
        #expect(requirement?.contains("1.2.840.113635.100.6.1.13") == true)
        #expect(requirement?.contains("subject.OU] = \"Y5PE65HELJ\"") == true)
        #expect(ApplicationRelocator.developerIDRequirementString(
            bundleIdentifier: "ai.openclaw.mac\" or true",
            teamIdentifier: "Y5PE65HELJ"
        ) == nil)
    }

    @Test
    func `bundle file reference stays bound after canonical path replacement`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ApplicationRelocatorFileReferenceTests-\(UUID().uuidString)")
        let canonicalBundle = root.appendingPathComponent("OpenClaw.app", isDirectory: true)
        let archivedBundle = root.appendingPathComponent("OpenClaw.previous.app", isDirectory: true)
        let executableRelativePath = "Contents/MacOS/OpenClaw"
        let canonicalExecutable = canonicalBundle.appendingPathComponent(executableRelativePath)
        try FileManager.default.createDirectory(
            at: canonicalExecutable.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }

        try Data("validated".utf8).write(to: canonicalExecutable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: canonicalExecutable.path)
        let reference = try #require(ApplicationRelocator.bundleFileReference(
            bundleURL: canonicalBundle,
            executableURL: canonicalExecutable
        ))

        try FileManager.default.moveItem(at: canonicalBundle, to: archivedBundle)
        try FileManager.default.createDirectory(
            at: canonicalExecutable.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("unvalidated".utf8).write(to: canonicalExecutable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: canonicalExecutable.path)

        #expect(try Data(contentsOf: reference.executableURL) == Data("validated".utf8))
        #expect(try Data(contentsOf: canonicalExecutable) == Data("unvalidated".utf8))
        #expect(ApplicationRelocator.bundleFileReference(
            bundleURL: canonicalBundle,
            executableURL: canonicalExecutable
        ) != reference)
    }

    @Test
    func `replacement handoff launches the bound executable without filesystem locks`() {
        let reference = ApplicationRelocator.BundleFileReference(
            deviceIdentifier: 42,
            fileIdentifier: 99,
            executableRelativePath: "Contents/MacOS/OpenClaw"
        )

        #expect(reference.bundleURL.path == "/.vol/42/99")
        #expect(reference.executableURL.path == "/.vol/42/99/Contents/MacOS/OpenClaw")
    }

    @Test
    func `verified KeepAlive launchd supervisor retains relaunch ownership`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ApplicationRelocatorLaunchAgentTests-\(UUID().uuidString)")
        let home = root.appendingPathComponent("home")
        let executable = root.appendingPathComponent("OpenClaw.app/Contents/MacOS/OpenClaw")
        let serviceName = "ai.openclaw.mac.test-node"
        let launchAgentURL = home.appendingPathComponent("Library/LaunchAgents/\(serviceName).plist")
        try FileManager.default.createDirectory(
            at: launchAgentURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }

        try writeLaunchAgentPlist(
            at: launchAgentURL,
            label: serviceName,
            executable: executable.path,
            keepAlive: true
        )
        #expect(ApplicationRelocator.relaunchStrategy(
            xpcServiceName: serviceName,
            executableURL: executable,
            homeDirectory: home
        ) == .externalSupervisor)

        try writeLaunchAgentPlist(
            at: launchAgentURL,
            label: serviceName,
            executable: executable.path,
            keepAlive: false
        )
        #expect(ApplicationRelocator.relaunchStrategy(
            xpcServiceName: serviceName,
            executableURL: executable,
            homeDirectory: home
        ) == .openAfterTermination)
        #expect(ApplicationRelocator.relaunchStrategy(
            xpcServiceName: "application.ai.openclaw.mac.123",
            executableURL: executable,
            homeDirectory: home
        ) == .openAfterTermination)
        #expect(ApplicationRelocator.relaunchStrategy(
            xpcServiceName: nil,
            executableURL: executable,
            homeDirectory: home
        ) == .openAfterTermination)
    }

    @Test
    func `replacement metadata is read from disk instead of Bundle cache`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ApplicationRelocatorTests-\(UUID().uuidString)")
        let bundleURL = root.appendingPathComponent("OpenClaw.app")
        let contentsURL = bundleURL.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(
            at: contentsURL.appendingPathComponent("MacOS"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }

        try writeInfoPlist(
            at: contentsURL.appendingPathComponent("Info.plist"),
            bundleIdentifier: "ai.openclaw.mac",
            executable: "OpenClaw"
        )
        #expect(ApplicationRelocator.applicationOnDisk(at: bundleURL) == .init(
            bundleIdentifier: "ai.openclaw.mac",
            executableURL: contentsURL.appendingPathComponent("MacOS/OpenClaw")
        ))

        try writeInfoPlist(
            at: contentsURL.appendingPathComponent("Info.plist"),
            bundleIdentifier: "ai.openclaw.mac.replaced",
            executable: "OpenClawNext"
        )
        #expect(ApplicationRelocator.applicationOnDisk(at: bundleURL) == .init(
            bundleIdentifier: "ai.openclaw.mac.replaced",
            executableURL: contentsURL.appendingPathComponent("MacOS/OpenClawNext")
        ))
    }

    @Test
    func `launch at login hydration does not persist the current bundle path`() {
        #expect(!AppState.shouldPersistLaunchAtLoginChange(
            isInitializing: false,
            isHydrating: true,
            isEnabling: true,
            bundleLocationAllowsPersistentIntegration: true
        ))
        #expect(!AppState.shouldPersistLaunchAtLoginChange(
            isInitializing: false,
            isHydrating: false,
            isEnabling: true,
            bundleLocationAllowsPersistentIntegration: false
        ))
        #expect(AppState.shouldPersistLaunchAtLoginChange(
            isInitializing: false,
            isHydrating: false,
            isEnabling: false,
            bundleLocationAllowsPersistentIntegration: false
        ))
    }

    private func environment(
        path: String,
        candidates: [ApplicationRelocator.InstallCandidate] = [],
        readOnlyVolume: Bool = false,
        debugOrTesting: Bool = false
    ) -> ApplicationRelocator.Environment {
        ApplicationRelocator.Environment(
            bundleURL: URL(fileURLWithPath: path),
            homeDirectory: home,
            currentIdentity: current,
            candidates: candidates,
            isReadOnlyVolume: readOnlyVolume,
            isDebugOrTesting: debugOrTesting
        )
    }

    private func missing(_ url: URL, writable: Bool) -> ApplicationRelocator.InstallCandidate {
        ApplicationRelocator.InstallCandidate(
            url: url,
            exists: false,
            isWritable: writable,
            isTrusted: false,
            identity: nil
        )
    }

    private func installed(
        _ url: URL,
        identity: ApplicationRelocator.ApplicationIdentity,
        trusted: Bool = true
    ) -> ApplicationRelocator.InstallCandidate {
        ApplicationRelocator.InstallCandidate(
            url: url,
            exists: true,
            isWritable: true,
            isTrusted: trusted,
            identity: identity
        )
    }

    private func writeInfoPlist(
        at url: URL,
        bundleIdentifier: String,
        executable: String
    ) throws {
        let data = try PropertyListSerialization.data(
            fromPropertyList: [
                "CFBundleIdentifier": bundleIdentifier,
                "CFBundleExecutable": executable,
            ],
            format: .xml,
            options: 0
        )
        try data.write(to: url, options: .atomic)
    }

    private func writeLaunchAgentPlist(
        at url: URL,
        label: String,
        executable: String,
        keepAlive: Bool
    ) throws {
        let data = try PropertyListSerialization.data(
            fromPropertyList: [
                "KeepAlive": keepAlive,
                "Label": label,
                "ProgramArguments": [executable, "--attach-only"],
            ],
            format: .xml,
            options: 0
        )
        try data.write(to: url, options: .atomic)
    }
}
