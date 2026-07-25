import OpenClawKit
import SwiftUI

enum OnboardingStep: Int, CaseIterable {
    case intro
    case permissions
    case welcome
    case mode
    case connect
    case auth
    case success

    var previous: Self? {
        Self(rawValue: rawValue - 1)
    }

    /// Progress label for the manual setup flow (mode → connect → auth → success).
    var manualProgressTitle: String {
        let manualSteps: [OnboardingStep] = [.mode, .connect, .auth, .success]
        guard let idx = manualSteps.firstIndex(of: self) else { return "" }
        return "Step \(idx + 1) of \(manualSteps.count)"
    }

    var title: LocalizedStringKey {
        switch self {
        case .intro: "Welcome"
        case .permissions: "Permissions"
        case .welcome: "Connect Gateway"
        case .mode: "Gateway Setup"
        case .connect: "Gateway Details"
        case .auth: "Gateway Status"
        case .success: "Connected"
        }
    }

    var canGoBack: Bool {
        switch self {
        case .intro, .permissions, .welcome, .success:
            false
        case .mode, .connect, .auth:
            true
        }
    }
}

enum OnboardingConnectPhase: Equatable {
    case connecting(detail: String)
    case failed(GatewayConnectionProblem)
    case failedStatus(message: String, allowsRetry: Bool)
    case ready

    static func resolve(
        problem: GatewayConnectionProblem?,
        connectingDetail: String?,
        localFailure: String?,
        retryableFailure: String?) -> Self
    {
        // A retry may already be running; keep its previous error readable until success clears it.
        if let localFailure { return .failedStatus(message: localFailure, allowsRetry: false) }
        if let problem { return .failed(problem) }
        if let connectingDetail { return .connecting(detail: connectingDetail) }
        if let retryableFailure { return .failedStatus(message: retryableFailure, allowsRetry: true) }
        return .ready
    }
}

/// Typed connection attempt replaces string sentinels ("manual", "retry", ...) so
/// gateway attempts compare by byte-exact stable-ID key, never trimmed strings.
enum OnboardingGatewayConnectionAttempt: Equatable {
    case gateway(GatewayStableIdentifier.Key)
    case manual
    case retry
    case retryAutomatically
    case setupCode
    case trustCertificate
}

struct GatewaySetupLinkStaging {
    private(set) var link: GatewayConnectDeepLink?

    mutating func stage(_ link: GatewayConnectDeepLink) {
        self.link = link
    }

    mutating func take() -> GatewayConnectDeepLink? {
        defer { self.link = nil }
        return self.link
    }

    @discardableResult
    mutating func cancel() -> Bool {
        guard self.link != nil else { return false }
        self.link = nil
        return true
    }
}
