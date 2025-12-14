import Foundation
import Network
import Observation

// We use “master” as the on-the-wire service name; keep the model aligned with the protocol/docs.
@MainActor
@Observable
// swiftlint:disable:next inclusive_language
final class MasterDiscoveryModel {
    // swiftlint:disable:next inclusive_language
    struct DiscoveredMaster: Identifiable, Equatable {
        var id: String { self.debugID }
        var displayName: String
        var lanHost: String?
        var tailnetDns: String?
        var sshPort: Int
        var debugID: String
    }

    // swiftlint:disable:next inclusive_language
    var masters: [DiscoveredMaster] = []
    var statusText: String = "Idle"

    private var browser: NWBrowser?

    private static let serviceType = "_clawdis-master._tcp"
    private static let serviceDomain = "local."

    func start() {
        if self.browser != nil { return }

        let params = NWParameters.tcp
        params.includePeerToPeer = true

        let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: Self.serviceDomain), using: params)

        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .setup:
                    self.statusText = "Setup"
                case .ready:
                    self.statusText = "Searching…"
                case let .failed(err):
                    self.statusText = "Failed: \(err)"
                case .cancelled:
                    self.statusText = "Stopped"
                case let .waiting(err):
                    self.statusText = "Waiting: \(err)"
                @unknown default:
                    self.statusText = "Unknown"
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self else { return }
                self.masters = results.compactMap { result -> DiscoveredMaster? in
                    guard case let .service(name, _, _, _) = result.endpoint else { return nil }

                    var lanHost: String?
                    var tailnetDns: String?
                    var sshPort = 22
                    if case let .bonjour(txt) = result.metadata {
                        let dict = txt.dictionary
                        if let value = dict["lanHost"] {
                            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                            lanHost = trimmed.isEmpty ? nil : trimmed
                        }
                        if let value = dict["tailnetDns"] {
                            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                            tailnetDns = trimmed.isEmpty ? nil : trimmed
                        }
                        if let value = dict["sshPort"],
                           let parsed = Int(value.trimmingCharacters(in: .whitespacesAndNewlines)),
                           parsed > 0
                        {
                            sshPort = parsed
                        }
                    }

                    return DiscoveredMaster(
                        displayName: name,
                        lanHost: lanHost,
                        tailnetDns: tailnetDns,
                        sshPort: sshPort,
                        debugID: Self.prettyEndpointDebugID(result.endpoint))
                }
                .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            }
        }

        self.browser = browser
        browser.start(queue: DispatchQueue(label: "com.steipete.clawdis.macos.master-discovery"))
    }

    func stop() {
        self.browser?.cancel()
        self.browser = nil
        self.masters = []
        self.statusText = "Stopped"
    }

    private static func prettyEndpointDebugID(_ endpoint: NWEndpoint) -> String {
        String(describing: endpoint)
    }
}
