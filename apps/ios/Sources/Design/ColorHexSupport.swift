import SwiftUI

enum ColorHexSupport {
    static func color(fromHex raw: String?) -> Color? {
        guard let hex = normalizedHex(raw), let value = Int(hex.dropFirst(), radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
    }

    /// Strict #rrggbb validation (leading "#" optional); returns canonical lowercase "#rrggbb".
    static func normalizedHex(_ raw: String?) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hex = (trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed).lowercased()
        guard hex.count == 6, hex.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        return "#\(hex)"
    }

    /// Per-profile accent from a users.prefs.get entries payload. nil for
    /// missing or malformed values so callers fall back to the gateway accent.
    static func profileAccentHex(entries: [String: Any]?) -> String? {
        self.normalizedHex(entries?["ui.accent"] as? String)
    }

    /// Gateway user-accent contract shared with the Control UI and talk config:
    /// ui.prefs.accent wins over ui.seamColor; invalid values fall through.
    static func gatewayUserAccentHex(configUI ui: [String: Any]?) -> String? {
        let prefs = ui?["prefs"] as? [String: Any]
        for candidate in [prefs?["accent"] as? String, ui?["seamColor"] as? String] {
            if let hex = normalizedHex(candidate) { return hex }
        }
        return nil
    }
}
