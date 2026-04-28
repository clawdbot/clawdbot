import Foundation
import Network

public enum GatewayDiscoveryStatusText {
    public static func make(states: [NWBrowser.State], hasBrowsers: Bool) -> String {
        if states.isEmpty {
            return hasBrowsers ? "Setup" : "Idle"
        }

        if let failed = states.first(where: { state in
            if case .failed = state { return true }
            return false
        }) {
            if case let .failed(err) = failed {
                return "Failed: \(err)"
            }
        }

        if let waiting = states.first(where: { state in
            if case .waiting = state { return true }
            return false
        }) {
            if case let .waiting(err) = waiting {
                return "Waiting: \(err)"
            }
        }

        if states.contains(where: { if case .ready = $0 { true } else { false } }) {
            return "Searching…"
        }

        if states.contains(where: { if case .setup = $0 { true } else { false } }) {
            return "Setup"
        }

        return "Searching…"
    }
}
