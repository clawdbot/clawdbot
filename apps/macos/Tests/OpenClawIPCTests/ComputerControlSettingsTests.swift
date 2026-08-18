import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

struct ComputerControlSettingsTests {
    @Test func `computer control defaults on while preserving explicit choices`() throws {
        let suiteName = "ComputerControlSettingsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(isComputerControlEnabled(defaults: defaults))

        defaults.set(false, forKey: computerControlEnabledKey)
        #expect(!isComputerControlEnabled(defaults: defaults))

        defaults.set(true, forKey: computerControlEnabledKey)
        #expect(isComputerControlEnabled(defaults: defaults))
    }

    @Test func `computer control provider defaults to Peekaboo and preserves CUA selection`() throws {
        let suiteName = "ComputerControlProviderSettingsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: true) == .peekaboo)
        defaults.set(ComputerControlProvider.cua.rawValue, forKey: computerControlProviderKey)
        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: true) == .cua)
        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: false) == .peekaboo)
        defaults.set("retired-provider", forKey: computerControlProviderKey)
        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: true) == .peekaboo)
    }

    @Test func `elevation host ignores enabled CUA defaults while normal launches preserve them`() throws {
        let suiteName = "ComputerControlElevationHostTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(true, forKey: computerControlEnabledKey)
        defaults.set(ComputerControlProvider.cua.rawValue, forKey: computerControlProviderKey)

        #expect(isComputerControlEnabled(defaults: defaults))
        #expect(ComputerControlProvider.current(
            defaults: defaults,
            cuaAvailable: true,
            launchPlan: AppLaunchRuntimePlan(arguments: ["OpenClaw"])) == .cua)
        #expect(ComputerControlProvider.current(
            defaults: defaults,
            cuaAvailable: true,
            launchPlan: AppLaunchRuntimePlan(arguments: ["OpenClaw", "--elevation-host"])) == .peekaboo)
    }

    @Test func `bundled CUA locator accepts only a regular executable and never follows a symlink`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-cua-artifact-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let binary = root.appendingPathComponent(CuaDriverArtifact.resourceName)
        try Data("driver".utf8).write(to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        #expect(CuaDriverArtifact.executableURL(in: root) == binary)

        try FileManager.default.removeItem(at: binary)
        let target = root.appendingPathComponent("real-driver")
        try Data("driver".utf8).write(to: target)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
        try FileManager.default.createSymbolicLink(at: binary, withDestinationURL: target)
        #expect(CuaDriverArtifact.executableURL(in: root) == nil)
    }

    @Test func `CUA worker endpoint uses versioned JSON with escaped paths`() throws {
        let endpoint = CuaDriverWorkerEndpoint(
            socketPath: #"/tmp/openclaw-"quoted"/cua.sock"#,
            binaryPath: #"/Applications/OpenClaw\Test.app/Contents/Resources/cua-driver"#)

        let value = try endpoint.environmentValue()
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])

        #expect(decoded.count == 3)
        #expect(decoded["v"] as? Int == 1)
        #expect(decoded["socketPath"] as? String == endpoint.socketPath)
        #expect(decoded["binaryPath"] as? String == endpoint.binaryPath)
    }

    @Test func `readiness rows never promote unknown or unavailable state`() {
        struct Scenario {
            let provider: ComputerControlProvider
            let cuaDriverAvailable: Bool
            let permissions: [Capability: CapabilityAuthorizationStatus]
            let cuaDaemonReady: Bool?
            let expectedStatuses: [ComputerControlReadinessRow.Status]
        }

        let granted: [Capability: CapabilityAuthorizationStatus] = [
            .accessibility: .granted,
            .screenRecording: .granted,
        ]
        let scenarios = [
            Scenario(
                provider: .peekaboo,
                cuaDriverAvailable: false,
                permissions: granted,
                cuaDaemonReady: nil,
                expectedStatuses: [.available, .granted, .granted]),
            Scenario(
                provider: .cua,
                cuaDriverAvailable: true,
                permissions: granted,
                cuaDaemonReady: true,
                expectedStatuses: [.available, .granted, .granted, .running]),
            Scenario(
                provider: .cua,
                cuaDriverAvailable: true,
                permissions: [:],
                cuaDaemonReady: nil,
                expectedStatuses: [.available, .unknown, .unknown, .unknown]),
            Scenario(
                provider: .cua,
                cuaDriverAvailable: true,
                permissions: [.accessibility: .notGranted, .screenRecording: .notGranted],
                cuaDaemonReady: false,
                expectedStatuses: [.available, .notGranted, .notGranted, .notReady]),
            Scenario(
                provider: .cua,
                cuaDriverAvailable: false,
                permissions: granted,
                cuaDaemonReady: true,
                expectedStatuses: [.unavailable, .granted, .granted, .unavailable]),
        ]

        for scenario in scenarios {
            let rows = ComputerControlReadinessPresentation.rows(
                provider: scenario.provider,
                cuaDriverAvailable: scenario.cuaDriverAvailable,
                permissions: scenario.permissions,
                cuaDaemonReady: scenario.cuaDaemonReady)
            #expect(rows.map(\.status) == scenario.expectedStatuses)
            for row in rows {
                switch row.status {
                case .available, .granted, .running:
                    #expect(row.nextStep == nil)
                case .unavailable, .notGranted, .notReady, .unknown:
                    #expect(row.nextStep?.isEmpty == false)
                }
            }
        }
    }
}
