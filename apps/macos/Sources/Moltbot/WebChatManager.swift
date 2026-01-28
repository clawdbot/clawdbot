import AppKit
import Foundation

/// A borderless panel that can still accept key focus (needed for typing).
final class WebChatPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

enum WebChatPresentation {
    case window
    case panel(anchorProvider: () -> NSRect?)

    var isPanel: Bool {
        if case .panel = self { return true }
        return false
    }
}

@MainActor
final class WebChatManager {
    static let shared = WebChatManager()

    private var windowController: WebChatSwiftUIWindowController?
    private var windowSessionKey: String?
    private var panelController: WebChatSwiftUIWindowController?
    private var panelSessionKey: String?
    private var cachedPreferredSessionKey: String?

    var onPanelVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        self.panelSessionKey ?? self.windowSessionKey
    }

    func show(sessionKey: String) {
        self.closePanel()
        if let controller = self.windowController {
            if self.windowSessionKey == sessionKey {
                controller.show()
                return
            }

            controller.close()
            self.windowController = nil
            self.windowSessionKey = nil
        }
        let controller = WebChatSwiftUIWindowController(sessionKey: sessionKey, presentation: .window)
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        self.windowController = controller
        self.windowSessionKey = sessionKey
        controller.show()
    }

    func togglePanel(sessionKey: String, anchorProvider: @escaping () -> NSRect?) {
        if let controller = self.panelController {
            if self.panelSessionKey != sessionKey {
                controller.close()
                self.panelController = nil
                self.panelSessionKey = nil
            } else {
                if controller.isVisible {
                    controller.close()
                } else {
                    controller.presentAnchored(anchorProvider: anchorProvider)
                }
                return
            }
        }

        let controller = WebChatSwiftUIWindowController(
            sessionKey: sessionKey,
            presentation: .panel(anchorProvider: anchorProvider))
        controller.onClosed = { [weak self] in
            self?.panelHidden()
        }
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        self.panelController = controller
        self.panelSessionKey = sessionKey
        controller.presentAnchored(anchorProvider: anchorProvider)
    }

    func closePanel() {
        self.panelController?.close()
    }

    func preferredSessionKey() async -> String {
        if let cachedPreferredSessionKey { return cachedPreferredSessionKey }
        let key = await GatewayConnection.shared.mainSessionKey()
        self.cachedPreferredSessionKey = key
        return key
    }

    func resetTunnels() {
        self.windowController?.close()
        self.windowController = nil
        self.windowSessionKey = nil
        self.panelController?.close()
        self.panelController = nil
        self.panelSessionKey = nil
        self.cachedPreferredSessionKey = nil
    }

    func close() {
        self.windowController?.close()
        self.windowController = nil
        self.windowSessionKey = nil
        self.panelController?.close()
        self.panelController = nil
        self.panelSessionKey = nil
        self.cachedPreferredSessionKey = nil
    }

    private func panelHidden() {
        self.onPanelVisibilityChanged?(false)
        // Keep panel controller cached so reopening doesn't re-bootstrap.
    }
}
