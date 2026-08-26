import Foundation
import Observation

/// Recorded fact for the Mac node channel, written by MacNodeModeCoordinator at
/// the connect boundary. The menu bar reads this instead of inferring node
/// health from gateway node listings, so a node channel that never dials still
/// surfaces its reason to the operator.
enum MacNodeChannelState: Equatable, Sendable {
    /// Node mode is paused, stopped, or not configured to run.
    case idle
    /// The channel connected. A non-nil reason means the node-host worker is
    /// unavailable and only native capabilities are advertised.
    case connected(workerUnavailableReason: String?)
    /// The last connect attempt failed; the coordinator keeps retrying.
    case unavailable(reason: String)

    var operatorStatusLine: (label: String, isDegraded: Bool)? {
        switch self {
        case .idle, .connected(workerUnavailableReason: nil):
            nil
        case let .connected(workerUnavailableReason: .some(reason)):
            ("Mac node degraded — \(Self.condense(reason))", true)
        case let .unavailable(reason):
            ("Mac node unavailable — \(Self.condense(reason))", false)
        }
    }

    /// Menu status lines are single-line; keep the leading reason sentence and
    /// bound it so a CLI stack trace cannot flood the menu.
    private static func condense(_ reason: String) -> String {
        let firstLine = reason
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? reason
        return firstLine.count > 220 ? firstLine.prefix(220) + "…" : firstLine
    }
}

@MainActor
@Observable
final class MacNodeChannelStatusStore {
    static let shared = MacNodeChannelStatusStore()

    private(set) var state: MacNodeChannelState = .idle

    func record(_ state: MacNodeChannelState) {
        guard self.state != state else { return }
        self.state = state
    }
}
