import Foundation

/// Bridges task cancellation into the request continuation without racing send.
final class GatewayRequestCancellationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    var isCancelled: Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.cancelled
    }

    func cancel() {
        self.lock.lock()
        self.cancelled = true
        self.lock.unlock()
    }
}

extension GatewayChannelActor {
    enum ConnectChallengeError: Error {
        case timeout
    }

    static let defaultOperatorConnectScopes: [String] = [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
    ]

    struct SelectedConnectAuth {
        let authToken: String?
        let authBootstrapToken: String?
        let authDeviceToken: String?
        let authPassword: String?
        let signatureToken: String?
        let storedToken: String?
        let storedScopes: [String]?
        let authSource: GatewayAuthSource
        let suppressedDeviceTokenRetry: Bool
    }
}
