import OpenClawKit

public enum OpenClawChatEventText {
    public static func assistantText(from event: OpenClawChatEventPayload) -> String? {
        self.assistantText(fromMessage: event.message)
    }

    public static func assistantText(fromMessage message: AnyCodable?) -> String? {
        guard let message else { return nil }
        return self.assistantText(fromValue: message.value)
    }

    private static func assistantText(fromValue value: Any) -> String? {
        if let text = value as? String {
            return self.trimmed(text)
        }

        guard let object = self.dictionary(from: value) else { return nil }
        if let role = self.stringValue(object["role"])?.trimmingCharacters(in: .whitespacesAndNewlines),
           !role.isEmpty,
           role.lowercased() != "assistant"
        {
            return nil
        }

        guard let content = object["content"] else { return nil }
        return self.textContent(from: content)
    }

    private static func textContent(from value: Any) -> String? {
        if let text = value as? String {
            return self.trimmed(text)
        }

        let parts: [String] = if let array = value as? [AnyCodable] {
            array.compactMap { self.textContentPart(from: $0.value) }
        } else if let array = value as? [Any] {
            array.compactMap { self.textContentPart(from: $0) }
        } else {
            self.textContentPart(from: value).map { [$0] } ?? []
        }

        return self.trimmed(parts.joined(separator: "\n"))
    }

    private static func textContentPart(from value: Any) -> String? {
        if let text = value as? String {
            return self.trimmed(text)
        }
        guard let object = self.dictionary(from: value) else { return nil }
        return self.trimmed(self.stringValue(object["text"]) ?? "")
    }

    private static func dictionary(from value: Any) -> [String: Any]? {
        if let dict = value as? [String: AnyCodable] {
            return dict.mapValues(\.value)
        }
        if let dict = value as? [String: Any] {
            return dict
        }
        return nil
    }

    private static func stringValue(_ value: Any?) -> String? {
        if let string = value as? String {
            return string
        }
        if let wrapped = value as? AnyCodable {
            return self.stringValue(wrapped.value)
        }
        return nil
    }

    private static func trimmed(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
