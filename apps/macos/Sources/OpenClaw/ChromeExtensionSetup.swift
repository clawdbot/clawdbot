import Foundation

enum ChromeExtensionSetup {
    struct Result: Encodable, Equatable {
        let nativeHostRegistered: Bool
        let installRequested: Bool
        let discoveredProfiles: Int
    }

    private struct Report: Decodable {
        struct Registration: Decodable {
            let product: String
            let state: String
            let issue: String?
        }

        struct InstallRequest: Decodable { let state: String }
        struct Discovery: Decodable { let product: String }
        struct StoreDiscovery: Decodable {
            let product: String
            let enabled: Bool
        }

        let registrations: [Registration]
        let storeInstallRequests: [InstallRequest]
        let storeDiscovered: [StoreDiscovery]
        let discovered: [Discovery]
    }

    enum SetupError: LocalizedError {
        case missingCLI, unavailable, retired

        var errorDescription: String? {
            switch self {
            case .missingCLI: "Install the OpenClaw CLI on this Mac, then try setup again."
            case .unavailable:
                "Chrome setup could not finish. Run openclaw browser extension install on this Mac for details."
            case .retired: "The device settings document is no longer available."
            }
        }
    }

    static func readResult(_ stdout: String) throws -> Result {
        let report = try JSONDecoder().decode(Report.self, from: Data(stdout.utf8))
        return Result(
            nativeHostRegistered: report.registrations.contains {
                $0.product == "chrome" && $0.state == "owned" && $0.issue == nil
            },
            installRequested: report.storeInstallRequests.contains { $0.state == "requested" },
            discoveredProfiles: report.storeDiscovered.filter { $0.product == "chrome" && $0.enabled }.count +
                report.discovered.filter { $0.product == "chrome" }.count)
    }

    @MainActor
    static func install(isCurrent: () -> Bool) async throws -> Result {
        // The ordinary command resolver follows SSH Gateway settings. This action always owns this Mac.
        let executable: String? = if case let .ready(location, _) = await CLIInstaller.status() {
            location
        } else {
            CommandResolver.findExecutable(named: "openclaw", searchPaths: CommandResolver.preferredPaths())
        }
        guard isCurrent(), !Task.isCancelled else { throw SetupError.retired }
        guard let executable else { throw SetupError.missingCLI }
        let command = AppProfile.current.localCLICommand(
            prefix: [executable], arguments: ["browser", "extension", "install", "--json", "--wait-ms", "1000"])
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        let output = await ShellExecutor.runDetailed(command: command, cwd: nil, env: environment, timeout: 30)
        guard isCurrent(), !Task.isCancelled else { throw SetupError.retired }
        // A bounded wait expires with exit 1 while Chrome approval is pending; valid JSON retains that outcome.
        guard !output.timedOut, let result = try? self.readResult(output.stdout) else { throw SetupError.unavailable }
        return result
    }
}
