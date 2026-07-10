import Foundation

@MainActor
enum CLIInstaller {
    enum LocalGatewayActivation: Equatable {
        case ready
        case deferred
        case failed
    }

    enum Status: Equatable {
        case ready(location: String, version: String)
        case missing(location: String)
        case unusable(location: String)
        case incompatible(location: String, found: String, required: String)

        var isReady: Bool {
            if case .ready = self {
                return true
            }
            return false
        }

        var location: String {
            switch self {
            case let .ready(location, _),
                 let .missing(location),
                 let .unusable(location),
                 let .incompatible(location, _, _):
                location
            }
        }

        var message: String {
            switch self {
            case let .ready(_, version):
                "OpenClaw Gateway \(version) is ready."
            case .missing:
                "OpenClaw Gateway is not installed yet."
            case .unusable:
                "The OpenClaw Gateway could not be verified. Setup will repair it."
            case let .incompatible(_, found, required):
                "Gateway \(found) does not match app \(required). Setup will update it."
            }
        }
    }

    static func installedLocation() -> String? {
        self.installedLocations(
            searchPaths: CommandResolver.preferredPaths(),
            fileManager: .default).first
    }

    static func installedLocation(
        searchPaths: [String],
        fileManager: FileManager) -> String?
    {
        self.installedLocations(searchPaths: searchPaths, fileManager: fileManager).first
    }

    static func installedLocations(
        searchPaths: [String],
        fileManager: FileManager) -> [String]
    {
        var locations: [String] = []
        for basePath in searchPaths {
            let candidate = URL(fileURLWithPath: basePath).appendingPathComponent("openclaw").path
            var isDirectory: ObjCBool = false

            guard fileManager.fileExists(atPath: candidate, isDirectory: &isDirectory),
                  !isDirectory.boolValue
            else {
                continue
            }

            guard fileManager.isExecutableFile(atPath: candidate) else { continue }

            locations.append(candidate)
        }
        return locations
    }

    static func isInstalled() -> Bool {
        self.installedLocation() != nil
    }

    static func managedExecutableLocation() -> String {
        URL(fileURLWithPath: self.installPrefix())
            .appendingPathComponent("bin/openclaw")
            .path
    }

    static func status() async -> Status {
        let locations = self.installedLocations(
            searchPaths: CommandResolver.preferredPaths(),
            fileManager: .default)
        guard !locations.isEmpty else {
            return .missing(location: self.managedExecutableLocation())
        }

        var fallbackStatus: Status?
        for location in locations {
            let status = await self.status(location: location)
            if status.isReady {
                self.rememberValidated(status)
                return status
            }
            fallbackStatus = fallbackStatus ?? status
        }
        return fallbackStatus ?? .missing(location: self.managedExecutableLocation())
    }

    static func managedStatus() async -> Status {
        let location = self.managedExecutableLocation()
        guard FileManager.default.isExecutableFile(atPath: location) else {
            return .missing(location: location)
        }

        let status = await self.status(location: location)
        if status.isReady {
            self.rememberValidated(status)
        }
        return status
    }

    static func status(location: String) async -> Status {
        let environment = self.probeEnvironment(location: location)
        let response = await ShellExecutor.runDetailed(
            command: [location, "--version"],
            cwd: nil,
            env: environment,
            timeout: 5)
        guard response.success else {
            return .unusable(location: location)
        }
        let versionStatus = self.classifyVersion(
            location: location,
            output: response.stdout,
            expectedVersion: GatewayEnvironment.expectedGatewayVersionString())
        guard versionStatus.isReady else { return versionStatus }
        guard await self.runtimeIsCompatible(environment: environment) else {
            return .unusable(location: location)
        }
        return versionStatus
    }

    private static func runtimeIsCompatible(environment: [String: String]) async -> Bool {
        let paths = environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        return await Task.detached(priority: .utility) {
            if case .success = RuntimeLocator.resolve(searchPaths: paths) {
                return true
            }
            return false
        }.value
    }

    static func classifyVersion(
        location: String,
        output: String?,
        expectedVersion: String?) -> Status
    {
        let normalized = GatewayEnvironment.normalizeGatewayVersionOutput(output)
        guard let normalized, let installed = Semver.parse(normalized) else {
            return .unusable(location: location)
        }
        guard let required = Semver.parse(expectedVersion) else {
            return .ready(location: location, version: normalized)
        }
        guard installed.compatible(with: required) else {
            return .incompatible(
                location: location,
                found: normalized,
                required: expectedVersion ?? required.description)
        }
        return .ready(location: location, version: normalized)
    }

    static func probeEnvironment(
        location: String,
        processEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        preferredPaths: [String] = CommandResolver.preferredPaths(),
        managedExecutable: String? = nil,
        managedRuntimeDirectory: String? = nil) -> [String: String]
    {
        var environment = processEnvironment
        let executableDirectory = URL(fileURLWithPath: location).deletingLastPathComponent().path
        let effectiveManagedExecutable = managedExecutable ?? self.managedExecutableLocation()
        let effectiveManagedRuntimeDirectory = managedRuntimeDirectory ?? URL(fileURLWithPath: self.installPrefix())
            .appendingPathComponent("tools/node/bin")
            .path
        let initialPaths = location == effectiveManagedExecutable
            ? [executableDirectory, effectiveManagedRuntimeDirectory]
            : [executableDirectory]
        var seen = Set<String>()
        let paths = (initialPaths + preferredPaths).filter { seen.insert($0).inserted }
        environment["PATH"] = paths.joined(separator: ":")
        return environment
    }

    private static func rememberValidated(_ status: Status) {
        guard case let .ready(location, version) = status else { return }
        UserDefaults.standard.set(location, forKey: cliValidatedExecutableKey)
        UserDefaults.standard.set(version, forKey: cliValidatedVersionKey)
    }

    @discardableResult
    static func install(statusHandler: @escaping @MainActor @Sendable (String) async -> Void) async -> Bool {
        let expected = GatewayEnvironment.expectedGatewayVersionString() ?? "latest"
        let prefix = Self.installPrefix()
        await statusHandler("Installing openclaw CLI…")
        guard let installerURL = Bundle.main.url(forResource: "install-cli", withExtension: "sh") else {
            await statusHandler("Install failed: installer resource is missing. Reinstall OpenClaw.")
            return false
        }
        let cmd = self.installScriptCommand(
            version: expected,
            prefix: prefix,
            scriptPath: installerURL.path)
        let response = await ShellExecutor.runDetailed(command: cmd, cwd: nil, env: nil, timeout: 900)

        if response.success {
            let managedStatus = await self.managedStatus()
            guard managedStatus.isReady else {
                await statusHandler("Install failed: \(managedStatus.message)")
                return false
            }
            let parsed = self.parseInstallEvents(response.stdout)
            let installedVersion = parsed.last { $0.event == "done" }?.version
            let summary = installedVersion.map { "Installed openclaw \($0)." } ?? "Installed openclaw."
            await statusHandler(summary)
            return true
        }

        let parsed = self.parseInstallEvents(response.stdout)
        if let error = parsed.last(where: { $0.event == "error" })?.message {
            await statusHandler("Install failed: \(error)")
            return false
        }

        let detail = response.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = response.errorMessage ?? "install failed"
        await statusHandler("Install failed: \(detail.isEmpty ? fallback : detail)")
        return false
    }

    private static func installPrefix() -> String {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw")
            .path
    }

    static func installScriptCommand(version: String, prefix: String, scriptPath: String) -> [String] {
        [
            "/bin/bash",
            scriptPath,
            "--json",
            "--no-onboard",
            "--prefix",
            prefix,
            "--version",
            version,
        ]
    }

    static func activateLocalGateway(
        mode: AppState.ConnectionMode = AppStateStore.shared.connectionMode,
        paused: Bool = AppStateStore.shared.isPaused,
        start: @MainActor () -> Void = { GatewayProcessManager.shared.setActive(true) },
        waitUntilReady: @MainActor () async -> Bool = {
            await GatewayProcessManager.shared.waitForGatewayReady(timeout: 12)
        }) async -> LocalGatewayActivation
    {
        guard mode == .local, !paused else { return .deferred }
        start()
        return await waitUntilReady() ? .ready : .failed
    }

    private static func parseInstallEvents(_ output: String) -> [InstallEvent] {
        let decoder = JSONDecoder()
        let lines = output
            .split(whereSeparator: \.isNewline)
            .map { String($0) }
        var events: [InstallEvent] = []
        for line in lines {
            guard let data = line.data(using: .utf8) else { continue }
            if let event = try? decoder.decode(InstallEvent.self, from: data) {
                events.append(event)
            }
        }
        return events
    }
}

private struct InstallEvent: Decodable {
    let event: String
    let version: String?
    let message: String?
}
