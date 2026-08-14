import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CuaDriverHostCoordinatorTests {
    private func waitForReadyLaunch(
        _ expected: Int,
        launcher: CuaProcessLauncherProbe,
        coordinator: CuaDriverHostCoordinator) async -> Bool
    {
        for _ in 0..<1000 {
            if launcher.launches.count >= expected, coordinator.workerEndpoint != nil { return true }
            await Task.yield()
        }
        return launcher.launches.count >= expected && coordinator.workerEndpoint != nil
    }

    @Test func `disabled host never spawns and enabled host publishes only a ready endpoint`() async throws {
        let root = self.shortTemporaryDirectory("host")
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appendingPathComponent("cua-driver")
        let launcher = CuaProcessLauncherProbe()
        var workerStops = 0
        let coordinator = CuaDriverHostCoordinator(
            artifactURL: { executable },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            beforeDaemonStop: {
                let allRunning = launcher.processes.allSatisfy(\.isRunning)
                #expect(allRunning)
                workerStops += 1
            })

        await coordinator.setEnabled(false)
        #expect(launcher.launches.isEmpty)
        #expect(coordinator.workerEndpoint == nil)

        await coordinator.setEnabled(true)
        let launch = try #require(launcher.launches.first)
        let endpoint = try #require(coordinator.workerEndpoint)
        #expect(launch.executableURL == executable)
        #expect(endpoint.binaryPath == executable.path)
        let socketArgument = try #require(launch.arguments.firstIndex(of: "--socket")) + 1
        #expect(endpoint.socketPath == launch.arguments[socketArgument])

        await coordinator.setEnabled(false)
        #expect(coordinator.workerEndpoint == nil)
        #expect(workerStops == 1)
        #expect(launcher.processes.allSatisfy { !$0.isRunning })
    }

    @Test func `socket directory is random owner-only and cleanup removes only its owned leaf`() throws {
        let root = self.shortTemporaryDirectory("socket")
        defer { try? FileManager.default.removeItem(at: root) }

        let first = try CuaDriverHostCoordinator.createSocketDirectory(in: root)
        let second = try CuaDriverHostCoordinator.createSocketDirectory(in: root)
        #expect(first.url != second.url)
        for directory in [first, second] {
            let attributes = try FileManager.default.attributesOfItem(atPath: directory.url.path)
            let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue
            #expect(permissions == 0o700)
            #expect(!FileManager.default.fileExists(atPath: directory.socketPath))
        }

        CuaDriverHostCoordinator.cleanupSocketDirectory(first)
        #expect(!FileManager.default.fileExists(atPath: first.url.path))
        #expect(FileManager.default.fileExists(atPath: second.url.path))
        CuaDriverHostCoordinator.cleanupSocketDirectory(second)
    }

    @Test func `socket directory rejects a symlinked CUA root`() throws {
        let root = self.shortTemporaryDirectory("unsafe")
        defer { try? FileManager.default.removeItem(at: root) }
        let openClaw = root.appendingPathComponent("OpenClaw", isDirectory: true)
        let redirected = root.appendingPathComponent("redirected", isDirectory: true)
        try FileManager.default.createDirectory(at: openClaw, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: redirected, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: openClaw.appendingPathComponent("cua", isDirectory: true),
            withDestinationURL: redirected)

        #expect(throws: CuaDriverHostError.self) {
            try CuaDriverHostCoordinator.createSocketDirectory(in: root)
        }
        #expect(try (FileManager.default.contentsOfDirectory(atPath: redirected.path)).isEmpty)
    }

    @Test func `socket directory rejects a symlinked OpenClaw support root`() throws {
        let root = self.shortTemporaryDirectory("unsafe-parent")
        defer { try? FileManager.default.removeItem(at: root) }
        let redirected = root.appendingPathComponent("redirected", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: redirected, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("OpenClaw", isDirectory: true),
            withDestinationURL: redirected)

        #expect(throws: CuaDriverHostError.self) {
            try CuaDriverHostCoordinator.createSocketDirectory(in: root)
        }
        #expect(try (FileManager.default.contentsOfDirectory(atPath: redirected.path)).isEmpty)
    }

    @Test func `embedded launch carries unrestricted acknowledgement and disables network reporting`() {
        let launch = CuaDriverHostCoordinator.makeProcessLaunch(
            executableURL: URL(fileURLWithPath: "/Applications/OpenClaw.app/Contents/Resources/cua-driver"),
            socketPath: "/tmp/openclaw-cua-test.sock",
            hostBundleID: "ai.openclaw.mac",
            inheritedEnvironment: [
                "PATH": "/usr/bin:/bin",
                "CUA_DRIVER_SOCKET": "/tmp/ambient.sock",
                "CUA_DRIVER_PERMISSION_MODE": "bounded",
                "CUA_TELEMETRY_ENABLED": "true",
            ])

        #expect(launch.arguments.contains("--embedded"))
        #expect(launch.arguments.contains("--parent-liveness-stdio"))
        #expect(launch.arguments.contains("--dangerously-bypass-approvals"))
        #expect(launch.environment["CUA_DRIVER_EMBEDDED"] == "1")
        #expect(launch.environment["CUA_DRIVER_PERMISSION_MODE"] == "unrestricted")
        #expect(launch.environment["CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS"] == "1")
        #expect(launch.environment["CUA_DRIVER_RS_TELEMETRY_ENABLED"] == "false")
        #expect(launch.environment["CUA_DRIVER_RS_UPDATE_CHECK"] == "false")
        #expect(launch.environment["CUA_DRIVER_SOCKET"] == nil)
        #expect(launch.environment["CUA_TELEMETRY_ENABLED"] == nil)
        #expect(launch.environment["PATH"] == "/usr/bin:/bin")
    }

    @Test func `unexpected exits retry with a bounded budget while advertising unavailable`() async throws {
        let root = self.shortTemporaryDirectory("restart")
        defer { try? FileManager.default.removeItem(at: root) }
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            artifactURL: { root.appendingPathComponent("cua-driver") },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            restartSleep: { _ in })

        await coordinator.setEnabled(true)
        for expectedLaunchCount in 2...6 {
            try #require(launcher.processes.last).crash(status: 7)
            #expect(await self.waitForReadyLaunch(
                expectedLaunchCount,
                launcher: launcher,
                coordinator: coordinator))
        }
        try #require(launcher.processes.last).crash(status: 7)
        for _ in 0..<100 {
            await Task.yield()
        }
        #expect(launcher.launches.count == 6)
        #expect(coordinator.workerEndpoint == nil)
        await coordinator.setEnabled(false)
    }

    @Test func `permission changes replace the daemon generation and endpoint`() async throws {
        let root = self.shortTemporaryDirectory("permissions")
        defer { try? FileManager.default.removeItem(at: root) }
        let notifications = NotificationCenter()
        let permissions = CuaPermissionSnapshotProbe()
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: notifications,
            observeNotifications: true,
            artifactURL: { root.appendingPathComponent("cua-driver") },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { permissions.value })

        await coordinator.setEnabled(true)
        let originalEndpoint = try #require(coordinator.workerEndpoint)
        permissions.value[.accessibility] = .granted
        notifications.post(name: .openclawPermissionsChanged, object: nil)
        #expect(await self.waitForReadyLaunch(2, launcher: launcher, coordinator: coordinator))
        let replacementEndpoint = try #require(coordinator.workerEndpoint)
        #expect(replacementEndpoint.socketPath != originalEndpoint.socketPath)
        #expect(!launcher.processes[0].isRunning)
        await coordinator.setEnabled(false)
    }

    private func shortTemporaryDirectory(_ label: String) -> URL {
        URL(fileURLWithPath: "/tmp/oc-cua-\(label)-\(UUID().uuidString.prefix(8))", isDirectory: true)
    }
}

@MainActor
private final class CuaPermissionSnapshotProbe {
    var value: [Capability: CapabilityAuthorizationStatus] = [
        .accessibility: .notGranted,
        .screenRecording: .notGranted,
    ]
}

@MainActor
private final class CuaProcessLauncherProbe {
    private(set) var launches: [CuaDriverProcessLaunch] = []
    private(set) var processes: [CuaProcessProbe] = []

    func launch(
        _ launch: CuaDriverProcessLaunch,
        onTermination: @escaping @Sendable (Int32) -> Void) -> CuaProcessProbe
    {
        self.launches.append(launch)
        let process = CuaProcessProbe(onTermination: onTermination)
        self.processes.append(process)
        return process
    }
}

@MainActor
private final class CuaProcessProbe: CuaDriverProcessControlling {
    private(set) var isRunning = true
    private let onTermination: @Sendable (Int32) -> Void

    init(onTermination: @escaping @Sendable (Int32) -> Void) {
        self.onTermination = onTermination
    }

    func closeLiveness() {
        guard self.isRunning else { return }
        self.isRunning = false
        self.onTermination(0)
    }

    func terminate() {
        self.closeLiveness()
    }

    func forceKill() {
        self.closeLiveness()
    }

    func crash(status: Int32) {
        guard self.isRunning else { return }
        self.isRunning = false
        self.onTermination(status)
    }
}
