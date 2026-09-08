import Foundation

public enum GatewayUserPreferences {
    /// Strict #rrggbb validation (leading "#" optional); canonical lowercase "#rrggbb".
    public static func normalizedAccentHex(_ raw: String?) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hex = (trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed).lowercased()
        guard hex.count == 6, hex.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        return "#\(hex)"
    }

    /// Only an available profile preference may override the caller's Gateway accent.
    public static func decodeProfileAccentHex(_ data: Data) throws -> String? {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["status"] as? String == "ok"
        else { return nil }
        let entries = json["entries"] as? [String: Any]
        return self.normalizedAccentHex(entries?["ui.accent"] as? String)
    }
}
