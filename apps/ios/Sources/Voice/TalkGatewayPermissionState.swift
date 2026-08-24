import Foundation

enum TalkGatewayPermissionState: Equatable {
    case unknown
    case ready
    case missingScope(String)
    case requestingUpgrade
    case upgradeRequested
    case requestFailed(String)
    case apiKeyMissing
    case loadFailed(String)

    var statusLabel: String {
        switch self {
        case .unknown:
            String(localized: "Not checked")
        case .ready:
            String(localized: "Ready")
        case let .missingScope(scope):
            String(format: String(localized: "Missing %@"), scope)
        case .requestingUpgrade:
            String(localized: "Requesting approval")
        case .upgradeRequested:
            String(localized: "Approval requested")
        case .requestFailed:
            String(localized: "Request failed")
        case .apiKeyMissing:
            String(localized: "API key missing")
        case .loadFailed:
            String(localized: "Load failed")
        }
    }

    var requiresTalkPermissionAction: Bool {
        switch self {
        case .missingScope, .requestingUpgrade, .upgradeRequested, .requestFailed:
            true
        default:
            false
        }
    }

    var isApprovalRequestInProgress: Bool {
        switch self {
        case .requestingUpgrade, .upgradeRequested:
            true
        default:
            false
        }
    }
}
