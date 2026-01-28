import Foundation

enum AnthropicOAuthCodeState {
    struct Parsed: Equatable {
        let code: String
        let state: String
    }

    /// Extracts a `code#state` payload from arbitrary text.
    ///
    /// Supports:
    /// - raw `code#state`
    /// - OAuth callback URLs containing `code=` and `state=` query params
    /// - surrounding text/backticks from instructions pages
    static func extract(from raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "`"))
        if text.isEmpty { return nil }

        if let fromURL = self.extractFromURL(text) { return fromURL }
        if let fromToken = self.extractFromToken(text) { return fromToken }
        return nil
    }

    static func parse(from raw: String) -> Parsed? {
        guard let extracted = self.extract(from: raw) else { return nil }
        let parts = extracted.split(separator: "#", maxSplits: 1).map(String.init)
        let code = parts.first ?? ""
        let state = parts.count > 1 ? parts[1] : ""
        guard !code.isEmpty, !state.isEmpty else { return nil }
        return Parsed(code: code, state: state)
    }

    private static func extractFromURL(_ text: String) -> String? {
        // Users might copy the callback URL from the browser address bar.
        guard let components = URLComponents(string: text),
              let items = components.queryItems,
              let code = items.first(where: { $0.name == "code" })?.value,
              let state = items.first(where: { $0.name == "state" })?.value,
              !code.isEmpty, !state.isEmpty
        else { return nil }

        return "\(code)#\(state)"
    }

    private static func extractFromToken(_ text: String) -> String? {
        // Base64url-ish tokens; keep this fairly strict to avoid false positives.
        let pattern = #"([A-Za-z0-9._~-]{8,})#([A-Za-z0-9._~-]{8,})"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }

        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = re.firstMatch(in: text, range: range),
              match.numberOfRanges == 3,
              let full = Range(match.range(at: 0), in: text)
        else { return nil }

        return String(text[full])
    }
}
