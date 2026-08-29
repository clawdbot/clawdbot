import Darwin
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
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if launcher.launches.count >= expected, coordinator.workerEndpoint != nil { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return launcher.launches.count >= expected && coordinator.workerEndpoint != nil
    }

    @Test func `disabled host never spawns and enabled host publishes only a ready endpoint`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appendingPathComponent("cua-driver")
        let launcher = CuaProcessLauncherProbe()
        var workerStops = 0
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { executable },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] },
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

    @Test func `elevation host refuses CUA enablement before spawning a child`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { root.appendingPathComponent("cua-driver") },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] },
            enablementAllowed: {
                AppLaunchRuntimePlan(arguments: ["OpenClaw", "--elevation-host"]).allowsCuaComputerControl
            })

        await coordinator.setEnabled(true)

        #expect(launcher.launches.isEmpty)
        #expect(coordinator.workerEndpoint == nil)

        let normalCoordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { root.appendingPathComponent("cua-driver") },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] },
            enablementAllowed: {
                AppLaunchRuntimePlan(arguments: ["OpenClaw"]).allowsCuaComputerControl
            })
        await normalCoordinator.setEnabled(true)
        #expect(await self.waitForReadyLaunch(1, launcher: launcher, coordinator: normalCoordinator))
        await normalCoordinator.setEnabled(false)
    }

    @Test func `socket directory is random owner-only and cleanup removes only its owned leaf`() throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
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

    @Test func `liveness write end is close on exec and absent from a subsequently spawned child`() throws {
        let livenessPipe = try CuaDriverHostCoordinator.makeLivenessPipe()
        let descriptor = livenessPipe.fileHandleForWriting.fileDescriptor
        #expect(fcntl(descriptor, F_GETFD) & FD_CLOEXEC == FD_CLOEXEC)

        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["1"]
        try child.run()
        defer {
            if child.isRunning { child.terminate() }
            child.waitUntilExit()
        }
        #expect(!Self.process(child.processIdentifier, hasDescriptor: descriptor))
    }

    @Test func `liveness read end remains daemon standard input and observes writer EOF`() throws {
        let livenessPipe = try CuaDriverHostCoordinator.makeLivenessPipe()
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/cat")
        child.standardInput = livenessPipe.fileHandleForReading
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        try livenessPipe.fileHandleForWriting.close()
        for _ in 0..<1000 where child.isRunning {
            usleep(1000)
        }
        if child.isRunning { child.terminate() }
        child.waitUntilExit()

        #expect(child.terminationStatus == 0)
    }

    @Test func `unexpected exit closes liveness and removes its socket directory`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { root.appendingPathComponent("cua-driver") },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] })

        await coordinator.setEnabled(true)
        let endpoint = try #require(coordinator.workerEndpoint)
        let process = try #require(launcher.processes.first)
        process.crash(status: 7)
        for _ in 0..<1000 where coordinator.workerEndpoint != nil {
            await Task.yield()
        }

        #expect(process.closeLivenessCount == 1)
        #expect(!FileManager.default.fileExists(atPath: URL(fileURLWithPath: endpoint.socketPath)
                .deletingLastPathComponent().path))
        await coordinator.setEnabled(false)
    }

    @Test func `startup removes a preexisting owned directory without a live daemon`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let stale = try CuaDriverHostCoordinator.createSocketDirectory(in: root)
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { root.appendingPathComponent("cua-driver") },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] })

        await coordinator.setEnabled(true)
        #expect(!FileManager.default.fileExists(atPath: stale.url.path))
        await coordinator.setEnabled(false)
    }

    @Test func `startup terminates a live owned daemon after its host is gone`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = try self.expectedExecutable(in: root, target: "/bin/sleep")
        let orphan = try self.startFakeDaemon(executable: executable, hostPID: Int32.max)
        defer { self.stopIfRunning(orphan) }
        let stale = try CuaDriverHostCoordinator.createSocketDirectory(in: root)
        try String(orphan.processIdentifier).write(
            to: stale.url.appendingPathComponent("cua.pid"),
            atomically: true,
            encoding: .utf8)
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { executable },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] })

        await coordinator.setEnabled(true)

        #expect(await self.waitUntilExited(orphan))
        #expect(!FileManager.default.fileExists(atPath: stale.url.path))
        await coordinator.setEnabled(false)
    }

    @Test func `launch records the spawned daemon pid for later reaping`() async throws {
        // Without this record the reaper can only delete the directory and leaves the
        // privileged daemon running: `serve` ignores --pid-file and writes a global path.
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = try self.expectedExecutable(in: root, target: "/bin/sleep")
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { executable },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] })

        await coordinator.setEnabled(true)

        let directories = try FileManager.default.contentsOfDirectory(
            at: root.appendingPathComponent("OpenClaw", isDirectory: true)
                .appendingPathComponent("cua", isDirectory: true),
            includingPropertiesForKeys: nil)
        let pidFile = try #require(directories.first?.appendingPathComponent("cua.pid"))
        let recorded = try String(contentsOf: pidFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(recorded == String(launcher.lastProcessIdentifier))
        await coordinator.setEnabled(false)
    }

    @Test func `launch without an authoritative pid record never becomes ready`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = try self.expectedExecutable(in: root, target: "/bin/sleep")
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { executable },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                let socketIndex = try #require(launch.arguments.firstIndex(of: "--socket"))
                let socketPath = try #require(launch.arguments.indices.contains(socketIndex + 1)
                    ? launch.arguments[socketIndex + 1]
                    : nil)
                let pidFile = URL(fileURLWithPath: socketPath)
                    .deletingLastPathComponent()
                    .appendingPathComponent("cua.pid")
                try Data("incomplete".utf8).write(to: pidFile)
                return launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] })

        await coordinator.setEnabled(true)

        #expect(coordinator.workerEndpoint == nil)
        #expect(launcher.processes.count == 1)
        #expect(launcher.processes.allSatisfy { !$0.isRunning })
        await coordinator.setEnabled(false)
        let cuaRoot = root.appendingPathComponent("OpenClaw/cua", isDirectory: true)
        #expect(try FileManager.default.contentsOfDirectory(atPath: cuaRoot.path).isEmpty)
    }

    @Test func `startup refuses to signal a pid owned by another executable`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let expectedExecutable = try self.expectedExecutable(in: root, target: "/bin/cat")
        let unrelated = try self.startSleep(executable: URL(fileURLWithPath: "/bin/sleep"))
        defer { self.stopIfRunning(unrelated) }
        let stale = try CuaDriverHostCoordinator.createSocketDirectory(in: root)
        try String(unrelated.processIdentifier).write(
            to: stale.url.appendingPathComponent("cua.pid"),
            atomically: true,
            encoding: .utf8)
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { expectedExecutable },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] })

        await coordinator.setEnabled(true)

        #expect(unrelated.isRunning)
        #expect(FileManager.default.fileExists(atPath: stale.url.path))
        let launch = try #require(launcher.launches.first)
        // `serve` ignores --pid-file (it always writes the machine-global default),
        // so OpenClaw must never pass it and records the pid itself instead.
        #expect(!launch.arguments.contains("--pid-file"))
        await coordinator.setEnabled(false)
        #expect(unrelated.isRunning)
    }

    @Test func `teardown leaves no owned directories or live owned daemons`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = try self.expectedExecutable(in: root, target: "/bin/sleep")
        let orphan = try self.startFakeDaemon(executable: executable, hostPID: Int32.max)
        defer { self.stopIfRunning(orphan) }
        let live = try CuaDriverHostCoordinator.createSocketDirectory(in: root)
        try String(orphan.processIdentifier).write(
            to: live.url.appendingPathComponent("cua.pid"),
            atomically: true,
            encoding: .utf8)
        _ = try CuaDriverHostCoordinator.createSocketDirectory(in: root)
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { executable },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            permissionSnapshot: { [:] })

        await coordinator.shutdown()

        #expect(await self.waitUntilExited(orphan))
        let cuaRoot = root.appendingPathComponent("OpenClaw/cua", isDirectory: true)
        #expect(try FileManager.default.contentsOfDirectory(atPath: cuaRoot.path).isEmpty)
    }

    @Test func `socket directory rejects a symlinked CUA root`() throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
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
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
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
        // The embedded host cannot predeclare arbitrary runtime-discovered targets in a bounded manifest.
        let permissionModeIndex = launch.arguments.firstIndex(of: "--permission-mode")
        let permissionMode = permissionModeIndex.flatMap { index in
            launch.arguments.indices.contains(index + 1) ? launch.arguments[index + 1] : nil
        }
        #expect(permissionMode == "unrestricted")
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

    @Test func `stderr relay replaces the raw danger banner with one managed mode notice`() async throws {
        let probe = CuaDriverStderrProbe()
        let relay = CuaDriverStderrRelay { probe.append($0) }
        relay.startReading()
        relay.reportManagedMode()
        relay.reportManagedMode()

        let driverOutput = """
        DANGER: Cua Driver is running in unrestricted mode. Runtime approval prompts are disabled.
        driver diagnostic

        """
        // The relay's readability handler calls stop() on any empty read, which
        // closes the pipe's read end; without suppression a racing stop turns
        // this write into a harness-killing SIGPIPE.
        try TestProcessSupport.suppressSIGPIPE(relay.pipe.fileHandleForWriting)
        try relay.pipe.fileHandleForWriting.write(contentsOf: Data(driverOutput.utf8))
        try relay.pipe.fileHandleForWriting.close()
        for _ in 0..<1000 where probe.events.count < 2 {
            await Task.yield()
        }
        relay.stop()

        #expect(probe.events == [
            .notice(CuaDriverStderrRelay.managedModeNotice),
            .error("driver diagnostic"),
        ])
    }

    @Test func `unexpected exits retry with a bounded budget while advertising unavailable`() async throws {
        let delays = CuaRestartDelayProbe()
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let launcher = CuaProcessLauncherProbe()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: NotificationCenter(),
            artifactURL: { root.appendingPathComponent("cua-driver") },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in true },
            restartSleep: { delays.append($0) },
            permissionSnapshot: { [:] })

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
        #expect(delays.values == [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(10)])
        #expect(launcher.launches.count == 6)
        #expect(coordinator.workerEndpoint == nil)
        await coordinator.setEnabled(false)
    }

    @Test(arguments: CuaStartupSuspension.allCases, [false, true])
    func `retired startup never publishes availability or overwrites permissions`(
        suspension: CuaStartupSuspension,
        disable: Bool) async throws
    {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let notifications = NotificationCenter()
        let launcher = CuaProcessLauncherProbe()
        let probe = CuaStartupProbe(suspension: suspension)
        let restartGate = AsyncTestGate()
        let coordinator = CuaDriverHostCoordinator(
            notificationCenter: notifications,
            observeNotifications: true,
            artifactURL: { root.appendingPathComponent("cua-driver") },
            applicationSupportURL: { root },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { launch, onTermination in
                launcher.launch(launch, onTermination: onTermination)
            },
            readinessProbe: { _ in await probe.readiness() },
            restartSleep: { _ in await restartGate.wait() },
            permissionSnapshot: { await probe.permissions() })
        var availability: [CuaDriverWorkerEndpoint?] = []
        let observer = notifications.addObserver(
            forName: .openclawCuaDriverAvailabilityChanged,
            object: nil,
            queue: nil)
        { _ in
            // Publication is synchronous on MainActor; an asynchronous observer would miss ready -> nil.
            MainActor.assumeIsolated { availability.append(coordinator.workerEndpoint) }
        }
        defer { notifications.removeObserver(observer) }
        let startup = Task { await coordinator.setEnabled(true) }
        var disabling: Task<Void, Never>?
        var replacement: Task<Void, Never>?
        var failure: (any Error)?
        do {
            try #require(await self.waitUntil { probe.startupEntered })
            let child = try #require(launcher.processes.first)
            let launch = try #require(launcher.launches.first)
            let socketIndex = try #require(launch.arguments.firstIndex(of: "--socket")) + 1
            let retiredDirectory = URL(fileURLWithPath: launch.arguments[socketIndex]).deletingLastPathComponent()
            #expect(FileManager.default.fileExists(atPath: retiredDirectory.path))

            // Record a newer permission baseline while the old startup result is suspended.
            probe.snapshot = [.accessibility: .granted, .screenRecording: .granted]
            let expectedReads = probe.permissionReads + 1
            notifications.post(name: .openclawPermissionsChanged, object: nil)
            try #require(await self.waitUntil { probe.permissionReads == expectedReads })
            if disable {
                var disableEntered = false
                disabling = Task { @MainActor in
                    disableEntered = true
                    // Same-actor call runs through desiredEnabled's update before its first suspension.
                    await coordinator.setEnabled(false)
                }
                try #require(await self.waitUntil { disableEntered })
            } else {
                child.crash(status: 7)
                try #require(await self.waitUntil {
                    child.closeLivenessCount == 1 &&
                        !FileManager.default.fileExists(atPath: retiredDirectory.path)
                })
            }
            #expect(availability.isEmpty)
            probe.releaseStartup.open()
            await startup.value
            await disabling?.value
            #expect(coordinator.workerEndpoint == nil)
            #expect(availability.isEmpty)
            await coordinator.setEnabled(false)

            // A stale snapshot would make this unchanged notification restart the next healthy child.
            replacement = Task { await coordinator.setEnabled(true) }
            try #require(await self.waitUntil { probe.replacementEntered })
            let replacementReads = probe.permissionReads + 1
            notifications.post(name: .openclawPermissionsChanged, object: nil)
            try #require(await self.waitUntil { probe.permissionReads == replacementReads })
            probe.releaseReplacement.open()
            await replacement?.value
            await coordinator.setEnabled(true)
            #expect(launcher.launches.count == 2)
            #expect(launcher.processes[1].closeLivenessCount == 0)
            let endpoint = try #require(coordinator.workerEndpoint)
            #expect(availability == [endpoint])
        } catch {
            failure = error
        }
        // Release and join every task even when a prerequisite assertion fails.
        probe.releaseStartup.open()
        probe.releaseReplacement.open()
        await coordinator.shutdown()
        restartGate.open()
        await startup.value
        await disabling?.value
        await replacement?.value
        if let failure { throw failure }
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(1))
        }
        return condition()
    }

    @Test func `permission changes replace the daemon generation and endpoint`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
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
        let originalEnvironmentValue = try originalEndpoint.environmentValue()
        permissions.value[.accessibility] = .granted
        notifications.post(name: .openclawPermissionsChanged, object: nil)
        #expect(await self.waitForReadyLaunch(2, launcher: launcher, coordinator: coordinator))
        let replacementEndpoint = try #require(coordinator.workerEndpoint)
        #expect(replacementEndpoint.socketPath != originalEndpoint.socketPath)
        #expect(try replacementEndpoint.environmentValue() != originalEnvironmentValue)
        #expect(!launcher.processes[0].isRunning)
        await coordinator.setEnabled(false)
    }

    private func expectedExecutable(in root: URL, target: String) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let executable = root.appendingPathComponent("cua-driver")
        try FileManager.default.createSymbolicLink(
            at: executable,
            withDestinationURL: URL(fileURLWithPath: target))
        return executable
    }

    private func startFakeDaemon(executable: URL, hostPID: Int32) throws -> Process {
        let process = self.makeSleepProcess(executable: executable)
        var environment = ProcessInfo.processInfo.environment
        environment["CUA_DRIVER_EMBEDDED_HOST_PID"] = String(hostPID)
        process.environment = environment
        try process.run()
        return process
    }

    private func startSleep(executable: URL) throws -> Process {
        let process = self.makeSleepProcess(executable: executable)
        try process.run()
        return process
    }

    private func makeSleepProcess(executable: URL) -> Process {
        let process = Process()
        process.executableURL = executable
        process.arguments = ["60"]
        return process
    }

    private func waitUntilExited(_ process: Process) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while process.isRunning, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        return !process.isRunning
    }

    private func stopIfRunning(_ process: Process) {
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
    }

    private static func process(_ processIdentifier: pid_t, hasDescriptor descriptor: Int32) -> Bool {
        var descriptors = [proc_fdinfo](repeating: proc_fdinfo(), count: 64)
        let populatedBytes = descriptors.withUnsafeMutableBytes { buffer in
            proc_pidinfo(
                processIdentifier,
                PROC_PIDLISTFDS,
                0,
                buffer.baseAddress,
                Int32(buffer.count))
        }
        guard populatedBytes > 0 else { return false }
        let count = min(
            descriptors.count,
            Int(populatedBytes) / MemoryLayout<proc_fdinfo>.stride)
        return descriptors.prefix(count).contains { $0.proc_fd == descriptor }
    }
}

private final class CuaDriverStderrProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var captured: [CuaDriverStderrEvent] = []

    var events: [CuaDriverStderrEvent] {
        self.lock.withLock { self.captured }
    }

    func append(_ event: CuaDriverStderrEvent) {
        self.lock.withLock { self.captured.append(event) }
    }
}

@MainActor
private final class CuaPermissionSnapshotProbe {
    var value: [Capability: CapabilityAuthorizationStatus] = [
        .accessibility: .notGranted,
        .screenRecording: .notGranted,
    ]
}

enum CuaStartupSuspension: CaseIterable, Sendable {
    case permissions
    case readinessSuccess
    case readinessFailure
}

@MainActor
private final class CuaStartupProbe {
    let releaseStartup = AsyncTestGate()
    let releaseReplacement = AsyncTestGate()
    private let suspension: CuaStartupSuspension
    private var readinessReads = 0
    private(set) var permissionReads = 0
    private(set) var startupEntered = false
    private(set) var replacementEntered = false
    var snapshot: [Capability: CapabilityAuthorizationStatus] = [
        .accessibility: .notGranted,
        .screenRecording: .notGranted,
    ]

    init(suspension: CuaStartupSuspension) {
        self.suspension = suspension
    }

    func readiness() async -> Bool {
        self.readinessReads += 1
        if self.readinessReads == 1 {
            if self.suspension != .permissions {
                self.startupEntered = true
                await self.releaseStartup.wait()
            }
            return self.suspension != .readinessFailure
        }
        self.replacementEntered = true
        await self.releaseReplacement.wait()
        return true
    }

    func permissions() async -> [Capability: CapabilityAuthorizationStatus] {
        self.permissionReads += 1
        let snapshot = self.snapshot
        if self.permissionReads == 1, self.suspension == .permissions {
            self.startupEntered = true
            await self.releaseStartup.wait()
        }
        return snapshot
    }
}

private final class CuaRestartDelayProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var delays: [Duration] = []

    var values: [Duration] {
        self.lock.withLock { self.delays }
    }

    func append(_ delay: Duration) {
        self.lock.withLock { self.delays.append(delay) }
    }
}

@MainActor
private final class CuaProcessLauncherProbe {
    private(set) var launches: [CuaDriverProcessLaunch] = []
    private(set) var processes: [CuaProcessProbe] = []

    var lastProcessIdentifier: pid_t {
        self.processes.last?.processIdentifier ?? 0
    }

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
    private(set) var closeLivenessCount = 0
    let processIdentifier: pid_t
    private let onTermination: @Sendable (Int32) -> Void

    init(processIdentifier: pid_t = 424_242, onTermination: @escaping @Sendable (Int32) -> Void) {
        self.processIdentifier = processIdentifier
        self.onTermination = onTermination
    }

    func closeLiveness() {
        self.closeLivenessCount += 1
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
