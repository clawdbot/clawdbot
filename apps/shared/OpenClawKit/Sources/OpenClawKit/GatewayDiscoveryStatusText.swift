import Foundation
import Network

public enum GatewayDiscoveryStatusText {
    public static var idle: String {
        String(localized: "Idle")
    }

    public static var stopped: String {
        String(localized: "Stopped")
    }

    public static func make(states: [NWBrowser.State], hasBrowsers: Bool) -> String {
        if states.isEmpty {
            return hasBrowsers ? String(localized: "Setup") : self.idle
        }

        if let failed = states.first(where: { state in
            if case .failed = state { return true }
            return false
        }) {
            if case let .failed(err) = failed {
                return "\(String(localized: "Failed")): \(err)"
            }
        }

        if let waiting = states.first(where: { state in
            if case .waiting = state { return true }
            return false
        }) {
            if case let .waiting(err) = waiting {
                return "\(String(localized: "Waiting")): \(err)"
            }
        }

        if states.contains(where: {
            if case .ready = $0 {
                true
            } else {
                false
            }
        }) {
            return String(localized: "Searching…")
        }

        if states.contains(where: {
            if case .setup = $0 {
                true
            } else {
                false
            }
        }) {
            return String(localized: "Setup")
        }

        return String(localized: "Searching…")
    }
}
