import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct SettingsViewSmokeTests {
    @Test func `connection page exposes config write failures`() async throws {
        let blockedParent = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-blocked-\(UUID().uuidString)")
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        try Data().write(to: blockedParent)
        defer {
            try? FileManager().removeItem(at: blockedParent)
            try? FileManager().removeItem(at: stateDir)
        }

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": blockedParent.appendingPathComponent("openclaw.json").path,
                "OPENCLAW_STATE_DIR": stateDir.path,
            ],
            defaults: [connectionModeKey: AppState.ConnectionMode.local.rawValue])
        {
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()
            state.remoteToken = "pending-token"
            await state._testAwaitGatewayConfigSync()

            let hosting = NSHostingView(rootView: ConnectionSettingsView(state: state)
                .environment(TailscaleService.shared))
            hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 700)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.contentView = hosting
            window.makeKeyAndOrderFront(nil)
            defer { window.orderOut(nil) }

            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .seconds(3))
            while clock.now < deadline {
                hosting.layoutSubtreeIfNeeded()
                let identifiers = Self.accessibilityIdentifiers(in: hosting)
                if identifiers.contains("gateway-config-write-error") {
                    return
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            Issue.record("Config write failure was not visible")
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

    private static func accessibilityIdentifiers(in element: Any) -> [String] {
        guard let accessible = element as? NSAccessibilityProtocol else { return [] }
        return [accessible.accessibilityIdentifier()].compactMap { $0 } +
            (accessible.accessibilityChildren() ?? []).flatMap(self.accessibilityIdentifiers)
    }
}
