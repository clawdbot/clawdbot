import Foundation

enum ChatCompactTokenCountFormatter {
    static func string(_ tokens: Double) -> String {
        if tokens >= 1_000_000 {
            return "\(self.oneDecimal(tokens / 1_000_000))M"
        }
        if tokens >= 1000 {
            let thousands = self.oneDecimal(tokens / 1000)
            if Double(thousands) ?? 0 >= 1000 {
                return "\(self.oneDecimal(tokens / 1_000_000))M"
            }
            return "\(thousands)k"
        }
        return String(Int(tokens))
    }

    private static func oneDecimal(_ value: Double) -> String {
        let rounded = (value * 10).rounded(.toNearestOrAwayFromZero) / 10
        let formatted = String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), rounded)
        return formatted.hasSuffix(".0") ? String(formatted.dropLast(2)) : formatted
    }
}
