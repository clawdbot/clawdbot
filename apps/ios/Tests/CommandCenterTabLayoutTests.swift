import SwiftUI
import Testing
@testable import OpenClaw

@MainActor
@Suite struct CommandCenterTabLayoutTests {
    @Test func splitLayoutDisabledForCompactWidth() {
        #expect(
            !CommandCenterTab.usesSplitSectionsLayout(
                horizontalSizeClass: .compact,
                containerWidth: 1_200))
    }

    @Test func splitLayoutDisabledBelowWidthThreshold() {
        #expect(
            !CommandCenterTab.usesSplitSectionsLayout(
                horizontalSizeClass: .regular,
                containerWidth: 900))
    }

    @Test func splitLayoutEnabledForRegularWideLayout() {
        #expect(
            CommandCenterTab.usesSplitSectionsLayout(
                horizontalSizeClass: .regular,
                containerWidth: 1_024))
    }
}
