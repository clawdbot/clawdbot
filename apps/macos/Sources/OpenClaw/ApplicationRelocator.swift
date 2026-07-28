import AppKit
import Darwin
import Dispatch
import Foundation
import OSLog
import Security

@_silgen_name("csops")
private func csops(
    _: pid_t,
    _: UInt32,
    _: UnsafeMutableRawPointer?,
    _: Int) -> Int32

@MainActor
enum ApplicationRelocator {
    struct ApplicationIdentity: Equatable, Sendable {
        let bundleIdentifier: String
        let buildVersion: String
    }

    struct InstallCandidate: Equatable, Sendable {
        let url: URL
        let exists: Bool
        let isWritable: Bool
        let isTrusted: Bool
        let identity: ApplicationIdentity?
    }

    struct Environment: Equatable, Sendable {
        let bundleURL: URL
        let homeDirectory: URL
        let currentIdentity: ApplicationIdentity?
        let candidates: [InstallCandidate]
        let isReadOnlyVolume: Bool
        let isDebugOrTesting: Bool
    }

    enum Recommendation: Equatable, Sendable {
        case continueLaunch
        case handOff(URL)
        case offerInstall(destination: URL, replacing: Bool)
        case cannotInstall
    }

    enum LaunchDisposition: Equatable, Sendable {
        case continueLaunch(startUpdater: Bool)
        case terminating
    }

    struct ApplicationOnDisk: Equatable, Sendable {
        let bundleIdentifier: String
        let executableURL: URL
    }

    enum ReplacementAction: Equatable, Sendable {
        case unchanged
        case waitForTrustedReplacement
        case relaunch
    }

    enum RelaunchStrategy: Equatable, Sendable {
        case openAfterTermination
        case externalSupervisor
    }

    struct BundleFileReference: Equatable, Sendable {
        let deviceIdentifier: UInt64
        let fileIdentifier: UInt64
        let executableRelativePath: String

        var executableURL: URL {
            self.bundleURL.appendingPathComponent(self.executableRelativePath)
        }

        var bundleURL: URL {
            URL(
                fileURLWithPath: "/.vol/\(self.deviceIdentifier)/\(self.fileIdentifier)",
                isDirectory: true)
        }
    }

    private struct KeepAliveSupervisor: Sendable {
        let label: String
        let plistURL: URL
    }

    private struct BundleReplacementSnapshot: Sendable {
        let bundleURL: URL
        let bundleIdentifier: String
        let executableURL: URL
        let codeDirectoryHash: Data
        let requirementData: Data
    }

    private struct ReplacementEvaluation: Sendable {
        let action: ReplacementAction
        let launchReference: BundleFileReference?
        let launchCodeDirectoryHash: Data?
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "app-relocation")
    private static var bundleReplacementSnapshot: BundleReplacementSnapshot?
    private static var bundleReplacementSource: DispatchSourceFileSystemObject?
    private static var bundleReplacementRecoveryTask: Task<Void, Never>?
    private static var bundleReplacementCheckPending = false
    private static var bundleReplacementHandoffInProgress = false
    private static var inheritedReplacementSupervisor: KeepAliveSupervisor?
    private static var supervisorRestorationWatcher: Process?
    private static var authenticatedReplacementSourceBundleURL: URL?
    private nonisolated static let replacementSourceBundleEnvironmentKey = "OPENCLAW_REPLACEMENT_SOURCE_BUNDLE"
    private nonisolated static let replacementParentPIDEnvironmentKey = "OPENCLAW_REPLACEMENT_PARENT_PID"
    private nonisolated static let replacementCodeHashEnvironmentKey = "OPENCLAW_REPLACEMENT_CODE_HASH"
    private nonisolated static let replacementReadyFDEnvironmentKey = "OPENCLAW_REPLACEMENT_READY_FD"
    private nonisolated static let replacementBootoutTargetEnvironmentKey = "OPENCLAW_REPLACEMENT_BOOTOUT_TARGET"
    private nonisolated static let replacementSupervisorLabelEnvironmentKey =
        "OPENCLAW_REPLACEMENT_SUPERVISOR_LABEL"
    private nonisolated static let replacementSupervisorPlistEnvironmentKey =
        "OPENCLAW_REPLACEMENT_SUPERVISOR_PLIST"

    static func recommendation(for environment: Environment) -> Recommendation {
        guard !environment.isDebugOrTesting,
              self.isTransientLocation(
                  environment.bundleURL,
                  homeDirectory: environment.homeDirectory,
                  isReadOnlyVolume: environment.isReadOnlyVolume)
        else {
            return .continueLaunch
        }

        if let currentIdentity = environment.currentIdentity {
            for candidate in environment.candidates {
                guard let installedIdentity = candidate.identity,
                      candidate.isTrusted,
                      installedIdentity.bundleIdentifier == currentIdentity.bundleIdentifier,
                      compareBuild(installedIdentity.buildVersion, currentIdentity.buildVersion) !=
                      .orderedAscending
                else { continue }
                return .handOff(candidate.url)
            }

            for candidate in environment.candidates {
                guard candidate.isWritable,
                      candidate.isTrusted,
                      let installedIdentity = candidate.identity,
                      installedIdentity.bundleIdentifier == currentIdentity.bundleIdentifier
                else { continue }
                return .offerInstall(destination: candidate.url, replacing: true)
            }
        }

        if let destination = environment.candidates.first(where: { !$0.exists && $0.isWritable }) {
            return .offerInstall(destination: destination.url, replacing: false)
        }
        return .cannotInstall
    }

    static func isTransientLocation(
        _ bundleURL: URL,
        homeDirectory: URL,
        isReadOnlyVolume: Bool) -> Bool
    {
        let path = bundleURL.standardizedFileURL.path
        let homePath = homeDirectory.standardizedFileURL.path
        let stableRoots = ["/Applications", "\(homePath)/Applications"]
        if stableRoots.contains(where: { self.isInside(path, root: $0) }) {
            return false
        }
        if path.contains("/AppTranslocation/") {
            return true
        }
        let transientRoots = ["\(homePath)/Downloads", "\(homePath)/Desktop"]
        if transientRoots.contains(where: { self.isInside(path, root: $0) }) {
            return true
        }
        return isInside(path, root: "/Volumes") && isReadOnlyVolume
    }

    static func handleLaunch(
        bundle: Bundle = .main,
        fileManager: FileManager = .default,
        processInfo: ProcessInfo = .processInfo) -> LaunchDisposition
    {
        let environment = currentEnvironment(
            bundle: bundle,
            fileManager: fileManager,
            processInfo: processInfo)
        switch self.recommendation(for: environment) {
        case .continueLaunch:
            #if DEBUG
            let monitorDebugReplacement = processInfo.environment["OPENCLAW_MONITOR_APP_REPLACEMENT"] == "1"
            #else
            let monitorDebugReplacement = true
            #endif
            if !processInfo.isRunningTests, !processInfo.isPreview, monitorDebugReplacement {
                let monitoredBundleURL = replacementSourceBundleURL(
                    environment: processInfo.environment,
                    fallback: bundle.bundleURL)
                startBundleReplacementMonitoring(bundle: bundle, at: monitoredBundleURL)
            }
            return .continueLaunch(startUpdater: true)
        case let .handOff(destination):
            return relaunchAndTerminate(at: destination)
        case let .offerInstall(destination, replacing):
            guard confirmInstall(replacing: replacing) else {
                return .continueLaunch(startUpdater: false)
            }
            do {
                try install(
                    source: environment.bundleURL,
                    destination: destination,
                    replacing: replacing,
                    fileManager: fileManager)
                return relaunchAndTerminate(at: destination)
            } catch {
                self.logger.error("Could not install app: \(error.localizedDescription, privacy: .public)")
                showFailure(
                    "OpenClaw couldn’t be installed in Applications. Move it there manually, then open that copy.")
                return .continueLaunch(startUpdater: false)
            }
        case .cannotInstall:
            let message =
                "OpenClaw is running from a temporary location. " +
                "Move it to Applications manually to enable updates and launch at login."
            showFailure(message)
            return .continueLaunch(startUpdater: false)
        }
    }

    static func currentBundleAllowsPersistentIntegration(
        bundle: Bundle = .main,
        fileManager: FileManager = .default,
        processInfo: ProcessInfo = .processInfo) -> Bool
    {
        #if DEBUG
        let debugBuild = true
        #else
        let debugBuild = false
        #endif
        if debugBuild || processInfo.isRunningTests || processInfo.isPreview {
            return true
        }

        let bundleURL = replacementSourceBundleURL(
            environment: processInfo.environment,
            fallback: bundle.bundleURL)
        let isReadOnlyVolume = (try? bundleURL.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?
            .volumeIsReadOnly ?? false
        return !self.isTransientLocation(
            bundleURL,
            homeDirectory: fileManager.homeDirectoryForCurrentUser,
            isReadOnlyVolume: isReadOnlyVolume)
    }
}

extension ApplicationRelocator {
    nonisolated static func replacementAction(
        launchedCodeDirectoryHash: Data,
        installedCodeDirectoryHash: Data?,
        sameBundleIdentifier: Bool,
        trusted: Bool) -> ReplacementAction
    {
        guard let installedCodeDirectoryHash else { return .waitForTrustedReplacement }
        guard installedCodeDirectoryHash != launchedCodeDirectoryHash else { return .unchanged }
        guard sameBundleIdentifier, trusted else { return .waitForTrustedReplacement }
        return .relaunch
    }

    static func relaunchStrategy(
        xpcServiceName: String?,
        executableURL: URL?,
        homeDirectory: URL,
        fileManager: FileManager = .default) -> RelaunchStrategy
    {
        self.verifiedKeepAliveSupervisor(
            xpcServiceName: xpcServiceName,
            executableURL: executableURL,
            homeDirectory: homeDirectory,
            fileManager: fileManager) == nil ? .openAfterTermination : .externalSupervisor
    }

    private static func verifiedKeepAliveSupervisor(
        xpcServiceName: String?,
        executableURL: URL?,
        homeDirectory: URL,
        fileManager _: FileManager = .default) -> KeepAliveSupervisor?
    {
        guard let serviceName = xpcServiceName?.trimmingCharacters(in: .whitespacesAndNewlines),
              !serviceName.isEmpty,
              serviceName != "0",
              !serviceName.hasPrefix("application."),
              URL(fileURLWithPath: serviceName).lastPathComponent == serviceName,
              let executableURL
        else {
            return nil
        }
        let launchAgentURLs = [
            homeDirectory.appendingPathComponent("Library/LaunchAgents/\(serviceName).plist"),
            URL(fileURLWithPath: "/Library/LaunchAgents/\(serviceName).plist"),
            URL(fileURLWithPath: "/System/Library/LaunchAgents/\(serviceName).plist"),
        ]
        let expectedExecutable = executableURL.standardizedFileURL.path
        for url in launchAgentURLs {
            if let supervisor = keepAliveSupervisor(
                label: serviceName,
                plistURL: url,
                expectedExecutablePath: expectedExecutable)
            {
                return supervisor
            }
        }
        return nil
    }

    private static func inheritedSupervisor(
        environment: [String: String],
        monitoredBundleURL: URL) -> KeepAliveSupervisor?
    {
        guard let label = environment[replacementSupervisorLabelEnvironmentKey],
              let plistPath = environment[replacementSupervisorPlistEnvironmentKey],
              plistPath.hasPrefix("/"),
              let executablePath = applicationOnDisk(at: monitoredBundleURL)?.executableURL.path
        else { return nil }
        let plistURL = URL(fileURLWithPath: plistPath).standardizedFileURL
        let allowedDirectories = [
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents"),
            URL(fileURLWithPath: "/Library/LaunchAgents"),
            URL(fileURLWithPath: "/System/Library/LaunchAgents"),
        ].map(\.standardizedFileURL.path)
        guard allowedDirectories.contains(plistURL.deletingLastPathComponent().path) else { return nil }
        return self.keepAliveSupervisor(
            label: label,
            plistURL: plistURL,
            expectedExecutablePath: executablePath)
    }

    private static func keepAliveSupervisor(
        label: String,
        plistURL: URL,
        expectedExecutablePath: String) -> KeepAliveSupervisor?
    {
        guard !label.isEmpty,
              label != "0",
              !label.hasPrefix("application."),
              URL(fileURLWithPath: label).lastPathComponent == label,
              let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
              as? [String: Any],
              plist["Label"] as? String == label,
              plist["KeepAlive"] as? Bool == true
        else { return nil }
        let configuredExecutable = (plist["Program"] as? String) ??
            (plist["ProgramArguments"] as? [String])?.first
        guard configuredExecutable.map({ URL(fileURLWithPath: $0).standardizedFileURL.path }) ==
            URL(fileURLWithPath: expectedExecutablePath).standardizedFileURL.path
        else { return nil }
        return KeepAliveSupervisor(label: label, plistURL: plistURL)
    }

    static func acceptReplacementHandoff(
        environment: [String: String],
        bundle: Bundle = .main) -> Bool
    {
        guard let sourcePath = environment[replacementSourceBundleEnvironmentKey],
              sourcePath.hasPrefix("/"),
              URL(fileURLWithPath: sourcePath).pathExtension == "app",
              let parentPIDText = environment[replacementParentPIDEnvironmentKey],
              let parentPID = pid_t(parentPIDText),
              parentPID == getppid(),
              let expectedHashText = environment[replacementCodeHashEnvironmentKey],
              let expectedHash = Data(base64Encoded: expectedHashText),
              expectedHash == kernelCodeDirectoryHash(),
              let readyFDText = environment[replacementReadyFDEnvironmentKey],
              let readyFD = Int32(readyFDText),
              readyFD >= 3,
              fcntl(readyFD, F_GETFD) != -1,
              let bundleIdentifier = bundle.bundleIdentifier,
              let identity = runningCodeIdentity(bundleIdentifier: bundleIdentifier),
              let executableURL = bundle.executableURL,
              // Revalidate the bound bundle in the child. The parent cannot make
              // the sealed resources immutable across posix_spawn.
              trustedCodeDirectoryHash(
                  at: bundle.bundleURL,
                  executableURL: executableURL,
                  matching: identity.requirementData) == expectedHash,
              process(parentPID, matches: identity.requirementData)
        else { return false }

        let monitoredBundleURL = URL(fileURLWithPath: sourcePath).standardizedFileURL
        let supervisor = self.inheritedSupervisor(
            environment: environment,
            monitoredBundleURL: monitoredBundleURL)
        let hasSupervisorMetadata = environment[replacementSupervisorLabelEnvironmentKey] != nil ||
            environment[self.replacementSupervisorPlistEnvironmentKey] != nil
        guard !hasSupervisorMetadata || supervisor != nil else {
            self.writeHandoffStatus("FAIL", to: readyFD)
            return false
        }
        self.inheritedReplacementSupervisor = supervisor
        if let supervisor, !startSupervisorRestorationWatcher(supervisor) {
            self.writeHandoffStatus("FAIL", to: readyFD)
            return false
        }

        let bootoutTarget = environment[replacementBootoutTargetEnvironmentKey]
        if let target = bootoutTarget {
            guard let supervisor,
                  target == "gui/\(getuid())/\(supervisor.label)",
                  bootoutLaunchdTarget(target)
            else {
                self.cancelSupervisorRestorationWatcher()
                self.writeHandoffStatus("FAIL", to: readyFD)
                return false
            }
        }
        self.authenticatedReplacementSourceBundleURL = monitoredBundleURL
        self.writeHandoffStatus("READY", to: readyFD)
        return true
    }

    nonisolated static func hasReplacementHandoffMetadata(environment: [String: String]) -> Bool {
        environment[self.replacementParentPIDEnvironmentKey] != nil ||
            environment[self.replacementReadyFDEnvironmentKey] != nil ||
            environment[self.replacementCodeHashEnvironmentKey] != nil
    }

    private static func bootoutLaunchdTarget(_ target: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["bootout", target]
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            self.logger.error("Could not unload launchd owner: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private nonisolated static func writeHandoffStatus(_ status: String, to descriptor: Int32) {
        defer { Darwin.close(descriptor) }
        _ = fcntl(descriptor, F_SETNOSIGPIPE, 1)
        let bytes = Array(status.utf8)
        _ = bytes.withUnsafeBytes { buffer in
            Darwin.write(descriptor, buffer.baseAddress, buffer.count)
        }
    }

    private nonisolated static func process(_ pid: pid_t, matches requirementData: Data) -> Bool {
        var requirement: SecRequirement?
        guard SecRequirementCreateWithData(requirementData as CFData, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement
        else { return false }
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess,
              let code
        else { return false }
        return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
    }

    nonisolated static func applicationOnDisk(at bundleURL: URL) -> ApplicationOnDisk? {
        let infoPlistURL = bundleURL.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: infoPlistURL),
              let values = try? PropertyListSerialization.propertyList(from: data, format: nil)
              as? [String: Any],
              let bundleIdentifier = values["CFBundleIdentifier"] as? String,
              !bundleIdentifier.isEmpty,
              let executableName = values["CFBundleExecutable"] as? String,
              !executableName.isEmpty,
              URL(fileURLWithPath: executableName).lastPathComponent == executableName
        else { return nil }
        return ApplicationOnDisk(
            bundleIdentifier: bundleIdentifier,
            executableURL: bundleURL
                .appendingPathComponent("Contents/MacOS")
                .appendingPathComponent(executableName))
    }

    private static func currentEnvironment(
        bundle: Bundle,
        fileManager: FileManager,
        processInfo: ProcessInfo) -> Environment
    {
        let bundleURL = self.replacementSourceBundleURL(
            environment: processInfo.environment,
            fallback: bundle.bundleURL)
        let homeDirectory = fileManager.homeDirectoryForCurrentUser.standardizedFileURL
        let appName = bundleURL.lastPathComponent
        let destinations = [
            URL(fileURLWithPath: "/Applications").appendingPathComponent(appName),
            homeDirectory.appendingPathComponent("Applications").appendingPathComponent(appName),
        ]
        let currentRequirement = self.designatedRequirement(for: bundleURL)
        let candidates = destinations.map { destination in
            let exists = fileManager.fileExists(atPath: destination.path)
            let installedBundle = exists ? Bundle(url: destination) : nil
            return InstallCandidate(
                url: destination,
                exists: exists,
                isWritable: self.canWrite(destination: destination, fileManager: fileManager),
                isTrusted: installedBundle.map {
                    self.isTrustedInstalledApp($0, matching: currentRequirement, fileManager: fileManager)
                } ?? false,
                identity: installedBundle.flatMap(self.identity(for:)))
        }
        #if DEBUG
        let debugBuild = true
        #else
        let debugBuild = false
        #endif
        let isReadOnlyVolume = (try? bundleURL.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?
            .volumeIsReadOnly ?? false
        return Environment(
            bundleURL: bundleURL,
            homeDirectory: homeDirectory,
            currentIdentity: self.identity(for: bundle),
            candidates: candidates,
            isReadOnlyVolume: isReadOnlyVolume,
            isDebugOrTesting: debugBuild || processInfo.isRunningTests || processInfo.isPreview)
    }

    private static func identity(for bundle: Bundle) -> ApplicationIdentity? {
        guard let bundleIdentifier = bundle.bundleIdentifier,
              let buildVersion = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        else { return nil }
        return ApplicationIdentity(bundleIdentifier: bundleIdentifier, buildVersion: buildVersion)
    }

    private static func replacementSourceBundleURL(
        environment _: [String: String],
        fallback: URL) -> URL
    {
        self.authenticatedReplacementSourceBundleURL ?? fallback.standardizedFileURL
    }

    private static func startBundleReplacementMonitoring(bundle: Bundle, at monitoredBundleURL: URL) {
        self.bundleReplacementRecoveryTask?.cancel()
        self.bundleReplacementRecoveryTask = nil
        self.bundleReplacementSource?.cancel()
        self.bundleReplacementSource = nil
        self.bundleReplacementSnapshot = nil
        self.bundleReplacementCheckPending = false
        self.bundleReplacementHandoffInProgress = false

        let bundleURL = monitoredBundleURL.standardizedFileURL
        guard bundleURL.pathExtension == "app",
              let bundleIdentifier = bundle.bundleIdentifier,
              let installedApp = applicationOnDisk(at: bundleURL),
              installedApp.bundleIdentifier == bundleIdentifier,
              let runningIdentity = runningCodeIdentity(bundleIdentifier: bundleIdentifier)
        else {
            self.logger.warning("Installed app replacement monitoring is unavailable")
            return
        }

        self.bundleReplacementSnapshot = BundleReplacementSnapshot(
            bundleURL: bundleURL,
            bundleIdentifier: bundleIdentifier,
            executableURL: installedApp.executableURL,
            codeDirectoryHash: runningIdentity.codeDirectoryHash,
            requirementData: runningIdentity.requirementData)

        let descriptor = open(bundleURL.deletingLastPathComponent().path, O_EVTONLY | O_CLOEXEC)
        guard descriptor >= 0 else {
            self.logger.error("Could not monitor installed app directory: errno \(errno)")
            self.bundleReplacementSnapshot = nil
            return
        }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .delete, .rename, .revoke],
            queue: .main)
        source.setEventHandler {
            Task { @MainActor in
                ApplicationRelocator.bundleDirectoryDidChange()
            }
        }
        source.setCancelHandler {
            Darwin.close(descriptor)
        }
        self.bundleReplacementSource = source
        source.resume()
        // Reconcile once after arming. This closes the launch-to-watch window even
        // when the directory event coalesced before the source became active.
        self.bundleDirectoryDidChange()
        self.logger.notice("Monitoring the installed app for signed replacement")
    }

    private static func bundleDirectoryDidChange() {
        self.bundleReplacementCheckPending = true
        guard !self.bundleReplacementHandoffInProgress,
              self.bundleReplacementRecoveryTask == nil,
              let snapshot = bundleReplacementSnapshot
        else { return }

        self.bundleReplacementRecoveryTask = Task { @MainActor in
            defer {
                self.bundleReplacementRecoveryTask = nil
                if self.bundleReplacementCheckPending {
                    self.bundleDirectoryDidChange()
                }
            }

            // Atomic replacements can briefly remove the bundle or expose it before
            // code-signature validation is complete. Keep the old process alive until
            // the complete replacement is present and trusted.
            var attempt = 0
            while !Task.isCancelled {
                self.bundleReplacementCheckPending = false
                let evaluation = await Task.detached(priority: .utility) {
                    self.replacementEvaluationOnDisk(for: snapshot)
                }.value
                switch evaluation.action {
                case .unchanged:
                    if self.bundleReplacementCheckPending {
                        continue
                    }
                    return
                case .waitForTrustedReplacement:
                    if attempt == 120 {
                        self.logger.warning(
                            "Installed app is still incomplete or untrusted; continuing replacement recovery")
                    }
                    let retryDelay: Duration = attempt < 120 ? .milliseconds(250) : .seconds(5)
                    attempt += 1
                    try? await Task.sleep(for: retryDelay)
                    guard !Task.isCancelled else { return }
                case .relaunch:
                    guard let launchReference = evaluation.launchReference,
                          let launchCodeDirectoryHash = evaluation.launchCodeDirectoryHash
                    else {
                        try? await Task.sleep(for: .milliseconds(250))
                        continue
                    }
                    self.bundleReplacementCheckPending = false
                    self.logger.notice("Installed app changed; relaunching trusted replacement")
                    self.bundleReplacementHandoffInProgress = true
                    let scheduled = self.scheduleReplacementRelaunch(
                        at: snapshot.bundleURL,
                        launchReference: launchReference,
                        codeDirectoryHash: launchCodeDirectoryHash)
                    if !scheduled {
                        self.bundleReplacementHandoffInProgress = false
                        try? await Task.sleep(for: .seconds(1))
                        continue
                    }
                    return
                }
            }
        }
    }

    private nonisolated static func replacementEvaluationOnDisk(
        for snapshot: BundleReplacementSnapshot) -> ReplacementEvaluation
    {
        guard let installedApp = applicationOnDisk(at: snapshot.bundleURL) else {
            return ReplacementEvaluation(
                action: .waitForTrustedReplacement,
                launchReference: nil,
                launchCodeDirectoryHash: nil)
        }
        guard let launchReference = bundleFileReference(
            bundleURL: snapshot.bundleURL,
            executableURL: installedApp.executableURL)
        else {
            return ReplacementEvaluation(
                action: .waitForTrustedReplacement,
                launchReference: nil,
                launchCodeDirectoryHash: nil)
        }
        let sameBundleIdentifier = installedApp.bundleIdentifier == snapshot.bundleIdentifier
        let installedCodeDirectoryHash = self.trustedCodeDirectoryHash(
            at: snapshot.bundleURL,
            executableURL: installedApp.executableURL,
            matching: snapshot.requirementData)
        // Security validates the canonical path. Re-capture its object identity
        // afterward so the launch reference can only name that validated bundle.
        guard self.bundleFileReference(
            bundleURL: snapshot.bundleURL,
            executableURL: installedApp.executableURL) == launchReference
        else {
            return ReplacementEvaluation(
                action: .waitForTrustedReplacement,
                launchReference: nil,
                launchCodeDirectoryHash: nil)
        }
        let action = self.replacementAction(
            launchedCodeDirectoryHash: snapshot.codeDirectoryHash,
            installedCodeDirectoryHash: installedCodeDirectoryHash,
            sameBundleIdentifier: sameBundleIdentifier,
            trusted: installedCodeDirectoryHash != nil)
        return ReplacementEvaluation(
            action: action,
            launchReference: action == .relaunch ? launchReference : nil,
            launchCodeDirectoryHash: action == .relaunch ? installedCodeDirectoryHash : nil)
    }

    nonisolated static func bundleFileReference(
        bundleURL: URL,
        executableURL: URL) -> BundleFileReference?
    {
        let bundlePath = bundleURL.standardizedFileURL.path
        let executablePath = executableURL.standardizedFileURL.path
        let prefix = bundlePath + "/"
        guard executablePath.hasPrefix(prefix) else { return nil }

        var bundleInformation = stat()
        guard stat(bundlePath, &bundleInformation) == 0,
              bundleInformation.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR)
        else { return nil }
        let relativePath = String(executablePath.dropFirst(prefix.count))
        guard !relativePath.isEmpty else { return nil }

        let reference = BundleFileReference(
            deviceIdentifier: UInt64(truncatingIfNeeded: bundleInformation.st_dev),
            fileIdentifier: UInt64(bundleInformation.st_ino),
            executableRelativePath: relativePath)
        var canonicalExecutableInformation = stat()
        var referencedExecutableInformation = stat()
        guard stat(executablePath, &canonicalExecutableInformation) == 0,
              stat(reference.executableURL.path, &referencedExecutableInformation) == 0,
              canonicalExecutableInformation.st_dev == referencedExecutableInformation.st_dev,
              canonicalExecutableInformation.st_ino == referencedExecutableInformation.st_ino,
              canonicalExecutableInformation.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              canonicalExecutableInformation.st_mode & mode_t(S_IXUSR) != 0
        else { return nil }
        return reference
    }

    private static func runningCodeIdentity(
        bundleIdentifier: String) -> (codeDirectoryHash: Data, requirementData: Data)?
    {
        guard let codeDirectoryHash = kernelCodeDirectoryHash(),
              let teamIdentifier = kernelTeamIdentifier(),
              let requirementString = developerIDRequirementString(
                  bundleIdentifier: bundleIdentifier,
                  teamIdentifier: teamIdentifier)
        else { return nil }
        var requirement: SecRequirement?
        var requirementData: CFData?
        guard SecRequirementCreateWithString(
            requirementString as CFString,
            SecCSFlags(),
            &requirement) == errSecSuccess,
            let requirement,
            SecRequirementCopyData(requirement, SecCSFlags(), &requirementData) == errSecSuccess,
            let requirementData
        else { return nil }
        return (codeDirectoryHash, requirementData as Data)
    }

    nonisolated static func developerIDRequirementString(
        bundleIdentifier: String,
        teamIdentifier: String) -> String?
    {
        guard self.isRequirementToken(bundleIdentifier), self.isRequirementToken(teamIdentifier) else { return nil }
        return "identifier \"\(bundleIdentifier)\" and anchor apple generic and " +
            "certificate 1[field.1.2.840.113635.100.6.2.6] exists and " +
            "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and " +
            "certificate leaf[subject.OU] = \"\(teamIdentifier)\""
    }

    private static func kernelCodeDirectoryHash() -> Data? {
        var bytes = [UInt8](repeating: 0, count: 20)
        let result = bytes.withUnsafeMutableBytes {
            csops(getpid(), 5, $0.baseAddress, $0.count)
        }
        return result == 0 ? Data(bytes) : nil
    }

    private static func kernelTeamIdentifier() -> String? {
        // XNU kern_proc.c prefixes CS_OPS_TEAMID with an 8-byte fake blob header;
        // the NUL-terminated identifier starts immediately after that header.
        var bytes = [UInt8](repeating: 0, count: 8 + 64)
        let result = bytes.withUnsafeMutableBytes {
            csops(getpid(), 14, $0.baseAddress, $0.count)
        }
        guard result == 0 else { return nil }
        return self.teamIdentifier(fromCSOpsToken: bytes)
    }

    nonisolated static func teamIdentifier(fromCSOpsToken bytes: [UInt8]) -> String? {
        guard bytes.count > 8 else { return nil }
        let payload = bytes.dropFirst(8)
        guard let terminator = payload.firstIndex(of: 0),
              terminator > payload.startIndex
        else { return nil }
        return String(bytes: payload[..<terminator], encoding: .utf8)
    }

    private nonisolated static func isRequirementToken(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "-"
        }
    }

    private nonisolated static func codeDirectoryHash(for code: SecStaticCode) -> Data? {
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(), &information) == errSecSuccess,
              let information
        else { return nil }
        return (information as NSDictionary)[kSecCodeInfoUnique] as? Data
    }

    private nonisolated static func trustedCodeDirectoryHash(
        at bundleURL: URL,
        executableURL: URL,
        matching requirementData: Data) -> Data?
    {
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else { return nil }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithData(requirementData as CFData, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement
        else { return nil }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
              let code,
              SecStaticCodeCheckValidity(
                  code,
                  SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode),
                  requirement) == errSecSuccess
        else { return nil }
        return self.codeDirectoryHash(for: code)
    }

    private static func designatedRequirement(for bundleURL: URL) -> SecRequirement? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
              let code
        else { return nil }

        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(code, SecCSFlags(), &requirement) == errSecSuccess else { return nil }
        return requirement
    }

    private static func isTrustedInstalledApp(
        _ bundle: Bundle,
        matching requirement: SecRequirement?,
        fileManager: FileManager) -> Bool
    {
        guard let executableURL = bundle.executableURL else { return false }
        return self.isTrustedInstalledApp(
            at: bundle.bundleURL,
            executableURL: executableURL,
            matching: requirement,
            fileManager: fileManager)
    }

    private static func isTrustedInstalledApp(
        at bundleURL: URL,
        executableURL: URL,
        matching requirement: SecRequirement?,
        fileManager: FileManager) -> Bool
    {
        guard let requirement, fileManager.isExecutableFile(atPath: executableURL.path) else { return false }

        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
              let code
        else { return false }
        return SecStaticCodeCheckValidity(
            code,
            SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode),
            requirement) == errSecSuccess
    }

    private static func canWrite(destination: URL, fileManager: FileManager) -> Bool {
        var ancestor = destination.deletingLastPathComponent()
        while !fileManager.fileExists(atPath: ancestor.path) {
            let parent = ancestor.deletingLastPathComponent()
            guard parent != ancestor else { return false }
            ancestor = parent
        }
        return fileManager.isWritableFile(atPath: ancestor.path)
    }

    private static func install(
        source: URL,
        destination: URL,
        replacing: Bool,
        fileManager: FileManager) throws
    {
        let parent = destination.deletingLastPathComponent()
        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        let staging = parent.appendingPathComponent(".\(destination.lastPathComponent).installing-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: staging) }
        try fileManager.copyItem(at: source, to: staging)

        if replacing {
            let backupName = ".\(destination.lastPathComponent).backup-\(UUID().uuidString)"
            _ = try fileManager.replaceItemAt(
                destination,
                withItemAt: staging,
                backupItemName: backupName)
            try? fileManager.removeItem(at: parent.appendingPathComponent(backupName))
        } else {
            try fileManager.moveItem(at: staging, to: destination)
        }
    }

    private static func confirmInstall(replacing: Bool) -> Bool {
        let alert = NSAlert()
        alert.messageText = replacing
            ? "Replace the older OpenClaw in Applications?"
            : "Install OpenClaw in Applications?"
        alert.informativeText = replacing
            ? "This copy is newer than the installed app. OpenClaw will replace it and reopen from Applications."
            : "OpenClaw will copy itself to Applications and reopen there so updates and launch at login stay reliable."
        alert.alertStyle = .informational
        alert.addButton(withTitle: replacing ? "Replace and Relaunch" : "Install and Relaunch")
        let cancel = alert.addButton(withTitle: "Not Now")
        cancel.keyEquivalent = "\u{1b}"
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    private static func relaunchAndTerminate(at destination: URL) -> LaunchDisposition {
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sh")
        let processInfo = ProcessInfo.processInfo
        helper.arguments = [
            "-c",
            "while /bin/kill -0 \"$2\" 2>/dev/null; do /bin/sleep 0.1; done; exec /usr/bin/open -n \"$1\"",
            "openclaw-relocation",
            destination.path,
            String(processInfo.processIdentifier),
        ]
        do {
            try helper.run()
            TerminationSignalWatcher.scheduleExitFailsafe()
            NSApp.terminate(nil)
            return .terminating
        } catch {
            self.logger.error("Could not schedule relaunch: \(error.localizedDescription, privacy: .public)")
            self.showFailure(
                "OpenClaw is installed in Applications, but couldn’t reopen automatically. Open it there manually.")
            return .continueLaunch(startUpdater: false)
        }
    }

    private static func startSupervisorRestorationWatcher(_ supervisor: KeepAliveSupervisor) -> Bool {
        guard self.supervisorRestorationWatcher == nil else { return true }
        let watcher = Process()
        let processIdentifier = ProcessInfo.processInfo.processIdentifier
        let domain = "gui/\(getuid())"
        watcher.executableURL = URL(fileURLWithPath: "/bin/sh")
        watcher.arguments = [
            "-c",
            "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.1; done; " +
                "/bin/launchctl bootstrap \"$2\" \"$3\" 2>/dev/null || true; " +
                "/bin/launchctl kickstart \"$4\"",
            "openclaw-supervisor-restoration",
            String(processIdentifier),
            domain,
            supervisor.plistURL.path,
            "\(domain)/\(supervisor.label)",
        ]
        do {
            try watcher.run()
            self.supervisorRestorationWatcher = watcher
            return true
        } catch {
            self.logger.error("Could not schedule launchd restoration: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private static func cancelSupervisorRestorationWatcher() {
        guard let watcher = supervisorRestorationWatcher else { return }
        self.supervisorRestorationWatcher = nil
        guard watcher.isRunning else { return }
        Darwin.kill(watcher.processIdentifier, SIGKILL)
        watcher.waitUntilExit()
    }

    private static func scheduleReplacementRelaunch(
        at destination: URL,
        launchReference: BundleFileReference,
        codeDirectoryHash: Data) -> Bool
    {
        let processInfo = ProcessInfo.processInfo
        let activeSupervisor = self.verifiedKeepAliveSupervisor(
            xpcServiceName: processInfo.environment["XPC_SERVICE_NAME"],
            executableURL: Bundle.main.executableURL,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser)
        let supervisor = self.inheritedReplacementSupervisor ?? activeSupervisor
        let forwardedArguments = Array(processInfo.arguments.dropFirst())
        let bootoutTarget = activeSupervisor.map { "gui/\(getuid())/\($0.label)" }
        // The volfs path pins atomic bundle swaps and direct exec bypasses mutable
        // Info.plist routing. The child must also prove its kernel CDHash over the
        // inherited pipe before the old process yields ownership.
        guard let spawned = spawnReplacement(
            launchReference: launchReference,
            sourceBundleURL: destination,
            codeDirectoryHash: codeDirectoryHash,
            supervisor: supervisor,
            bootoutTarget: bootoutTarget,
            forwardedArguments: forwardedArguments)
        else {
            self.logger.error("Could not spawn the trusted replacement")
            return false
        }

        Task { @MainActor in
            let handoffStatus = await Task.detached(priority: .utility) {
                self.awaitReplacementHandoff(on: spawned.readyDescriptor)
            }.value
            Darwin.close(spawned.readyDescriptor)
            guard handoffStatus == "READY" else {
                Darwin.kill(spawned.processIdentifier, SIGKILL)
                await Task.detached(priority: .utility) {
                    self.reapProcess(spawned.processIdentifier)
                }.value
                self.logger.error("Trusted replacement did not complete its authenticated handoff")
                self.bundleReplacementHandoffInProgress = false
                self.bundleReplacementCheckPending = true
                try? await Task.sleep(for: .seconds(1))
                self.bundleDirectoryDidChange()
                return
            }
            self.cancelSupervisorRestorationWatcher()
            TerminationSignalWatcher.scheduleExitFailsafe()
            NSApp.terminate(nil)
        }
        return true
    }

    private static func spawnReplacement(
        launchReference: BundleFileReference,
        sourceBundleURL: URL,
        codeDirectoryHash: Data,
        supervisor: KeepAliveSupervisor?,
        bootoutTarget: String?,
        forwardedArguments: [String]) -> (processIdentifier: pid_t, readyDescriptor: Int32)?
    {
        let childReadyDescriptor: Int32 = 19
        var descriptors = [Int32](repeating: -1, count: 2)
        guard pipe(&descriptors) == 0 else { return nil }
        let readDescriptor = descriptors[0]
        let writeDescriptor = descriptors[1]

        var environmentAssignments = [
            "\(replacementSourceBundleEnvironmentKey)=\(sourceBundleURL.path)",
            "\(self.replacementParentPIDEnvironmentKey)=\(getpid())",
            "\(self.replacementCodeHashEnvironmentKey)=\(codeDirectoryHash.base64EncodedString())",
            "\(self.replacementReadyFDEnvironmentKey)=\(childReadyDescriptor)",
        ]
        if let supervisor {
            environmentAssignments += [
                "\(self.replacementSupervisorLabelEnvironmentKey)=\(supervisor.label)",
                "\(self.replacementSupervisorPlistEnvironmentKey)=\(supervisor.plistURL.path)",
            ]
        }
        if let bootoutTarget {
            environmentAssignments.append("\(self.replacementBootoutTargetEnvironmentKey)=\(bootoutTarget)")
        }
        // The detached child is no longer owned by the current launchd job. Do not
        // let it inherit that job's identity and attempt a second bootout later.
        let arguments = [
            "/usr/bin/env",
            "-u",
            "XPC_SERVICE_NAME",
            "-u",
            replacementSourceBundleEnvironmentKey,
            "-u",
            replacementParentPIDEnvironmentKey,
            "-u",
            replacementCodeHashEnvironmentKey,
            "-u",
            replacementReadyFDEnvironmentKey,
            "-u",
            replacementBootoutTargetEnvironmentKey,
            "-u",
            replacementSupervisorLabelEnvironmentKey,
            "-u",
            replacementSupervisorPlistEnvironmentKey,
        ] + environmentAssignments +
            [launchReference.executableURL.path] + forwardedArguments
        var cArguments = arguments.map { strdup($0) } + [nil]
        defer { cArguments.compactMap(\.self).forEach { free($0) } }

        var fileActions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&fileActions) == 0,
              posix_spawnattr_init(&attributes) == 0
        else {
            Darwin.close(readDescriptor)
            Darwin.close(writeDescriptor)
            return nil
        }
        defer {
            posix_spawn_file_actions_destroy(&fileActions)
            posix_spawnattr_destroy(&attributes)
        }
        guard posix_spawn_file_actions_adddup2(&fileActions, writeDescriptor, childReadyDescriptor) == 0,
              posix_spawnattr_setflags(
                  &attributes,
                  Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0
        else {
            Darwin.close(readDescriptor)
            Darwin.close(writeDescriptor)
            return nil
        }
        if readDescriptor != childReadyDescriptor,
           posix_spawn_file_actions_addclose(&fileActions, readDescriptor) != 0
        {
            Darwin.close(readDescriptor)
            Darwin.close(writeDescriptor)
            return nil
        }
        if writeDescriptor != childReadyDescriptor,
           posix_spawn_file_actions_addclose(&fileActions, writeDescriptor) != 0
        {
            Darwin.close(readDescriptor)
            Darwin.close(writeDescriptor)
            return nil
        }

        var processIdentifier = pid_t()
        let spawnResult = cArguments.withUnsafeMutableBufferPointer { buffer in
            posix_spawn(
                &processIdentifier,
                "/usr/bin/env",
                &fileActions,
                &attributes,
                buffer.baseAddress,
                environ)
        }
        Darwin.close(writeDescriptor)
        guard spawnResult == 0 else {
            Darwin.close(readDescriptor)
            return nil
        }
        return (processIdentifier, readDescriptor)
    }

    private nonisolated static func awaitReplacementHandoff(on descriptor: Int32) -> String? {
        var event = pollfd(fd: descriptor, events: Int16(POLLIN | POLLHUP), revents: 0)
        guard poll(&event, 1, 10000) > 0 else { return nil }
        var bytes = [UInt8](repeating: 0, count: 16)
        let count = bytes.withUnsafeMutableBytes { buffer in
            Darwin.read(descriptor, buffer.baseAddress, buffer.count)
        }
        guard count > 0 else { return nil }
        return String(bytes: bytes.prefix(count), encoding: .utf8)
    }

    private nonisolated static func reapProcess(_ processIdentifier: pid_t) {
        var processStatus: Int32 = 0
        while waitpid(processIdentifier, &processStatus, 0) == -1, errno == EINTR {}
    }

    private static func showFailure(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Move OpenClaw to Applications"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private static func compareBuild(_ lhs: String, _ rhs: String) -> ComparisonResult {
        lhs.compare(rhs, options: .numeric)
    }

    private static func isInside(_ path: String, root: String) -> Bool {
        path == root || path.hasPrefix(root + "/")
    }
}
