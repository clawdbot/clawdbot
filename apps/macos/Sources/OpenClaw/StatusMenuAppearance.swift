import AppKit

@MainActor
enum StatusMenuAppearance {
    static func pin(_ menu: NSMenu) {
        // Preserve accessibility variants carried by the effective appearance itself.
        menu.appearance = NSApplication.shared.effectiveAppearance
    }
}
