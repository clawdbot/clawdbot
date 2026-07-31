import AppKit
import Foundation
import Observation
import OpenClawDiscovery
import os

/// Manages Tailscale integration and status checking.
@Observable
@MainActor
final class TailscaleService {
    typealias InstallationProbe = @Sendable () -> Bool
    typealias StatusDataLoader = @Sendable (URL) async throws -> (Data, URLResponse)
    #if DEBUG
    typealias StatusCheckJoinHandler = @Sendable () async -> Void
    #endif

    static let shared = TailscaleService()

    /// Tailscale local API endpoint.
    private static let tailscaleAPIEndpoint = "http://100.100.100.100/api/data"

    /// API request timeout in seconds.
    private nonisolated static let apiTimeoutInterval: TimeInterval = 5.0

    private let logger = Logger(subsystem: "ai.openclaw", category: "tailscale")

    /// Indicates if a Tailscale installation or active daemon was detected.
    private(set) var isInstalled = false

    /// Indicates if the GUI app is available for app-specific actions.
    private(set) var isAppInstalled = false

    /// Indicates if Tailscale is currently running.
    private(set) var isRunning = false

    /// The Tailscale hostname for this device (e.g., "my-mac.tailnet.ts.net").
    private(set) var tailscaleHostname: String?

    /// The Tailscale IPv4 address for this device.
    private(set) var tailscaleIP: String?

    /// Error message if status check fails.
    private(set) var statusError: String?

    @ObservationIgnored private let appInstallationProbe: InstallationProbe
    @ObservationIgnored private let cliInstallationProbe: InstallationProbe
    @ObservationIgnored private let statusDataLoader: StatusDataLoader
    @ObservationIgnored private var statusCheckTask: Task<Void, Never>?
    #if DEBUG
    @ObservationIgnored private let statusCheckJoinHandler: StatusCheckJoinHandler?
    #endif

    private init() {
        self.appInstallationProbe = Self.detectAppInstallation
        self.cliInstallationProbe = Self.detectCLIInstallation
        self.statusDataLoader = Self.makeStatusDataLoader()
        #if DEBUG
        self.statusCheckJoinHandler = nil
        #endif
        Task { await self.checkTailscaleStatus() }
    }

    #if DEBUG
    init(
        isInstalled: Bool,
        isAppInstalled: Bool = false,
        isRunning: Bool,
        tailscaleHostname: String? = nil,
        tailscaleIP: String? = nil,
        statusError: String? = nil,
        appInstallationProbe: @escaping InstallationProbe = TailscaleService.detectAppInstallation,
        cliInstallationProbe: @escaping InstallationProbe = TailscaleService.detectCLIInstallation,
        statusDataLoader: @escaping StatusDataLoader = TailscaleService.makeStatusDataLoader(),
        statusCheckJoinHandler: StatusCheckJoinHandler? = nil)
    {
        self.isInstalled = isInstalled
        self.isAppInstalled = isAppInstalled
        self.isRunning = isRunning
        self.tailscaleHostname = tailscaleHostname
        self.tailscaleIP = tailscaleIP
        self.statusError = statusError
        self.appInstallationProbe = appInstallationProbe
        self.cliInstallationProbe = cliInstallationProbe
        self.statusDataLoader = statusDataLoader
        self.statusCheckJoinHandler = statusCheckJoinHandler
    }
    #endif

    func checkAppInstallation() -> Bool {
        let installed = self.appInstallationProbe()
        self.logger.info("Tailscale app installed: \(installed)")
        return installed
    }

    func checkCLIInstallation() -> Bool {
        let installed = self.cliInstallationProbe()
        self.logger.info("Tailscale CLI installed: \(installed)")
        return installed
    }

    nonisolated static func hasExecutableCLI(at candidates: [String]) -> Bool {
        candidates.contains { FileManager.default.isExecutableFile(atPath: $0) }
    }

    struct TailscaleAPIResponse: Codable {
        let status: String
        let deviceName: String
        let tailnetName: String
        let iPv4: String?

        private enum CodingKeys: String, CodingKey {
            case status = "Status"
            case deviceName = "DeviceName"
            case tailnetName = "TailnetName"
            case iPv4 = "IPv4"
        }
    }

    private func fetchTailscaleStatus() async -> TailscaleAPIResponse? {
        guard let url = URL(string: Self.tailscaleAPIEndpoint) else {
            self.logger.error("Invalid Tailscale API URL")
            return nil
        }

        do {
            let (data, response) = try await self.statusDataLoader(url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200
            else {
                self.logger.warning("Tailscale API returned non-200 status")
                return nil
            }

            let decoder = JSONDecoder()
            return try decoder.decode(TailscaleAPIResponse.self, from: data)
        } catch {
            self.logger.debug("Failed to fetch Tailscale status: \(String(describing: error))")
            return nil
        }
    }

    func checkTailscaleStatus() async {
        // Every caller that awaits a refresh must observe the same completed
        // status update; returning early here would expose stale state.
        if let statusCheckTask = self.statusCheckTask {
            #if DEBUG
            if let statusCheckJoinHandler = self.statusCheckJoinHandler {
                await statusCheckJoinHandler()
            }
            #endif
            await statusCheckTask.value
            return
        }

        let statusCheckTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performTailscaleStatusCheck()
        }
        self.statusCheckTask = statusCheckTask
        await statusCheckTask.value
        self.statusCheckTask = nil
    }

    private func performTailscaleStatusCheck() async {
        let previousIP = self.tailscaleIP
        let appInstalled = self.checkAppInstallation()
        let cliInstalled = self.checkCLIInstallation()
        let apiResponse = await self.fetchTailscaleStatus()
        self.applyStatusEvidence(
            appInstalled: appInstalled,
            cliInstalled: cliInstalled,
            apiResponse: apiResponse,
            fallbackIP: TailscaleNetwork.detectTailnetIPv4())

        if previousIP != self.tailscaleIP {
            await GatewayEndpointStore.shared.refresh()
        }
    }

    func applyStatusEvidence(
        appInstalled: Bool,
        cliInstalled: Bool,
        apiResponse: TailscaleAPIResponse?,
        fallbackIP: String?)
    {
        self.isAppInstalled = appInstalled
        self.isInstalled = appInstalled || cliInstalled || apiResponse != nil
        // RFC 6598 space is not Tailscale-exclusive. Only trust an interface
        // fallback after the app, CLI, or local API proves this installation.
        let trustedFallbackIP = self.isInstalled ? fallbackIP : nil

        if let apiResponse {
            self.isRunning = apiResponse.status.lowercased() == "running"

            if self.isRunning {
                let deviceName = apiResponse.deviceName
                    .lowercased()
                    .replacingOccurrences(of: " ", with: "-")
                let tailnetName = apiResponse.tailnetName
                    .replacingOccurrences(of: ".ts.net", with: "")
                    .replacingOccurrences(of: ".tailscale.net", with: "")

                self.tailscaleHostname = "\(deviceName).\(tailnetName).ts.net"
                self.tailscaleIP = apiResponse.iPv4 ?? trustedFallbackIP
                self.statusError = nil

                self.logger.info(
                    "Tailscale running host=\(self.tailscaleHostname ?? "nil") ip=\(self.tailscaleIP ?? "nil")")
            } else {
                self.tailscaleHostname = nil
                self.tailscaleIP = nil
                self.statusError = "Tailscale is not running"
            }
        } else if let trustedFallbackIP {
            self.isRunning = true
            self.tailscaleHostname = nil
            self.tailscaleIP = trustedFallbackIP
            self.statusError = nil
            self.logger.info("Tailscale interface IP detected (fallback) ip=\(trustedFallbackIP, privacy: .public)")
        } else {
            self.isRunning = false
            self.tailscaleHostname = nil
            self.tailscaleIP = nil
            self.statusError = if appInstalled {
                "Please start the Tailscale app"
            } else if cliInstalled {
                "Please start the Tailscale daemon"
            } else {
                "Tailscale is not installed"
            }
            if appInstalled {
                self.logger.info("Tailscale API not responding; app likely not running")
            } else if cliInstalled {
                self.logger.info("Tailscale API not responding; CLI daemon likely not running")
            }
        }
    }

    func openTailscaleApp() {
        if let url = URL(string: "file:///Applications/Tailscale.app") {
            NSWorkspace.shared.open(url)
        }
    }

    func openAppStore() {
        if let url = URL(string: "https://apps.apple.com/us/app/tailscale/id1475387142") {
            NSWorkspace.shared.open(url)
        }
    }

    func openDownloadPage() {
        if let url = URL(string: "https://tailscale.com/download/macos") {
            NSWorkspace.shared.open(url)
        }
    }

    func openSetupGuide() {
        if let url = URL(string: "https://tailscale.com/kb/1017/install/") {
            NSWorkspace.shared.open(url)
        }
    }

    nonisolated static func fallbackTailnetIPv4() -> String? {
        TailscaleNetwork.detectTailnetIPv4()
    }

    private nonisolated static func detectAppInstallation() -> Bool {
        FileManager().fileExists(atPath: "/Applications/Tailscale.app")
    }

    private nonisolated static func detectCLIInstallation() -> Bool {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "/usr/local/bin/tailscale",
            "/usr/local/bin/tailscaled",
            "/opt/homebrew/bin/tailscale",
            "/opt/homebrew/bin/tailscaled",
            "\(home)/go/bin/tailscale",
            "\(home)/go/bin/tailscaled",
        ]
        return Self.hasExecutableCLI(at: candidates)
    }

    private nonisolated static func makeStatusDataLoader() -> StatusDataLoader {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = Self.apiTimeoutInterval
        let session = URLSession(configuration: configuration)
        return { url in
            try await session.data(from: url)
        }
    }
}
