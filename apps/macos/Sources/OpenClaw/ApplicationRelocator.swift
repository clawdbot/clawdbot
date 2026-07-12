import AppKit
import Foundation
import OSLog
import Security

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

    private static let logger = Logger(subsystem: "ai.openclaw", category: "app-relocation")

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
                      self
                          .compareBuild(installedIdentity.buildVersion, currentIdentity.buildVersion) !=
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
        return self.isInside(path, root: "/Volumes") && isReadOnlyVolume
    }

    static func handleLaunch(
        bundle: Bundle = .main,
        fileManager: FileManager = .default,
        processInfo: ProcessInfo = .processInfo) -> LaunchDisposition
    {
        let environment = self.currentEnvironment(
            bundle: bundle,
            fileManager: fileManager,
            processInfo: processInfo)
        switch self.recommendation(for: environment) {
        case .continueLaunch:
            return .continueLaunch(startUpdater: true)
        case let .handOff(destination):
            return self.relaunchAndTerminate(at: destination)
        case let .offerInstall(destination, replacing):
            guard self.confirmInstall(replacing: replacing) else {
                return .continueLaunch(startUpdater: false)
            }
            do {
                try self.install(
                    source: environment.bundleURL,
                    destination: destination,
                    replacing: replacing,
                    fileManager: fileManager)
                return self.relaunchAndTerminate(at: destination)
            } catch {
                self.logger.error("Could not install app: \(error.localizedDescription, privacy: .public)")
                self.showFailure(
                    "OpenClaw couldn’t be installed in Applications. Move it there manually, then open that copy.")
                return .continueLaunch(startUpdater: false)
            }
        case .cannotInstall:
            let message =
                "OpenClaw is running from a temporary location. " +
                "Move it to Applications manually to enable updates and launch at login."
            self.showFailure(message)
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

        let bundleURL = bundle.bundleURL.standardizedFileURL
        let isReadOnlyVolume = (try? bundleURL.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?
            .volumeIsReadOnly ?? false
        return !self.isTransientLocation(
            bundleURL,
            homeDirectory: fileManager.homeDirectoryForCurrentUser,
            isReadOnlyVolume: isReadOnlyVolume)
    }

    private static func currentEnvironment(
        bundle: Bundle,
        fileManager: FileManager,
        processInfo: ProcessInfo) -> Environment
    {
        let bundleURL = bundle.bundleURL.standardizedFileURL
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
        guard let requirement,
              let executableURL = bundle.executableURL,
              fileManager.isExecutableFile(atPath: executableURL.path)
        else { return false }

        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundle.bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
              let code
        else { return false }
        return SecStaticCodeCheckValidity(
            code,
            SecCSFlags(rawValue: kSecCSCheckAllArchitectures),
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
        helper.arguments = [
            "-c",
            "while /bin/kill -0 \"$2\" 2>/dev/null; do /bin/sleep 0.1; done; exec /usr/bin/open -n \"$1\"",
            "openclaw-relocation",
            destination.path,
            String(ProcessInfo.processInfo.processIdentifier),
        ]
        do {
            try helper.run()
            NSApp.terminate(nil)
            return .terminating
        } catch {
            self.logger.error("Could not schedule relaunch: \(error.localizedDescription, privacy: .public)")
            self
                .showFailure(
                    "OpenClaw is installed in Applications, but couldn’t reopen automatically. Open it there manually.")
            return .continueLaunch(startUpdater: false)
        }
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
