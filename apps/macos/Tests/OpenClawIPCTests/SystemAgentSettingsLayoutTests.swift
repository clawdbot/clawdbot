import AppKit
import SwiftUI
import XCTest
@testable import OpenClaw

@MainActor
final class SystemAgentSettingsLayoutTests: XCTestCase {
    private static var retainedWindows: [NSWindow] = []

    func testPaneOwnsScrollableDetailContainer() async throws {
        let hosting = NSHostingView(rootView: SystemAgentSettings(
            isActive: false,
            onReplyReceived: {}))
        hosting.frame = NSRect(x: 0, y: 0, width: 800, height: 260)
        let window = Self.retainWindow(hosting)

        try await Self.waitForLayout(hosting, stage: "system agent detail scroll") {
            Self.detailScrollView(in: hosting) != nil
        }
        let scroll = try XCTUnwrap(Self.detailScrollView(in: hosting))
        let maximumOffset = scroll.documentView.map {
            max(0, $0.bounds.height - scroll.contentView.bounds.height)
        } ?? 0
        XCTAssertGreaterThan(maximumOffset, 0)

        window.orderOut(nil)
    }

    func testChatUsesAvailableDetailHeight() async throws {
        let hosting = NSHostingView(rootView: SystemAgentSettings(
            isActive: false,
            onReplyReceived: {}))
        hosting.frame = NSRect(x: 0, y: 0, width: 800, height: 700)
        let window = Self.retainWindow(hosting)

        try await Self.waitForLayout(hosting, stage: "system agent chat fills detail height") {
            Self.chatScrollView(in: hosting)?.frame.height ?? 0 > hosting.frame.height / 2
        }

        window.orderOut(nil)
    }

    private static func retainWindow(_ hosting: NSView) -> NSWindow {
        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        self.retainedWindows.append(window)
        return window
    }

    private static func detailScrollView(in view: NSView) -> NSScrollView? {
        self.descendants(of: NSScrollView.self, in: view).first { scrollView in
            guard let documentView = scrollView.documentView else { return false }
            let containsChatScroll = !self.descendants(of: NSScrollView.self, in: documentView).isEmpty
            return containsChatScroll && documentView.bounds.height > scrollView.contentView.bounds.height + 1
        }
    }

    private static func chatScrollView(in view: NSView) -> NSScrollView? {
        self.descendants(of: NSScrollView.self, in: view).first { scrollView in
            scrollView.frame.width > 500 && self.descendants(of: NSScrollView.self, in: scrollView).count == 1
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
