import Foundation

public struct SystemAgentChatQuestion: Equatable, Sendable {
    public struct Option: Equatable, Sendable {
        public let label: String
        public let description: String?
        public let recommended: Bool
        public let reply: String?
    }

    public let id: String
    public let header: String
    public let question: String
    public let options: [Option]
    public let isOther: Bool

    /// Card-capable clients validate the open payload before turning values into actions.
    /// Invalid questions stay prose-only instead of exposing partial or ambiguous choices.
    public static func parse(_ value: [String: AnyCodable]?) -> Self? {
        guard let value,
              let id = nonEmptyString(value["id"]),
              let header = nonEmptyString(value["header"]),
              let question = nonEmptyString(value["question"]),
              let rawOptions = value["options"]?.arrayValue,
              (2...4).contains(rawOptions.count)
        else { return nil }

        var labels = Set<String>()
        var recommendedCount = 0
        var options: [Option] = []
        options.reserveCapacity(rawOptions.count)

        for rawOption in rawOptions {
            guard let option = rawOption.dictionaryValue,
                  let label = Self.nonEmptyString(option["label"]),
                  labels.insert(label.lowercased()).inserted
            else { return nil }

            let recommended = option["recommended"]?.boolValue == true
            recommendedCount += recommended ? 1 : 0
            guard recommendedCount <= 1 else { return nil }
            options.append(Option(
                label: label,
                description: Self.nonEmptyString(option["description"]),
                recommended: recommended,
                reply: Self.nonEmptyString(option["reply"])))
        }

        return Self(
            id: id,
            header: header,
            question: question,
            options: options,
            isOther: value["isOther"]?.boolValue == true)
    }

    private static func nonEmptyString(_ value: AnyCodable?) -> String? {
        guard let string = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !string.isEmpty
        else { return nil }
        return string
    }
}
