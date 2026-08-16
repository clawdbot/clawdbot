import Foundation
import SwiftUI
import Testing
@testable import OpenClawChatUI

struct ChatReaderScrollStateTests {
    @Test func `optimistic turn removal keeps the older user as the baseline`() {
        let olderUserID = UUID()
        let optimisticUserID = UUID()

        let transition = chatReaderUserTransition(
            previousID: optimisticUserID,
            visibleIDs: [olderUserID])

        #expect(transition == .removed(latestRemainingID: olderUserID))
    }

    @Test func `only user removal clears the user baseline`() {
        let optimisticUserID = UUID()

        let transition = chatReaderUserTransition(
            previousID: optimisticUserID,
            visibleIDs: [])

        #expect(transition == .removed(latestRemainingID: nil))
    }

    @Test func `new user after the existing baseline starts a turn`() {
        let previousUserID = UUID()
        let newUserID = UUID()

        let transition = chatReaderUserTransition(
            previousID: previousUserID,
            visibleIDs: [previousUserID, newUserID])

        #expect(transition == .added(newUserID))
    }

    @Test func `removed transient content does not offer a latest jump`() {
        let userID = UUID()

        let hasNewerContent = chatReaderHasNewerContent(
            after: userID,
            visibleIDs: [userID],
            hasTransientContent: false)

        #expect(!hasNewerContent)
    }

    @Test func `assistant or transient content after the user offers a latest jump`() {
        let userID = UUID()
        let assistantID = UUID()

        #expect(chatReaderHasNewerContent(
            after: userID,
            visibleIDs: [userID, assistantID],
            hasTransientContent: false))
        #expect(chatReaderHasNewerContent(
            after: userID,
            visibleIDs: [userID],
            hasTransientContent: true))
    }

    @Test func `drags and system animated scrolls release the follow target`() {
        #expect(chatReaderScrollReleasesFollow(.interacting))
        #expect(chatReaderScrollReleasesFollow(.animating))
    }

    @Test func `idle, touch-down, and deceleration phases keep the follow target`() {
        #expect(!chatReaderScrollReleasesFollow(.idle))
        #expect(!chatReaderScrollReleasesFollow(.tracking))
        #expect(!chatReaderScrollReleasesFollow(.decelerating))
    }

    @Test func `streaming at the live edge never offers a latest jump`() {
        // #108693: the first Writing tick of a turn makes structural "newer content" true
        // while the reader is still at the bottom; the geometry gate must win.
        #expect(!chatReaderShowsJumpToLatest(
            hasNewerContentBelow: true,
            isAtLiveEdge: true,
            hasVisibleContent: true,
            isLoading: false))
    }

    @Test func `newer content below the viewport offers a latest jump`() {
        #expect(chatReaderShowsJumpToLatest(
            hasNewerContentBelow: true,
            isAtLiveEdge: false,
            hasVisibleContent: true,
            isLoading: false))
    }

    @Test func `loading and empty transcripts suppress the latest jump`() {
        #expect(!chatReaderShowsJumpToLatest(
            hasNewerContentBelow: true,
            isAtLiveEdge: false,
            hasVisibleContent: true,
            isLoading: true))
        #expect(!chatReaderShowsJumpToLatest(
            hasNewerContentBelow: true,
            isAtLiveEdge: false,
            hasVisibleContent: false,
            isLoading: false))
    }
}
