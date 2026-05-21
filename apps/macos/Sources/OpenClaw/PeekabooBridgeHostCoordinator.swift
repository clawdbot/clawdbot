import Foundation
import os
import PeekabooAutomationKit
import PeekabooBridge
import PeekabooFoundation
import Security

@MainActor
final class PeekabooBridgeHostCoordinator {
    static let shared = PeekabooBridgeHostCoordinator()

    private let logger = Logger(subsystem: "ai.openclaw", category: "PeekabooBridge")

    private var host: PeekabooBridgeHost?
    private var services: OpenClawPeekabooBridgeServices?

    private static let legacySocketDirectoryNames = ["clawdbot", "clawdis", "moltbot"]

    private static var openclawSocketPath: String {
        let fileManager = FileManager.default
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return Self.makeSocketPath(for: "OpenClaw", in: base)
    }

    private static func makeSocketPath(for directoryName: String, in baseDirectory: URL) -> String {
        baseDirectory
            .appendingPathComponent(directoryName, isDirectory: true)
            .appendingPathComponent(PeekabooBridgeConstants.socketName, isDirectory: false)
            .path
    }

    private static var legacySocketPaths: [String] {
        let fileManager = FileManager.default
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return Self.legacySocketDirectoryNames.map { Self.makeSocketPath(for: $0, in: base) }
    }

    func setEnabled(_ enabled: Bool) async {
        if enabled {
            await self.startIfNeeded()
        } else {
            await self.stop()
        }
    }

    func stop() async {
        guard let host else { return }
        await host.stop()
        self.host = nil
        self.services = nil
        self.logger.info("PeekabooBridge host stopped")
    }

    private func startIfNeeded() async {
        guard self.host == nil else { return }

        var allowlistedTeamIDs: Set = ["Y5PE65HELJ"]
        if let teamID = Self.currentTeamID() {
            allowlistedTeamIDs.insert(teamID)
        }
        let allowlistedBundles: Set<String> = []

        self.ensureLegacySocketSymlinks()

        let services = OpenClawPeekabooBridgeServices()
        let server = PeekabooBridgeServer(
            services: services,
            hostKind: .gui,
            allowlistedTeams: allowlistedTeamIDs,
            allowlistedBundles: allowlistedBundles)

        let host = PeekabooBridgeHost(
            socketPath: Self.openclawSocketPath,
            server: server,
            allowedTeamIDs: allowlistedTeamIDs,
            requestTimeoutSec: 10)

        self.services = services
        self.host = host

        await host.start()
        self.logger
            .info("PeekabooBridge host started at \(Self.openclawSocketPath, privacy: .public)")
    }

    private func ensureLegacySocketSymlinks() {
        for legacyPath in Self.legacySocketPaths {
            self.ensureLegacySocketSymlink(at: legacyPath)
        }
    }

    private func ensureLegacySocketSymlink(at legacyPath: String) {
        let fileManager = FileManager.default
        let legacyDirectory = (legacyPath as NSString).deletingLastPathComponent
        do {
            let directoryAttributes: [FileAttributeKey: Any] = [
                .posixPermissions: 0o700,
            ]
            try fileManager.createDirectory(
                atPath: legacyDirectory,
                withIntermediateDirectories: true,
                attributes: directoryAttributes)
            let linkURL = URL(fileURLWithPath: legacyPath)
            let linkValues = try? linkURL.resourceValues(forKeys: [.isSymbolicLinkKey])
            if linkValues?.isSymbolicLink == true {
                let destination = try FileManager.default.destinationOfSymbolicLink(atPath: legacyPath)
                let destinationURL = URL(fileURLWithPath: destination, relativeTo: linkURL.deletingLastPathComponent())
                    .standardizedFileURL
                if destinationURL.path == URL(fileURLWithPath: Self.openclawSocketPath).standardizedFileURL.path {
                    return
                }
                try fileManager.removeItem(atPath: legacyPath)
            } else if fileManager.fileExists(atPath: legacyPath) {
                try fileManager.removeItem(atPath: legacyPath)
            }
            try fileManager.createSymbolicLink(atPath: legacyPath, withDestinationPath: Self.openclawSocketPath)
        } catch {
            let message = "Failed to create legacy PeekabooBridge socket symlink: \(error.localizedDescription)"
            self.logger
                .debug("\(message, privacy: .public)")
        }
    }

    private static func currentTeamID() -> String? {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess,
              let code
        else {
            return nil
        }

        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess,
              let staticCode
        else {
            return nil
        }

        var infoCF: CFDictionary?
        guard SecCodeCopySigningInformation(
            staticCode,
            SecCSFlags(rawValue: kSecCSSigningInformation),
            &infoCF) == errSecSuccess,
            let info = infoCF as? [String: Any]
        else {
            return nil
        }

        return info[kSecCodeInfoTeamIdentifier as String] as? String
    }
}

@MainActor
private final class OpenClawPeekabooBridgeServices: PeekabooBridgeServiceProviding {
    let permissions: PermissionsService
    let screenCapture: any ScreenCaptureServiceProtocol
    let automation: any UIAutomationServiceProtocol
    let windows: any WindowManagementServiceProtocol
    let applications: any ApplicationServiceProtocol
    let menu: any MenuServiceProtocol
    let dock: any DockServiceProtocol
    let dialogs: any DialogServiceProtocol
    let snapshots: any SnapshotManagerProtocol
    let desktopObservation: any DesktopObservationServiceProtocol

    init() {
        let logging = LoggingService(subsystem: "ai.openclaw.peekaboo")
        let feedbackClient: any AutomationFeedbackClient = NoopAutomationFeedbackClient()

        let snapshots = InMemorySnapshotManager(options: .init(
            snapshotValidityWindow: 600,
            maxSnapshots: 50,
            deleteArtifactsOnCleanup: false))
        let applications = ApplicationService(feedbackClient: feedbackClient)

        let screenCapture = ScreenCaptureService(loggingService: logging)
        let automation = UIAutomationService(
            snapshotManager: snapshots,
            loggingService: logging,
            searchPolicy: .balanced,
            feedbackClient: feedbackClient)
        let menu = MenuService(applicationService: applications, feedbackClient: feedbackClient)
        let screens = ScreenService()

        self.permissions = PermissionsService()
        self.snapshots = snapshots
        self.applications = applications
        self.screenCapture = screenCapture
        self.automation = automation
        self.windows = WindowManagementService(applicationService: applications, feedbackClient: feedbackClient)
        self.menu = menu
        self.dock = DockService(feedbackClient: feedbackClient)
        self.dialogs = DialogService(feedbackClient: feedbackClient)
        self.desktopObservation = DesktopObservationService(
            screenCapture: screenCapture,
            automation: automation,
            applications: applications,
            menu: menu,
            screens: screens,
            snapshotManager: snapshots)
    }
}
