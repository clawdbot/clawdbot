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
        let (hosting, window) = Self.makeWindow(state: state)
        defer { window.orderOut(nil) }

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
    }

    func testPanesFitAfterShrinkingAndEnlargingWindow() async throws {
        let state = AppState(preview: true)
        state.connectionMode = .remote
        state.remoteTransport = .direct
        state.remoteUrl = "wss://gateway.example.test"
        state.remoteTarget = "user@gateway.example.test"
        let (hosting, window) = Self.makeWindow(state: state)
        defer { window.orderOut(nil) }

        try await Self.waitForLayout(hosting, stage: "initial permissions layout") {
            Self.detailScrollView(in: hosting) != nil
        }
        for (size, transport) in [
            (NSSize(width: 1000, height: 620), AppState.RemoteTransport.direct),
            (NSSize(width: 1120, height: 790), .direct),
            (NSSize(width: 1000, height: 620), .ssh),
        ] {
            state.remoteTransport = transport
            window.setContentSize(size)
            try await Self.waitForLayout(hosting, stage: "resized detail at \(size)") {
                Self.detailScrollView(in: hosting) != nil
            }
            for tab in [SettingsTab.general, .connection, .permissions] {
                let previous = try XCTUnwrap(Self.detailScrollView(in: hosting))
                NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
                try await Self.waitForLayout(hosting, stage: "\(tab.title) at \(size)") {
                    previous.frame.isEmpty && Self.detailScrollView(in: hosting) != nil
                }
                let scroll = try XCTUnwrap(Self.detailScrollView(in: hosting))
                let frame = scroll.convert(scroll.bounds, to: hosting)
                XCTAssertEqual(hosting.bounds.width, size.width, accuracy: 1)
                XCTAssertEqual(hosting.bounds.height, size.height, accuracy: 1)
                XCTAssertTrue(
                    hosting.bounds.insetBy(dx: -1, dy: -1).contains(frame),
                    "\(tab.title) detail \(frame) exceeds available bounds \(hosting.bounds)")

                if tab == .connection {
                    let document = try XCTUnwrap(scroll.documentView)
                    let endpoint = transport == .direct ? state.remoteUrl : state.remoteTarget
                    let field = try XCTUnwrap(Self.descendants(of: NSTextField.self, in: document)
                        .first { $0.stringValue == endpoint })
                    let fieldFrame = field.convert(field.bounds, to: hosting)
                    XCTAssertGreaterThanOrEqual(fieldFrame.minX, frame.minX - 1)
                    XCTAssertLessThanOrEqual(fieldFrame.maxX, frame.maxX + 1)
                }
            }
        }
    }

    private static func makeWindow(state: AppState) -> (NSHostingView<SettingsRootView>, NSWindow) {
        let hosting = NSHostingView(rootView: SettingsRootView(
            state: state,
            updater: nil,
            initialTab: .permissions))
        hosting.frame = NSRect(
            x: 0, y: 0, width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled, .resizable],
            backing: .buffered,
            defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        Self.retainedWindows.append(window)
        return (hosting, window)
    }

    private static func detailScrollView(in view: NSView) -> NSScrollView? {
        self.descendants(of: NSScrollView.self, in: view).first { scrollView in
            scrollView.frame.width > 500 && !scrollView.frame.isEmpty
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
