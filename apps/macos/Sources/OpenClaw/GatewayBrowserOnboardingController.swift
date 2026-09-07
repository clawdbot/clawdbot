import AppKit
import OpenClawKit
import SwiftUI

@MainActor
final class GatewayBrowserOnboardingController: NSWindowController, NSWindowDelegate {
    static let shared = GatewayBrowserOnboardingController()

    private init() {
        super.init(window: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func present(_ link: GatewayAddDeepLink) {
        // A new external intent replaces the editor, cancelling any pending sign-in.
        self.close()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 360),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false)
        window.title = "Add Gateway"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentViewController = NSHostingController(rootView: GatewayProfileEditor(
            name: link.name ?? "",
            address: link.url.absoluteString,
            onCancel: { [weak self] in self?.close() },
            onSaved: { [weak self] _ in self?.close() }))
        self.window = window
        window.center()
        self.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closingWindow = notification.object as? NSWindow else { return }
        closingWindow.contentViewController = nil
    }
}
