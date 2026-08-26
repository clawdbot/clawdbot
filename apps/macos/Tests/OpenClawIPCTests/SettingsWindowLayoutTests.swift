import AppKit
import SwiftUI
import XCTest
@testable import OpenClaw

@MainActor
final class SettingsWindowLayoutTests: XCTestCase {
    private static var retainedWindows: [NSWindow] = []

    func testInactivePanesCollapseAndRetainScrollPosition() async throws {
        let state = AppState(preview: true)
        state.nativeSettingsPanesEnabled = true
        let hosting = NSHostingView(rootView: SettingsRootView(
            state: state,
            updater: nil,
            initialTab: .permissions))
        hosting.frame = NSRect(
            x: 0,
            y: 0,
            width: SettingsTab.windowWidth,
            height: SettingsTab.windowHeight)
        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        Self.retainedWindows.append(window)

        try await Self.waitForLayout(hosting, stage: "initial permissions scroll") {
            Self.detailScrollView(in: hosting) != nil
        }
        let permissionsScroll = try XCTUnwrap(Self.detailScrollView(in: hosting))
        let maximumOffset = permissionsScroll.documentView.map {
            max(0, $0.bounds.height - permissionsScroll.contentView.bounds.height)
        } ?? 0
        XCTAssertGreaterThan(maximumOffset, 200)

        permissionsScroll.contentView.scroll(to: NSPoint(x: 0, y: min(320, maximumOffset)))
        permissionsScroll.reflectScrolledClipView(permissionsScroll.contentView)
        let savedOffset = permissionsScroll.contentView.bounds.origin.y
        XCTAssertGreaterThan(savedOffset, 0)

        NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: SettingsTab.general)
        try await Self.waitForLayout(hosting, stage: "inactive permissions collapse") {
            permissionsScroll.frame.isEmpty && Self.detailScrollView(in: hosting) !== permissionsScroll
        }

        NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: SettingsTab.permissions)
        try await Self.waitForLayout(hosting, stage: "permissions scroll restoration") {
            Self.detailScrollView(in: hosting) === permissionsScroll
        }
        XCTAssertLessThan(abs(permissionsScroll.contentView.bounds.origin.y - savedOffset), 1)

        state.nativeSettingsPanesEnabled = false
        NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: SettingsTab.channels)
        try await Self.waitForLayout(hosting, stage: "permissions collapse after settings mode change") {
            permissionsScroll.frame.isEmpty
        }

        window.orderOut(nil)
    }

    private static func detailScrollView(in view: NSView) -> NSScrollView? {
        self.descendants(of: NSScrollView.self, in: view).first { scrollView in
            guard scrollView.frame.width > 500, let documentView = scrollView.documentView else { return false }
            return documentView.bounds.height > scrollView.contentView.bounds.height + 1
        }
    }

    private static func descendants<T: NSView>(of type: T.Type, in view: NSView) -> [T] {
        var matches: [T] = []
        if let match = view as? T { matches.append(match) }
        for child in view.subviews {
            matches.append(contentsOf: self.descendants(of: type, in: child))
        }
        return matches
    }

    private static func waitForLayout(
        _ hosting: NSView,
        stage: String,
        timeout: Duration = .seconds(3),
        until condition: @MainActor () -> Bool) async throws
    {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            hosting.layoutSubtreeIfNeeded()
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw SettingsLayoutTimeout(stage: stage)
    }

    private struct SettingsLayoutTimeout: Error, CustomStringConvertible {
        let stage: String
        var description: String {
            "Settings layout timed out during \(self.stage)"
        }
    }
}
