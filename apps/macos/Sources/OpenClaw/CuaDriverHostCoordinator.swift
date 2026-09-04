import AppKit
import Darwin
import Foundation
import OpenClawIPC
import OSLog

extension Notification.Name {
    static let openclawCuaDriverAvailabilityChanged = Notification.Name(
        "openclaw.cua-driver.availability-changed")
}

struct CuaDriverProcessLaunch: Sendable {
    let executableURL: URL
    let arguments: [String]
    let environment: [String: String]
}

struct CuaDriverSocketDirectory: Equatable, Sendable {
    let url: URL
    let socketPath: String
    let device: UInt64
    let inode: UInt64

    var pidFilePath: String {
        self.url.appendingPathComponent("cua.pid", isDirectory: false).path
    }
}

enum CuaDriverHostError: LocalizedError {
    case socketDirectory(String)
    case socketPathTooLong

    var errorDescription: String? {
        switch self {
        case let .socketDirectory(message):
            "Could not prepare the CUA socket directory: \(message)"
        case .socketPathTooLong:
            "The private CUA socket path is too long"
        }
    }
}

/// Owns the embedded CUA daemon as a direct OpenClaw.app child so macOS TCC
/// attributes Accessibility and Screen Recording checks to this signed app.
@MainActor
final class CuaDriverHostCoordinator {
    typealias ProcessLauncher = @MainActor (
        CuaDriverProcessLaunch,
        @escaping @Sendable (Int32) -> Void) throws -> any CuaDriverProcessControlling
    typealias ReadinessProbe = @Sendable (String) async -> Bool

    static let shared = CuaDriverHostCoordinator(
        observeNotifications: true,
        enablementAllowed: { AppLaunchRuntimePlan.current.allowsCuaComputerControl },
        beforeDaemonStop: {
            await MacNodeModeCoordinator.shared.prepareForCuaDaemonStop()
        })

    private static let maximumRestartAttempts = 5
    private static let restartDelays: [Duration] = [
        .seconds(1),
        .seconds(2),
        .seconds(4),
        .seconds(8),
        .seconds(10),
    ]

    private struct RunningChild {
        let generation: UInt64
        let process: any CuaDriverProcessControlling
        let socketDirectory: CuaDriverSocketDirectory
        let executableURL: URL
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "cua-driver-host")
    private let notificationCenter: NotificationCenter
    private let artifactURL: @MainActor () -> URL?
    private let applicationSupportURL: @MainActor () -> URL
    private let bundleIdentifier: @MainActor () -> String?
    private let processLauncher: ProcessLauncher
    private let readinessProbe: ReadinessProbe
    private let restartSleep: @Sendable (Duration) async -> Void
    private let permissionSnapshot: @MainActor () async -> [Capability: CapabilityAuthorizationStatus]
    private let enablementAllowed: @MainActor () -> Bool
    private let beforeDaemonStop: @MainActor () async -> Void

    private var desiredEnabled = false
    private var runningChild: RunningChild?
    private var readyEndpoint: CuaDriverWorkerEndpoint?
    private var generation: UInt64 = 0
    private var stoppingGenerations = Set<UInt64>()
    private var restartAttempt = 0
    private var restartTask: Task<Void, Never>?
    private var reconciliationTail: Task<Void, Never>?
    private var lastPermissionSnapshot: [Capability: CapabilityAuthorizationStatus]?

    init(
        notificationCenter: NotificationCenter = .default,
        observeNotifications: Bool = false,
        artifactURL: @escaping @MainActor () -> URL? = { CuaDriverArtifact.bundledExecutableURL },
        applicationSupportURL: @escaping @MainActor () -> URL = {
            let fileManager = FileManager.default
            return fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        },
        bundleIdentifier: @escaping @MainActor () -> String? = { Bundle.main.bundleIdentifier },
        processLauncher: @escaping ProcessLauncher = CuaDriverHostCoordinator.launchProcess,
        readinessProbe: @escaping ReadinessProbe = { path in
            await Task.detached { CuaDriverHostCoordinator.socketAcceptsConnections(path) }.value
        },
        restartSleep: @escaping @Sendable (Duration) async -> Void = { delay in
            try? await Task.sleep(for: delay)
        },
        permissionSnapshot: @escaping @MainActor () async -> [Capability: CapabilityAuthorizationStatus] = {
            await PermissionManager.authorizationStatus([.accessibility, .screenRecording])
        },
        enablementAllowed: @escaping @MainActor () -> Bool = { true },
        beforeDaemonStop: @escaping @MainActor () async -> Void = {})
    {
        self.notificationCenter = notificationCenter
        self.artifactURL = artifactURL
        self.applicationSupportURL = applicationSupportURL
        self.bundleIdentifier = bundleIdentifier
        self.processLauncher = processLauncher
        self.readinessProbe = readinessProbe
        self.restartSleep = restartSleep
        self.permissionSnapshot = permissionSnapshot
        self.enablementAllowed = enablementAllowed
        self.beforeDaemonStop = beforeDaemonStop

        guard observeNotifications else { return }
        notificationCenter.addObserver(
            self,
            selector: #selector(self.permissionsMayHaveChanged),
            name: .openclawPermissionsChanged,
            object: nil)
        notificationCenter.addObserver(
            self,
            selector: #selector(self.permissionsMayHaveChanged),
            name: NSApplication.didBecomeActiveNotification,
            object: nil)
    }

    deinit {
        self.restartTask?.cancel()
        self.reconciliationTail?.cancel()
        self.notificationCenter.removeObserver(self)
    }

    var workerEndpoint: CuaDriverWorkerEndpoint? {
        self.readyEndpoint
    }

    func setEnabled(_ enabled: Bool) async {
        let effectiveEnabled = enabled && self.enablementAllowed()
        let wasEnabled = self.desiredEnabled
        self.desiredEnabled = effectiveEnabled
        if effectiveEnabled, !wasEnabled {
            self.restartAttempt = 0
        }
        if !effectiveEnabled {
            self.restartTask?.cancel()
            self.restartTask = nil
            self.restartAttempt = 0
        }
        await self.enqueueReconciliation(restart: false).value
    }

    func shutdown() async {
        await self.setEnabled(false)
    }

    private func enqueueReconciliation(restart: Bool) -> Task<Void, Never> {
        let predecessor = self.reconciliationTail
        let task = Task { @MainActor [weak self] in
            await predecessor?.value
            guard let self else { return }
            if restart {
                await self.ensureStopped()
            }
            if self.desiredEnabled {
                await self.ensureStarted()
            } else {
                await self.ensureStopped()
            }
        }
        self.reconciliationTail = task
        return task
    }

    private func ensureStarted() async {
        guard self.runningChild == nil else { return }
        let applicationSupportURL = self.applicationSupportURL()
        let executableURL = self.artifactURL()
        await Self.reapStaleSocketDirectories(
            in: applicationSupportURL,
            expectedExecutableURL: executableURL)
        guard let executableURL else {
            self.logger.info("embedded CUA remains unavailable because the driver is not bundled")
            return
        }
        guard let hostBundleID = self.bundleIdentifier()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !hostBundleID.isEmpty
        else {
            self.logger.error("embedded CUA cannot start without a host bundle identifier")
            return
        }

        let socketDirectory: CuaDriverSocketDirectory
        do {
            socketDirectory = try Self.createSocketDirectory(in: applicationSupportURL)
        } catch {
            self.logger.error("\(error.localizedDescription, privacy: .public)")
            self.scheduleRestartIfNeeded()
            return
        }

        self.generation &+= 1
        let generation = self.generation
        let launch = Self.makeProcessLaunch(
            executableURL: executableURL,
            socketPath: socketDirectory.socketPath,
            hostBundleID: hostBundleID)
        do {
            let process = try self.processLauncher(launch) { [weak self] status in
                Task { @MainActor [weak self] in
                    self?.processExited(generation: generation, status: status)
                }
            }
            self.runningChild = RunningChild(
                generation: generation,
                process: process,
                socketDirectory: socketDirectory,
                executableURL: executableURL)
            // Record the pid we spawned so startup/teardown reaping can attribute and
            // terminate exactly this daemon; without it a reaper can only delete the
            // directory and would leave an orphaned privileged process running.
            guard Self.writeProcessIdentifier(process.processIdentifier, to: socketDirectory) else {
                self.logger.error("embedded CUA could not record the spawned daemon pid")
                await self.ensureStopped()
                self.scheduleRestartIfNeeded()
                return
            }
        } catch {
            Self.cleanupSocketDirectory(socketDirectory)
            self.logger.error("embedded CUA launch failed: \(error.localizedDescription, privacy: .public)")
            self.scheduleRestartIfNeeded()
            return
        }

        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            let ready = await self.readinessProbe(socketDirectory.socketPath)
            let permissions = ready ? await self.permissionSnapshot() : nil
            // Either probe can suspend while disable or process exit retires this child.
            // Revalidate before committing the snapshot or publishing availability.
            guard self.desiredEnabled,
                  let child = self.runningChild,
                  child.generation == generation,
                  child.process.isRunning
            else {
                await self.ensureStopped()
                return
            }
            if let permissions {
                self.lastPermissionSnapshot = permissions
                self.setReadyEndpoint(CuaDriverWorkerEndpoint(
                    socketPath: socketDirectory.socketPath,
                    binaryPath: executableURL.path))
                self.logger.info("embedded CUA ready at \(socketDirectory.socketPath, privacy: .public)")
                return
            }
            try? await Task.sleep(for: .milliseconds(50))
        }

        self.logger.error("embedded CUA startup timed out")
        await self.ensureStopped()
        self.scheduleRestartIfNeeded()
    }

    private func ensureStopped() async {
        self.setReadyEndpoint(nil)
        let applicationSupportURL = self.applicationSupportURL()
        guard let child = self.runningChild else {
            await Self.reapStaleSocketDirectories(
                in: applicationSupportURL,
                expectedExecutableURL: self.artifactURL())
            return
        }
        // The worker owns the MCP proxy. Drain it before the app closes the
        // privileged daemon so an execution can never cross generations.
        await self.beforeDaemonStop()
        self.stoppingGenerations.insert(child.generation)
        child.process.closeLiveness()
        await Self.waitUntilStopped(child.process, timeout: .seconds(2))
        if child.process.isRunning {
            child.process.terminate()
            await Self.waitUntilStopped(child.process, timeout: .seconds(1))
        }
        if child.process.isRunning {
            child.process.forceKill()
            await Self.waitUntilStopped(child.process, timeout: .seconds(1))
        }
        if self.runningChild?.generation == child.generation {
            self.runningChild = nil
        }
        self.stoppingGenerations.remove(child.generation)
        if !child.process.isRunning {
            Self.cleanupSocketDirectory(child.socketDirectory)
        }
        await Self.reapStaleSocketDirectories(
            in: applicationSupportURL,
            expectedExecutableURL: child.executableURL)
    }

    private func processExited(generation: UInt64, status: Int32) {
        guard let child = self.runningChild, child.generation == generation else { return }
        let expected = self.stoppingGenerations.contains(generation) || !self.desiredEnabled
        self.setReadyEndpoint(nil)
        child.process.closeLiveness()
        self.runningChild = nil
        Self.cleanupSocketDirectory(child.socketDirectory)
        if expected {
            self.stoppingGenerations.remove(generation)
            return
        }
        self.logger.error("embedded CUA exited unexpectedly with status \(status, privacy: .public)")
        self.scheduleRestartIfNeeded()
    }

    private func scheduleRestartIfNeeded() {
        guard self.desiredEnabled,
              self.restartTask == nil,
              self.restartAttempt < Self.maximumRestartAttempts
        else { return }
        let delay = Self.restartDelays[self.restartAttempt]
        self.restartAttempt += 1
        let restartSleep = self.restartSleep
        self.restartTask = Task { @MainActor [weak self] in
            await restartSleep(delay)
            guard !Task.isCancelled, let self, self.desiredEnabled else { return }
            self.restartTask = nil
            await self.enqueueReconciliation(restart: false).value
        }
    }

    private func setReadyEndpoint(_ endpoint: CuaDriverWorkerEndpoint?) {
        guard self.readyEndpoint != endpoint else { return }
        self.readyEndpoint = endpoint
        self.notificationCenter.post(name: .openclawCuaDriverAvailabilityChanged, object: nil)
    }

    @objc private nonisolated func permissionsMayHaveChanged(_: Notification) {
        Task { @MainActor [weak self] in
            await self?.restartAfterPermissionChangeIfNeeded()
        }
    }

    private func restartAfterPermissionChangeIfNeeded() async {
        let latest = await self.permissionSnapshot()
        guard let previous = self.lastPermissionSnapshot else {
            self.lastPermissionSnapshot = latest
            return
        }
        guard latest != previous else { return }
        self.lastPermissionSnapshot = latest
        guard self.desiredEnabled, self.runningChild != nil else { return }
        self.restartTask?.cancel()
        self.restartTask = nil
        await self.enqueueReconciliation(restart: true).value
    }

    static func makeProcessLaunch(
        executableURL: URL,
        socketPath: String,
        hostBundleID: String,
        inheritedEnvironment: [String: String] = ProcessInfo.processInfo.environment) -> CuaDriverProcessLaunch
    {
        var environment = inheritedEnvironment.filter { key, _ in
            !key.hasPrefix("CUA_DRIVER_") && key != "CUA_TELEMETRY_ENABLED"
        }
        environment["CUA_DRIVER_EMBEDDED"] = "1"
        environment["CUA_DRIVER_HOST_BUNDLE_ID"] = hostBundleID
        environment["CUA_DRIVER_PERMISSION_MODE"] = "unrestricted"
        environment["CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS"] = "1"
        environment["CUA_DRIVER_RS_TELEMETRY_ENABLED"] = "false"
        environment["CUA_DRIVER_RS_UPDATE_CHECK"] = "false"
        environment["CUA_DRIVER_EMBEDDED_HOST_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        // Unrestricted is deliberate: CUA bounded mode accepts only exact launch-time resource grants
        // (cua-driver-core/src/session_manifest.rs), not arbitrary runtime-discovered windows/elements.
        // OpenClaw command arming, pairing, and tool policy own authorization upstream, matching the
        // shipped Peekaboo fulfiller; the owner-only 0700 socket directory is the local trust boundary.
        return CuaDriverProcessLaunch(
            executableURL: executableURL,
            arguments: [
                "serve",
                "--embedded",
                "--parent-liveness-stdio",
                "--no-permissions-gate",
                "--socket",
                socketPath,
                // No --pid-file: `serve` ignores it and always writes the driver's
                // global default path, which every cua-driver on the machine shares.
                // OpenClaw records the spawned pid itself so reaping can attribute
                // exactly the daemon this app owns.
                "--host-bundle-id",
                hostBundleID,
                "--permission-mode",
                "unrestricted",
                "--dangerously-bypass-approvals",
            ],
            environment: environment)
    }

    private static func launchProcess(
        _ launch: CuaDriverProcessLaunch,
        onTermination: @escaping @Sendable (Int32) -> Void) throws -> any CuaDriverProcessControlling
    {
        let process = Process()
        let livenessPipe = try Self.makeLivenessPipe()
        let logger = Logger(subsystem: "ai.openclaw", category: "cua-driver-host")
        let stderrRelay = CuaDriverStderrRelay { event in
            switch event {
            case let .notice(message):
                logger.notice("\(message, privacy: .public)")
            case let .error(message):
                logger.error("CUA driver stderr: \(message, privacy: .public)")
            }
        }
        process.executableURL = launch.executableURL
        process.arguments = launch.arguments
        process.environment = launch.environment
        process.standardInput = livenessPipe.fileHandleForReading
        process.standardOutput = FileHandle.nullDevice
        process.standardError = stderrRelay.pipe
        process.terminationHandler = { terminated in
            let status = terminated.terminationStatus
            // Readiness and shutdown can release the process wrapper before
            // this callback finishes; the handler owns stderr through its drain.
            Task {
                await stderrRelay.finishReading()
                onTermination(status)
            }
        }
        do {
            try stderrRelay.startReading()
            try process.run()
        } catch {
            stderrRelay.stop()
            throw error
        }
        stderrRelay.reportManagedMode()
        return FoundationCuaDriverProcess(
            process: process,
            livenessPipe: livenessPipe)
    }

    private static func waitUntilStopped(
        _ process: any CuaDriverProcessControlling,
        timeout: Duration) async
    {
        let deadline = ContinuousClock.now + timeout
        while process.isRunning, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
    }

    static func createSocketDirectory(in applicationSupportURL: URL) throws -> CuaDriverSocketDirectory {
        let openClawRoot = applicationSupportURL.appendingPathComponent("OpenClaw", isDirectory: true)
        let root = openClawRoot.appendingPathComponent("cua", isDirectory: true)
        for directory in [applicationSupportURL, openClawRoot, root] {
            var status = stat()
            if lstat(directory.path, &status) != 0 {
                guard errno == ENOENT, Darwin.mkdir(directory.path, 0o700) == 0 else {
                    throw CuaDriverHostError.socketDirectory(String(cString: strerror(errno)))
                }
                guard lstat(directory.path, &status) == 0 else {
                    throw CuaDriverHostError.socketDirectory(String(cString: strerror(errno)))
                }
            }
            guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  status.st_uid == geteuid()
            else {
                throw CuaDriverHostError.socketDirectory("support roots must be owned directories")
            }
        }

        for _ in 0..<8 {
            // Keep the endpoint well below sockaddr_un.sun_path even for long account names.
            let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(16)
            let directory = root.appendingPathComponent(String(token), isDirectory: true)
            guard Darwin.mkdir(directory.path, 0o700) == 0 else {
                if errno == EEXIST { continue }
                throw CuaDriverHostError.socketDirectory(String(cString: strerror(errno)))
            }
            var status = stat()
            guard lstat(directory.path, &status) == 0,
                  status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  status.st_uid == geteuid(),
                  status.st_mode & 0o777 == 0o700
            else {
                _ = Darwin.rmdir(directory.path)
                throw CuaDriverHostError.socketDirectory("created directory failed ownership checks")
            }
            let socketPath = directory.appendingPathComponent("cua.sock", isDirectory: false).path
            guard socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
                _ = Darwin.rmdir(directory.path)
                throw CuaDriverHostError.socketPathTooLong
            }
            var socketStatus = stat()
            guard lstat(socketPath, &socketStatus) != 0, errno == ENOENT else {
                _ = Darwin.rmdir(directory.path)
                throw CuaDriverHostError.socketDirectory("socket path already exists")
            }
            return CuaDriverSocketDirectory(
                url: directory,
                socketPath: socketPath,
                device: UInt64(status.st_dev),
                inode: UInt64(status.st_ino))
        }
        throw CuaDriverHostError.socketDirectory("could not allocate a unique directory")
    }

    static func cleanupSocketDirectory(_ directory: CuaDriverSocketDirectory) {
        var status = stat()
        guard lstat(directory.url.path, &status) == 0,
              status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              status.st_uid == geteuid(),
              UInt64(status.st_dev) == directory.device,
              UInt64(status.st_ino) == directory.inode
        else { return }

        var socketStatus = stat()
        if lstat(directory.socketPath, &socketStatus) == 0,
           socketStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
           socketStatus.st_uid == geteuid()
        {
            _ = Darwin.unlink(directory.socketPath)
        }
        var pidStatus = stat()
        if lstat(directory.pidFilePath, &pidStatus) == 0,
           pidStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
           pidStatus.st_uid == geteuid()
        {
            _ = Darwin.unlink(directory.pidFilePath)
        }
        _ = Darwin.rmdir(directory.url.path)
    }

    nonisolated static func socketAcceptsConnections(_ socketPath: String) -> Bool {
        guard let descriptor = self.connectUnixSocket(socketPath) else { return false }
        defer { close(descriptor) }
        return true
    }
}
