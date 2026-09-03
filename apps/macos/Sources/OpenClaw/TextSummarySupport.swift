import Foundation

enum TextSummarySupport {
    static func summarizeLastLine(_ text: String, maxLength: Int = 200) -> String? {
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return nil }
        // Node fatal errors end with a bare "Node.js vX.Y.Z" banner. Surfacing
        // that line hides the actual failure ("Error: Cannot find module …"),
        // so drop the banner and prefer the last real error line above it.
        var candidates = lines[...]
        var droppedNodeBanner = false
        while let last = candidates.last, Self.isNodeVersionBanner(last) {
            candidates = candidates.dropLast()
            droppedNodeBanner = true
        }
        var chosen = candidates.last ?? lines[lines.count - 1]
        if droppedNodeBanner, let errorLine = candidates.suffix(40).last(where: self.isErrorLine) {
            chosen = errorLine
        }
        let normalized = chosen.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        if normalized.count > maxLength {
            return String(normalized.prefix(maxLength - 1)) + "…"
        }
        return normalized
    }

    private static func isNodeVersionBanner(_ line: String) -> Bool {
        line.range(of: #"^Node\.js v\d"#, options: .regularExpression) != nil
    }

    private static func isErrorLine(_ line: String) -> Bool {
        line.range(of: #"^\w*Error(\b|:)"#, options: .regularExpression) != nil
    }
}
