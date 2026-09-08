import SwiftUI

// Keep this explicit for SwiftPM toolchains where SwiftUI macro plugins are unavailable.
// swiftformat:disable environmentEntry
private struct MenuItemHighlightedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var menuItemHighlighted: Bool {
        get { self[MenuItemHighlightedKey.self] }
        set { self[MenuItemHighlightedKey.self] = newValue }
    }
}

// swiftformat:enable environmentEntry

enum MenuItemHighlightColors {
    struct Palette {
        let primary: Color
        let secondary: Color
    }

    static func primary(_ highlighted: Bool) -> Color {
        highlighted ? Color(nsColor: .selectedMenuItemTextColor) : .primary
    }

    static func secondary(_ highlighted: Bool) -> Color {
        highlighted ? Color(nsColor: .selectedMenuItemTextColor).opacity(0.85) : .secondary
    }

    static func palette(_ highlighted: Bool) -> Palette {
        Palette(
            primary: self.primary(highlighted),
            secondary: self.secondary(highlighted))
    }
}
