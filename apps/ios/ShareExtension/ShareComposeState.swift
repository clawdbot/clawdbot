import Foundation

/// Lifecycle of the share compose card. Failure carries the already-localized
/// message so the footer can surface it verbatim.
enum ShareComposeStatus: Equatable {
    case preparing
    case ready
    case sending
    case sent
    case failed(String)
}

/// Derived control availability for a compose status. Kept UIKit-free so the
/// logic-test target can assert the state machine without instantiating views.
struct ShareComposeControlState: Equatable {
    var isSendEnabled: Bool
    var isCancelEnabled: Bool
    var isEditable: Bool

    static func resolve(status: ShareComposeStatus, hasDraftText: Bool) -> Self {
        switch status {
        case .preparing:
            // Editing stays locked until extraction lands; prepareDraft() replaces
            // the draft wholesale and must not discard text typed mid-preparation.
            Self(isSendEnabled: false, isCancelEnabled: true, isEditable: false)
        case .ready, .failed:
            Self(isSendEnabled: hasDraftText, isCancelEnabled: true, isEditable: true)
        case .sending, .sent:
            Self(isSendEnabled: false, isCancelEnabled: false, isEditable: false)
        }
    }
}
