import Darwin
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
struct AppProfileTests {
    @Test func `default profile preserves historical identities`() {
        if AppProfile.current.name == nil, AppProfile.current.validationError == nil {
            #expect(AppDefaults.standard === UserDefaults.standard)
        }
        for raw in [nil, "", " default ", "Default"] {
            let profile = AppProfile(environment: raw.map { ["OPENCLAW_PROFILE": $0] } ?? [:])
            #expect(profile.name == nil)
            #expect(profile.validationError == nil)
            #expect(profile.gatewayLaunchAgentLabel == "ai.openclaw.gateway")
            #expect(profile.defaultsSuiteName == nil)
            #expect(profile.keychainService(base: "ai.openclaw.test") == "ai.openclaw.test")
            #expect(GatewayTLSStore.resolvedKeychainService(suffix: profile.keychainServiceSuffix) ==
                "ai.openclaw.tls-pinning")
            #expect(profile.stateDirectoryURL(homeDirectory: URL(fileURLWithPath: "/Users/test")).path ==
                "/Users/test/.openclaw")
            #expect(profile.cliRootArguments.isEmpty)
        }
    }

    @Test func `current profile scopes credential service identities`() {
        let suffix = AppProfile.current.name.map { ".profile.\($0)" } ?? ""
        #if DEBUG
        #expect(MacGatewayProfileStore.service == "ai.openclaw.gateway-profiles.debug\(suffix)")
        #expect(GatewayActivationBindingKeyStore.service == "ai.openclaw.onboarding-route-binding.debug\(suffix)")
        #else
        #expect(MacGatewayProfileStore.service == "ai.openclaw.gateway-profiles\(suffix)")
        #expect(GatewayActivationBindingKeyStore.service == "ai.openclaw.onboarding-route-binding\(suffix)")
        #endif
    }

    @Test func `named profile owns every persistent namespace`() {
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "work_2"])
        #expect(profile.name == "work_2")
        #expect(profile.validationError == nil)
        #expect(profile.gatewayLaunchAgentLabel == "ai.openclaw.work_2")
        #expect(profile.defaultsSuiteName == "ai.openclaw.mac.profile.work_2")
        #expect(profile.keychainService(base: "ai.openclaw.test") == "ai.openclaw.test.profile.work_2")
        #expect(profile.stateDirectoryURL(homeDirectory: URL(fileURLWithPath: "/Users/test")).path ==
            "/Users/test/.openclaw-work_2")
        #expect(profile.stateDirectoryURL(homeDirectory: URL(fileURLWithPath: "/Users/test")) !=
            AppProfile(environment: ["OPENCLAW_PROFILE": "personal"])
            .stateDirectoryURL(homeDirectory: URL(fileURLWithPath: "/Users/test")))
        #expect(profile.cliRootArguments == ["--profile", "work_2"])
        #expect(GatewayTLSStore.resolvedKeychainService(suffix: profile.keychainServiceSuffix) ==
            "ai.openclaw.tls-pinning.profile.work_2")
        #expect(CommandResolver.nodeHostWorkerCommand(
            prefix: ["/usr/bin/node", "/repo/scripts/run-node.mjs"],
            profile: profile) == [
            "/usr/bin/node", "/repo/scripts/run-node.mjs", "--profile", "work_2", "node", "worker",
        ])
        #expect(CommandResolver.nodeHostWorkerCommand(
            prefix: ["/opt/openclaw"],
            profile: profile) == [
            "/opt/openclaw", "--profile", "work_2", "node", "worker",
        ])
    }

    @Test func `default worker commands preserve exact argument shapes`() {
        let profile = AppProfile(environment: [:])
        #expect(CommandResolver.nodeHostWorkerCommand(
            prefix: ["/usr/bin/node", "/repo/scripts/run-node.mjs"],
            profile: profile) == ["/usr/bin/node", "/repo/scripts/run-node.mjs", "node", "worker"])
        #expect(CommandResolver.nodeHostWorkerCommand(
            prefix: ["/opt/openclaw"],
            profile: profile) == ["/opt/openclaw", "node", "worker"])
    }

    @Test func `invalid and colliding profile names fail closed`() {
        let invalid = [
            "_work", "work space", "work/escape", String(repeating: "a", count: 65),
            "Work", "gateway", "mac", "node",
        ]
        for raw in invalid {
            let profile = AppProfile(environment: ["OPENCLAW_PROFILE": raw])
            #expect(profile.name == nil)
            #expect(profile.validationError != nil)
        }
        #expect(AppProfile(environment: ["OPENCLAW_PROFILE": String(repeating: "a", count: 64)]).name != nil)
    }

    @Test func `colliding profile apps cannot reserve the same exact port`() throws {
        let root = try self.makeReservationRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let first = ProfileGatewayPortReservation.acquire(
            profile: AppProfile(environment: ["OPENCLAW_PROFILE": "p1402"]),
            port: 55636,
            homeDirectory: home,
            temporaryDirectory: root)
        let second = ProfileGatewayPortReservation.acquire(
            profile: AppProfile(environment: ["OPENCLAW_PROFILE": "p2380"]),
            port: 55636,
            homeDirectory: home,
            temporaryDirectory: root)

        #expect(first.conflict == nil)
        #expect(second.conflict?.contains("p2380") == true)
        #expect(second.conflict?.contains("reservation reserves") == false)
    }

    @Test func `persisted other profile gateway reserves its exact port`() throws {
        let root = try self.makeReservationRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home", isDirectory: true)
        let agents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        try FileManager.default.createDirectory(at: agents, withIntermediateDirectories: true)
        let serviceEnv = home.appendingPathComponent(".openclaw-p1402/service-env", isDirectory: true)
        try FileManager.default.createDirectory(at: serviceEnv, withIntermediateDirectories: true)
        let wrapper = serviceEnv.appendingPathComponent("ai.openclaw.p1402-env-wrapper.sh")
        let environment = serviceEnv.appendingPathComponent("ai.openclaw.p1402.env")
        try Data("#!/bin/sh\n".utf8).write(to: wrapper)
        try Data("""
        export OPENCLAW_SERVICE_MARKER='openclaw'
        export OPENCLAW_SERVICE_KIND='gateway'

        """.utf8).write(to: environment)
        let data = try PropertyListSerialization.data(
            fromPropertyList: [
                "ProgramArguments": [
                    "/bin/sh", wrapper.path, environment.path,
                    "node", "openclaw.mjs", "gateway", "--port", "55636",
                ],
            ],
            format: .xml,
            options: 0)
        try data.write(to: agents.appendingPathComponent("ai.openclaw.p1402.plist"))

        let reservation = ProfileGatewayPortReservation.acquire(
            profile: AppProfile(environment: ["OPENCLAW_PROFILE": "p2380"]),
            port: 55636,
            homeDirectory: home,
            temporaryDirectory: root)

        #expect(reservation.conflict?.contains("profile \"p1402\"") == true)
    }

    private func makeReservationRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("app-profile-port-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        return root
    }

    @MainActor @Test func `profile lock excludes only the same profile`() throws {
        #expect(AppDelegate.processExitCode(for: .busy) == 0)
        #expect(AppDelegate.processExitCode(for: .failed("test")) == nil)
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("app-profile-lock-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        let defaultProfile = AppProfile(environment: [:])
        let workProfile = AppProfile(environment: ["OPENCLAW_PROFILE": "work"])
        let defaultURL = defaultProfile.instanceLockURL(systemTemporaryDirectory: root)
        let namedURL = workProfile.instanceLockURL(systemTemporaryDirectory: root)
        #expect(defaultURL != namedURL)
        #expect(workProfile.instanceLockURL(systemTemporaryDirectory: root) ==
            AppProfile(environment: [
                "OPENCLAW_PROFILE": "work",
                "OPENCLAW_STATE_DIR": "/different/state",
            ]).instanceLockURL(systemTemporaryDirectory: root))
        var defaultLock: AppInstanceLock?
        switch AppInstanceLock.acquire(url: defaultURL) {
        case let .acquired(lock): defaultLock = lock
        case .busy, .failed: Issue.record("Expected default lock acquisition")
        }
        if case .busy = AppInstanceLock.acquire(url: defaultURL) {} else {
            Issue.record("Expected same-profile lock rejection")
        }
        var namedLock: AppInstanceLock?
        switch AppInstanceLock.acquire(url: namedURL) {
        case let .acquired(lock): namedLock = lock
        case .busy, .failed: Issue.record("Expected cross-profile lock acquisition")
        }
        #expect(defaultLock != nil)
        #expect(namedLock != nil)
        let defaultAttributes = try FileManager.default.attributesOfItem(
            atPath: defaultURL.deletingLastPathComponent().path)
        #expect((defaultAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        defaultLock = nil
        namedLock = nil
        if case .acquired = AppInstanceLock.acquire(url: defaultURL) {} else {
            Issue.record("Expected released default lock to transfer")
        }
        var namedFirst: AppInstanceLock?
        if case let .acquired(lock) = AppInstanceLock.acquire(url: namedURL) {
            namedFirst = lock
        } else {
            Issue.record("Expected named-first lock acquisition")
        }
        if case .acquired = AppInstanceLock.acquire(url: defaultURL) {} else {
            Issue.record("Expected named-to-default coexistence")
        }
        #expect(namedFirst != nil)
    }

    @Test func `profile lock reports unsafe ownership errors`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("app-profile-lock-error-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        let target = root.appendingPathComponent("target")
        let link = root.appendingPathComponent("app-instance.lock")
        try Data().write(to: target)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        if case .failed = AppInstanceLock.acquire(url: link) {} else {
            Issue.record("Expected symlink lock rejection")
        }

        let unsafeURL = AppProfile(environment: ["OPENCLAW_PROFILE": "unsafe"])
            .instanceLockURL(systemTemporaryDirectory: root)
        let unsafe = unsafeURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: unsafe, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: unsafe.path)
        if case .failed = AppInstanceLock.acquire(url: unsafeURL) {} else {
            Issue.record("Expected unsafe state directory rejection")
        }
    }

    @Test func `long profile approvals socket uses deterministic private short path`() {
        let longState = URL(fileURLWithPath: "/Users/" + String(repeating: "very-long/", count: 16))
        let first = ExecApprovalsStore.socketPath(stateDirectoryURL: longState, profileActive: true)
        let second = ExecApprovalsStore.socketPath(stateDirectoryURL: longState, profileActive: true)
        #expect(first == second)
        #expect(first.hasPrefix("/tmp/openclaw-\(geteuid())/exec-approvals-"))
        #expect(first.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path))
        #expect(ExecApprovalsStore.socketPath(stateDirectoryURL: longState, profileActive: false)
            .hasPrefix(longState.path))
        let oldCanonical = longState.appendingPathComponent("exec-approvals.sock").path
        #expect(ExecApprovalsStore.resolvedPersistedSocketPath(
            existing: nil,
            stateDirectoryURL: longState,
            computed: first) == first)
        #expect(ExecApprovalsStore.resolvedPersistedSocketPath(
            existing: oldCanonical,
            stateDirectoryURL: longState,
            computed: first) == first)
        #expect(ExecApprovalsStore.resolvedPersistedSocketPath(
            existing: "/custom/approvals.sock",
            stateDirectoryURL: longState,
            computed: first) == "/custom/approvals.sock")
    }
}
