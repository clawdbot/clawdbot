import Foundation
import Observation
import OSLog

@MainActor
@Observable
final class CookieSyncManager: NSObject {
    enum State: Equatable {
        case stopped
        case running
        case error(String)
    }

    private struct Endpoint: Equatable {
        let url: URL
        let token: String?
        let password: String?
    }

    private struct SyncIntent: Equatable {
        let domains: [String]
        let profile: String
        let endpoint: Endpoint
    }

    static let shared = CookieSyncManager()

    private(set) var state: State = .stopped
    private(set) var lastSummary: String?

    @ObservationIgnored private let logger = Logger(subsystem: "ai.openclaw", category: "cookie-sync")
    @ObservationIgnored private let queue = DispatchQueue(label: "ai.openclaw.cookie-sync")
    @ObservationIgnored private weak var appState: AppState?
    @ObservationIgnored private var endpointState: GatewayEndpointState?
    @ObservationIgnored private var endpointTask: Task<Void, Never>?
    @ObservationIgnored private var reconcileTask: Task<Void, Never>?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var readers: [PipeReadStream] = []
    @ObservationIgnored private var startupWatchdog: DispatchSourceTimer?
    @ObservationIgnored private var stdoutBuffer = Data()
    @ObservationIgnored private var processGeneration: UUID?
    @ObservationIgnored private var runningIntent: SyncIntent?
    @ObservationIgnored private var reconcileGeneration: UInt64 = 0
    @ObservationIgnored private var retryAttempt = 0
    @ObservationIgnored private var isStarted = false

    func start(state: AppState) {
        self.appState = state
        guard !self.isStarted else {
            self.scheduleReconcile(resetRetry: true)
            return
        }
        self.isStarted = true
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(self.settingsDidChange),
            name: UserDefaults.didChangeNotification,
            object: AppDefaults.standard)
        center.addObserver(
            self,
            selector: #selector(self.settingsDidChange),
            name: .openclawConfigDidChange,
            object: nil)
        center.addObserver(
            self,
            selector: #selector(self.cliDidChange),
            name: .openclawCLIInstalled,
            object: nil)

        self.endpointTask = Task { [weak self] in
            let states = await GatewayEndpointStore.shared.subscribe()
            for await state in states {
                guard !Task.isCancelled, let self else { return }
                self.endpointState = state
                self.scheduleReconcile(resetRetry: true)
            }
        }
        self.scheduleReconcile(resetRetry: true)
    }

    func stop() {
        // This singleton's notification lifetime follows its explicit start/stop lifecycle.
        // swiftlint:disable:next notification_center_detachment
        NotificationCenter.default.removeObserver(self)
        self.endpointTask?.cancel()
        self.endpointTask = nil
        self.reconcileTask?.cancel()
        self.reconcileTask = nil
        self.retryTask?.cancel()
        self.retryTask = nil
        self.isStarted = false
        self.stopChild(nextState: .stopped)
    }

    static func normalizedDomains(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values
            .flatMap { $0.split(separator: ",", omittingEmptySubsequences: false).map(String.init) }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
    }

    @objc private nonisolated func settingsDidChange(_: Notification) {
        Task { @MainActor [weak self] in
            self?.scheduleReconcile(resetRetry: true)
        }
    }

    @objc private nonisolated func cliDidChange(_: Notification) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.stopChild(nextState: .stopped)
            self.scheduleReconcile(resetRetry: true)
        }
    }

    private func scheduleReconcile(resetRetry: Bool, delay: Duration = .milliseconds(350)) {
        if resetRetry {
            self.retryAttempt = 0
            self.retryTask?.cancel()
            self.retryTask = nil
        }
        self.reconcileGeneration &+= 1
        let generation = self.reconcileGeneration
        self.reconcileTask?.cancel()
        self.reconcileTask = Task { [weak self] in
            do {
                try await Task.sleep(for: delay)
            } catch {
                return
            }
            guard !Task.isCancelled, let self, generation == self.reconcileGeneration else { return }
            await self.reconcile(generation: generation)
        }
    }

    private func reconcile(generation: UInt64) async {
        guard let appState = self.appState,
              appState.cookieSyncEnabled,
              appState.connectionMode == .remote
        else {
            self.stopChild(nextState: .stopped)
            return
        }

        let domains = Self.normalizedDomains(appState.cookieSyncDomains)
        guard !domains.isEmpty else {
            self.stopChild(nextState: .stopped)
            return
        }

        let profile = appState.cookieSyncIntoProfile
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty ?? "imported"
        guard let endpoint = self.remoteEndpoint else {
            self.stopChild(nextState: .error("no remote gateway credentials available"))
            return
        }
        let intent = SyncIntent(domains: domains, profile: profile, endpoint: endpoint)
        if self.process?.isRunning == true, self.runningIntent == intent {
            return
        }
        self.stopChild(nextState: .stopped)

        guard let executable = await self.resolveLocalOpenClawExecutable(),
              !Task.isCancelled,
              generation == self.reconcileGeneration
        else {
            if !Task.isCancelled, generation == self.reconcileGeneration {
                self.state = .error("OpenClaw CLI not found locally; cookie sync needs the CLI on this Mac")
            }
            return
        }
        self.launch(executable: executable, intent: intent)
    }

    private var remoteEndpoint: Endpoint? {
        guard case let .ready(mode, url, rawToken, rawPassword, _) = self.endpointState,
              mode == .remote
        else { return nil }
        let token = rawToken?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let password = rawPassword?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        guard token != nil || password != nil else { return nil }
        return Endpoint(url: url, token: token, password: token == nil ? password : nil)
    }

    private func resolveLocalOpenClawExecutable() async -> String? {
        #if DEBUG
        if let executable = CommandResolver.projectOpenClawExecutable() {
            return executable
        }
        #endif
        if case let .ready(location, _) = await CLIInstaller.status() {
            return location
        }
        return CommandResolver.findExecutable(
            named: "openclaw",
            searchPaths: CommandResolver.preferredPaths())
    }

    private func launch(executable: String, intent: SyncIntent) {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        defer {
            try? stdoutPipe.fileHandleForReading.close()
            try? stderrPipe.fileHandleForReading.close()
        }
        let generation = UUID()
        let arguments = [
            "browser",
            "cookie-sync",
            "--watch",
            "--domains",
            intent.domains.joined(separator: ","),
            "--into",
            intent.profile,
        ]

        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        environment["OPENCLAW_GATEWAY_URL"] = intent.endpoint.url.absoluteString
        environment.removeValue(forKey: "OPENCLAW_GATEWAY_TOKEN")
        environment.removeValue(forKey: "OPENCLAW_GATEWAY_PASSWORD")
        if let token = intent.endpoint.token {
            environment["OPENCLAW_GATEWAY_TOKEN"] = token
        } else if let password = intent.endpoint.password {
            environment["OPENCLAW_GATEWAY_PASSWORD"] = password
        }
        process.environment = environment
        self.process = process
        self.processGeneration = generation
        self.runningIntent = intent
        self.stdoutBuffer.removeAll(keepingCapacity: true)

        do {
            // Consume on the reader's serial executor so termination cannot
            // overtake status chunks waiting for a separate actor hop.
            let readers = try [
                PipeReadStream(handle: stdoutPipe.fileHandleForReading, queue: .main, onData: { [weak self] data in
                    MainActor.assumeIsolated { self?.consumeStdout(data, generation: generation) }
                }),
                PipeReadStream(handle: stderrPipe.fileHandleForReading, queue: .main, onData: { [weak self] data in
                    MainActor.assumeIsolated { self?.consumeStderr(data, generation: generation) }
                }),
            ]
            self.readers = readers
            process.terminationHandler = { [weak self] process in
                let terminationStatus = process.terminationStatus
                Task { @MainActor [weak self] in
                    for reader in readers {
                        await reader.finish()
                    }
                    self?.childTerminated(generation: generation, status: terminationStatus)
                }
            }
            try process.run()
            self.installStartupWatchdog(generation: generation)
            self.state = .running
            self.logger.info("cookie sync started for \(intent.domains.count, privacy: .public) domain(s)")
        } catch {
            self.logger.error("cookie sync launch failed: \(error.localizedDescription, privacy: .public)")
            self.stopChild(nextState: .error("Cookie sync could not start: \(error.localizedDescription)"))
            self.scheduleRetry()
        }
    }

    private func installStartupWatchdog(generation: UUID) {
        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        timer.schedule(deadline: .now() + 5)
        timer.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.processGeneration == generation else { return }
                self.startupWatchdog?.cancel()
                self.startupWatchdog = nil
                if self.process?.isRunning == true {
                    self.retryAttempt = 0
                    self.logger.debug("cookie sync startup watchdog passed")
                }
            }
        }
        self.startupWatchdog = timer
        timer.resume()
    }

    private func consumeStdout(_ data: Data, generation: UUID) {
        guard self.processGeneration == generation else { return }
        self.stdoutBuffer.append(data)
        if self.stdoutBuffer.count > 64 * 1024 {
            self.stdoutBuffer.removeFirst(self.stdoutBuffer.count - 64 * 1024)
        }
        while let newline = self.stdoutBuffer.firstIndex(of: 0x0A) {
            let lineData = self.stdoutBuffer.prefix(upTo: newline)
            self.stdoutBuffer.removeSubrange(...newline)
            // Preserve lossy decoding so malformed CLI bytes do not hide the rest of a status line.
            // swiftlint:disable:next optional_data_string_conversion
            let line = String(decoding: lineData, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { continue }
            self.lastSummary = line
            self.logger.info("cookie sync: \(line, privacy: .public)")
        }
    }

    private func consumeStderr(_ data: Data, generation: UUID) {
        guard self.processGeneration == generation else { return }
        // Preserve lossy decoding so malformed CLI bytes do not hide useful diagnostics.
        // swiftlint:disable:next optional_data_string_conversion
        let message = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !message.isEmpty {
            self.logger.error("cookie sync stderr: \(message, privacy: .private)")
        }
    }

    private func childTerminated(generation: UUID, status: Int32) {
        guard self.processGeneration == generation else { return }
        self.stopChild(nextState: .error("Cookie sync exited with status \(status)"))
        self.scheduleRetry()
    }

    private func scheduleRetry() {
        guard self.shouldBeActive else { return }
        self.retryAttempt += 1
        let delaySeconds = min(30, 1 << min(self.retryAttempt - 1, 5))
        self.retryTask?.cancel()
        self.retryTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(delaySeconds))
            } catch {
                return
            }
            guard !Task.isCancelled, let self else { return }
            self.scheduleReconcile(resetRetry: false, delay: .zero)
        }
    }

    private var shouldBeActive: Bool {
        guard let appState = self.appState else { return false }
        return appState.cookieSyncEnabled &&
            appState.connectionMode == .remote &&
            !Self.normalizedDomains(appState.cookieSyncDomains).isEmpty
    }

    private func stopChild(nextState: State) {
        self.startupWatchdog?.cancel()
        self.startupWatchdog = nil
        self.readers.forEach { $0.close() }
        self.readers.removeAll()
        let process = self.process
        self.process = nil
        self.processGeneration = nil
        self.runningIntent = nil
        self.stdoutBuffer.removeAll(keepingCapacity: false)
        if process?.isRunning == true {
            process?.terminate()
        }
        self.state = nextState
    }
}
