import OpenClawKit
import UIKit

enum GatewayProblemPrimaryAction {
    static func title(
        for problem: GatewayConnectionProblem,
        retryTitle: String,
        resetTitle: String? = nil,
        nonRetryableTitle: String? = nil) -> String?
    {
        if problem.suggestsOnboardingReset, let resetTitle {
            return String(localized: String.LocalizationValue(resetTitle))
        }
        if problem.canTrustRotatedCertificate {
            return String(localized: "Trust certificate")
        }
        if problem.kind == .protocolMismatch {
            return problem.localizedActionLabel
        }
        if problem.retryable {
            return problem.localizedActionLabel
                ?? String(localized: String.LocalizationValue(retryTitle))
        }
        return nonRetryableTitle.map { String(localized: String.LocalizationValue($0)) }
    }

    @MainActor
    static func handleProtocolMismatchIfNeeded(_ problem: GatewayConnectionProblem) -> Bool {
        guard problem.kind == .protocolMismatch else { return false }
        if let command = problem.actionCommand {
            UIPasteboard.general.string = command
            return true
        }
        if let url = problem.docsURL {
            UIApplication.shared.open(url)
        }
        return true
    }
}
