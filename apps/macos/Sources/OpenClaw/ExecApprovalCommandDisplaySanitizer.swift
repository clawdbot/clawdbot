import Foundation

enum ExecApprovalCommandDisplaySanitizer {
    private static let invisibleCodePoints: Set<UInt32> = [
        0x115F,
        0x1160,
        0x3164,
        0xFFA0,
    ]

    static func sanitize(_ text: String) -> String {
        var sanitized = ""
        sanitized.reserveCapacity(text.count)
        for scalar in text.unicodeScalars {
            if self.shouldEscape(scalar) {
                sanitized.append(self.escape(scalar))
            } else {
                sanitized.append(String(scalar))
            }
        }
        return sanitized
    }

    private static func shouldEscape(_ scalar: UnicodeScalar) -> Bool {
        let category = scalar.properties.generalCategory
        if category == .control
            || category == .format
            || category == .lineSeparator
            || category == .paragraphSeparator
        {
            return true
        }
        // Escape non-ASCII space separators (NBSP, narrow NBSP, ideographic space, etc.) so
        // attackers cannot spoof token boundaries in the approval UI with spaces that render
        // like a plain space but are handled differently by shells/parsers.
        if category == .spaceSeparator, scalar.value != 0x20 {
            return true
        }
        return self.invisibleCodePoints.contains(scalar.value)
    }

    private static func escape(_ scalar: UnicodeScalar) -> String {
        "\\u{\(String(scalar.value, radix: 16, uppercase: true))}"
    }
}
