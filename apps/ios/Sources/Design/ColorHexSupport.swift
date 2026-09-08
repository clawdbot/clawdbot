import OpenClawKit
import SwiftUI

enum ColorHexSupport {
    static func color(fromHex raw: String?) -> Color? {
        guard let hex = GatewayUserPreferences.normalizedAccentHex(raw),
              let value = Int(hex.dropFirst(), radix: 16)
        else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
    }

    /// Gateway user-accent contract shared with the Control UI and talk config:
    /// ui.prefs.accent wins over ui.seamColor; invalid values fall through.
    static func gatewayUserAccentHex(configUI ui: [String: Any]?) -> String? {
        let prefs = ui?["prefs"] as? [String: Any]
        for candidate in [prefs?["accent"] as? String, ui?["seamColor"] as? String] {
            if let hex = GatewayUserPreferences.normalizedAccentHex(candidate) { return hex }
        }
        return nil
    }
}
