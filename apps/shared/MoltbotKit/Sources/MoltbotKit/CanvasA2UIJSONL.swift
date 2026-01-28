import Foundation

public enum MoltbotCanvasA2UIJSONL: Sendable {
    public struct ParsedItem: Sendable {
        public var lineNumber: Int
        public var message: AnyCodable

        public init(lineNumber: Int, message: AnyCodable) {
            self.lineNumber = lineNumber
            self.message = message
        }
    }

    public static func parse(_ text: String) throws -> [ParsedItem] {
        var out: [ParsedItem] = []
        var lineNumber = 0
        for rawLine in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            lineNumber += 1
            let line = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            let data = Data(line.utf8)

            let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
            out.append(ParsedItem(lineNumber: lineNumber, message: decoded))
        }
        return out
    }

    public static func validateV0_8(_ items: [ParsedItem]) throws {
        let allowed = Set([
            "beginRendering",
            "surfaceUpdate",
            "dataModelUpdate",
            "deleteSurface",
        ])
        for item in items {
            guard let dict = item.message.value as? [String: AnyCodable] else {
                throw NSError(domain: "A2UI", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "A2UI JSONL line \(item.lineNumber): expected a JSON object",
                ])
            }

            if dict.keys.contains("createSurface") {
                throw NSError(domain: "A2UI", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: """
                    A2UI JSONL line \(item.lineNumber): looks like A2UI v0.9 (`createSurface`).
                    Canvas currently supports A2UI v0.8 server→client messages
                    (`beginRendering`, `surfaceUpdate`, `dataModelUpdate`, `deleteSurface`).
                    """,
                ])
            }

            let matched = dict.keys.filter { allowed.contains($0) }
            if matched.count != 1 {
                let found = dict.keys.sorted().joined(separator: ", ")
                throw NSError(domain: "A2UI", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: """
                    A2UI JSONL line \(item.lineNumber): expected exactly one of \(allowed.sorted()
                        .joined(separator: ", ")); found: \(found)
                    """,
                ])
            }
        }
    }

    public static func decodeMessagesFromJSONL(_ text: String) throws -> [AnyCodable] {
        let items = try self.parse(text)
        try self.validateV0_8(items)
        return items.map(\.message)
    }

    public static func encodeMessagesJSONArray(_ messages: [AnyCodable]) throws -> String {
        let data = try JSONEncoder().encode(messages)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "A2UI", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode messages payload as UTF-8",
            ])
        }
        return json
    }
}
