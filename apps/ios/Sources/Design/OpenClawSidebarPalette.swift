import SwiftUI
import UIKit

/// Sidebar surface tokens mirroring the mobile-exp prototype palette; the
/// drawer follows the app appearance (owner decision superseding always-dark).
enum OpenClawSidebarPalette {
    static let background = adaptive(light: 0xFAFAFA, dark: 0x000000)
    static let elevated = adaptive(light: 0xF2F2F2, dark: 0x1A1A1A)
    static let selection = adaptive(light: 0xEDEDED, dark: 0x232327)
    static let text = adaptive(light: 0x171717, dark: 0xEDEDED)
    static let textStrong = adaptive(light: 0x171717, dark: 0xEDEDED)
    static let muted = adaptive(light: 0x8F8F8F, dark: 0x8F8F8F)
    static let accent = OpenClawBrand.accent

    static let hairline = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.14)
            : UIColor(white: 0, alpha: 0.08)
    })

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((value >> 16) & 0xFF) / 255,
                green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255,
                alpha: 1)
        })
    }
}
