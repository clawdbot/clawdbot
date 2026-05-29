enum TalkGatewayPermissionState: Equatable {
    case unknown
    case ready
    case missingScope(String)
    case requestingUpgrade
    case upgradeRequested(requestId: String?)
    case requestFailed(String)
    case apiKeyMissing
    case loadFailed(String)

    var statusLabel: String {
        switch self {
        case .unknown:
            "Not checked"
        case .ready:
            "Ready"
        case let .missingScope(scope):
            "Missing \(scope)"
        case .requestingUpgrade:
            "Requesting approval"
        case .upgradeRequested:
            "Approval requested"
        case .requestFailed:
            "Request failed"
        case .apiKeyMissing:
            "API key missing"
        case .loadFailed:
            "Load failed"
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

    var failureMessage: String? {
        if case let .requestFailed(message) = self {
            return message
        }
        return nil
    }

    var requestId: String? {
        if case let .upgradeRequested(requestId) = self {
            return requestId
        }
        return nil
    }
}
