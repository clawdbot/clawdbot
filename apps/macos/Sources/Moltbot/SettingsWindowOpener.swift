import AppKit
import SwiftUI

@objc
private protocol SettingsWindowMenuActions {
    @objc(showSettingsWindow:)
    optional func showSettingsWindow(_ sender: Any?)

    @objc(showPreferencesWindow:)
    optional func showPreferencesWindow(_ sender: Any?)
}

@MainActor
final class SettingsWindowOpener {
    static let shared = SettingsWindowOpener()

    private var openSettingsAction: OpenSettingsAction?

    func register(openSettings: OpenSettingsAction) {
        self.openSettingsAction = openSettings
    }

    func open() {
        NSApp.activate(ignoringOtherApps: true)
        if let openSettingsAction {
            openSettingsAction()
            return
        }

        // Fallback path: mimic the built-in Settings menu item action.
        let didOpen = NSApp.sendAction(#selector(SettingsWindowMenuActions.showSettingsWindow(_:)), to: nil, from: nil)
        if !didOpen {
            _ = NSApp.sendAction(#selector(SettingsWindowMenuActions.showPreferencesWindow(_:)), to: nil, from: nil)
        }
    }
}
