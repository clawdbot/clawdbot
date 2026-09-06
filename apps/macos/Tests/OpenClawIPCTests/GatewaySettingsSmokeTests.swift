import AppKit
import ApplicationServices
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewaySettingsSmokeTests {
    @Test func `first Reconnect prefills the Gateway and Add starts a fresh empty editor`() async throws {
        try await TestIsolation.withIsolatedState {
            let profile = try MacGatewayProfile(
                id: "editor-fixture",
                name: "Project Gateway",
                url: #require(URL(string: "wss://gateway.example.test:8443/control/")))
            try await withHostedSettings(GatewaySettings(profiles: [profile])) { hosting, window in
                for (action, reconnecting) in [("Reconnect", true), ("Add Gateway", false)] {
                    let buttons = try await settingsAccessibilityElements(hosting)
                    let button = try #require(buttons.first {
                        $0.accessibilityRole?() == .button &&
                            [$0.accessibilityLabel?(), $0.accessibilityTitle?()].contains(action)
                    })
                    #expect(button.accessibilityPerformPress?() == true)
                    let deadline = ContinuousClock.now + .seconds(3)
                    while window.attachedSheet == nil, ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(20))
                    }
                    let sheet = try #require(window.attachedSheet?.contentView)
                    var values: [String] = []
                    var connectEnabled: Bool?
                    repeat {
                        sheet.layoutSubtreeIfNeeded()
                        let elements = try await settingsAccessibilityElements(sheet)
                        values = elements.filter { $0.accessibilityRole?() == .textField }.map {
                            let value: Any? = $0.accessibilityValue?()
                            return value as? String ?? ""
                        }
                        connectEnabled = elements.first {
                            $0.accessibilityRole?() == .button &&
                                [$0.accessibilityLabel?(), $0.accessibilityTitle?()].contains("Connect")
                        }?.isAccessibilityEnabled?()
                        let populated = values.contains(profile.name) && values.contains(profile.url.absoluteString)
                        if values.count >= 2, connectEnabled == reconnecting,
                           reconnecting ? populated : values.allSatisfy(\.isEmpty) { break }
                        try await Task.sleep(for: .milliseconds(20))
                    } while ContinuousClock.now < deadline
                    #expect(values.count >= 2)
                    #expect(connectEnabled == reconnecting)
                    if reconnecting {
                        #expect(values.contains(profile.name))
                        #expect(values.contains(profile.url.absoluteString))
                    } else {
                        let hasOnlyEmptyFields = values.allSatisfy(\.isEmpty)
                        #expect(hasOnlyEmptyFields)
                    }
                    let cancel = try #require(try await settingsAccessibilityElements(sheet).first {
                        $0.accessibilityRole?() == .button &&
                            [$0.accessibilityLabel?(), $0.accessibilityTitle?()].contains("Cancel")
                    })
                    #expect(cancel.accessibilityPerformPress?() == true)
                    let dismissedDeadline = ContinuousClock.now + .seconds(3)
                    while window.attachedSheet != nil, ContinuousClock.now < dismissedDeadline {
                        try await Task.sleep(for: .milliseconds(20))
                    }
                    try #require(window.attachedSheet == nil)
                }
            }
        }
    }
}

@MainActor
private func withHostedSettings<Content: View>(
    _ view: Content,
    _ body: (NSHostingView<Content>, NSWindow) async throws -> Void) async throws
{
    _ = AppKitTestSupport.application
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(x: 0, y: 0, width: 1000, height: 800)
    let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    defer {
        if let sheet = window.attachedSheet { window.endSheet(sheet) }
        window.orderOut(nil)
        window.contentView = nil
        window.close()
    }
    window.orderFront(nil)
    hosting.layoutSubtreeIfNeeded()
    try await body(hosting, window)
}

@MainActor
private func settingsAccessibilityElements(_ root: NSView) async throws -> [AnyObject] {
    // SwiftUI materializes its virtual accessibility children after a real client request.
    let result = await Task.detached {
        let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        var windows: CFTypeRef?
        return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
    }.value
    try #require(result == .success)
    var elements: [AnyObject] = []
    var visited = Set<ObjectIdentifier>()
    func visit(_ element: AnyObject) {
        guard visited.insert(ObjectIdentifier(element)).inserted else { return }
        elements.append(element)
        for child in element.accessibilityChildren?() ?? [] {
            visit(child as AnyObject)
        }
    }
    visit(root)
    return elements
}
