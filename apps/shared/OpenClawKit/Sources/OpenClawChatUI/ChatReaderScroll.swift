import SwiftUI

enum ChatReaderUserTransition: Equatable {
    case unchanged
    case added(UUID)
    case removed(latestRemainingID: UUID?)
}

enum ChatReaderInitialRestorePolicy: Equatable {
    case liveEdge
    case latestTurn
}

func chatReaderInitialRestorePolicy() -> ChatReaderInitialRestorePolicy {
    #if os(iOS)
    .liveEdge
    #else
    .latestTurn
    #endif
}

func chatReaderUserTransition(
    previousID: UUID?,
    visibleIDs: [UUID]) -> ChatReaderUserTransition
{
    let latestID = visibleIDs.last
    if let previousID, !visibleIDs.contains(previousID) {
        return .removed(latestRemainingID: latestID)
    }
    if let latestID, latestID != previousID {
        return .added(latestID)
    }
    return .unchanged
}

func chatReaderHasNewerContent(
    after messageID: UUID,
    visibleIDs: [UUID],
    hasTransientContent: Bool) -> Bool
{
    guard let messageIndex = visibleIDs.firstIndex(of: messageID) else { return false }
    return messageIndex < visibleIDs.index(before: visibleIDs.endIndex) || hasTransientContent
}

/// `hasNewerContentBelow` is derived structurally (a later message or streaming text exists),
/// which is true from the first Writing tick of a turn even when the whole transcript is on
/// screen. Gating on the live-edge geometry keeps the jump affordance hidden until content is
/// actually below the viewport; without it the button flashes during every reply (#108693).
func chatReaderShowsJumpToLatest(
    hasNewerContentBelow: Bool,
    isAtLiveEdge: Bool,
    hasVisibleContent: Bool,
    isLoading: Bool) -> Bool
{
    hasNewerContentBelow && !isAtLiveEdge && hasVisibleContent && !isLoading
}

/// The view's own one-shot positioning always runs in a nil-animation transaction, so
/// `.animating` only comes from system scrolls (status-bar scroll-to-top, keyboard
/// avoidance). Not releasing there lets the next timeline tick yank the reader back down.
func chatReaderScrollReleasesFollow(_ phase: ScrollPhase) -> Bool {
    switch phase {
    case .interacting, .animating:
        true
    case .idle, .tracking, .decelerating:
        false
    @unknown default:
        false
    }
}
