import Foundation

public struct SharedContentPayload: Sendable, Equatable {
    public let title: String?
    public let url: URL?
    public let text: String?

    public init(title: String?, url: URL?, text: String?) {
        self.title = title
        self.url = url
        self.text = text
    }
}

public enum ShareToAgentDeepLink {
    public static func buildURL(from payload: SharedContentPayload, instruction: String? = nil) -> URL? {
        let message = self.buildMessage(from: payload, instruction: instruction)
        guard !message.isEmpty else { return nil }

        var components = URLComponents()
        components.scheme = "openclaw"
        components.host = "agent"
        components.queryItems = [
            URLQueryItem(name: "message", value: message),
            URLQueryItem(name: "thinking", value: "low"),
        ]
        return components.url
    }

    public static func buildMessage(from payload: SharedContentPayload, instruction: String? = nil) -> String {
        let title = self.clean(payload.title)
        let text = self.clean(payload.text)
        let urlText = payload.url?.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedInstruction = self.clean(instruction) ?? ShareToAgentSettings.loadDefaultInstruction()

        var lines = ["Shared from iOS."]
        if let title, !title.isEmpty {
            lines.append("Title: \(title)")
        }
        if let urlText, !urlText.isEmpty {
            lines.append("URL: \(urlText)")
        }
        if let text, !text.isEmpty {
            lines.append("Text:\n\(text)")
        }
        lines.append(resolvedInstruction)

        let message = lines.joined(separator: "\n\n")
        return self.limit(message, maxCharacters: 2400)
    }

    private static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func limit(_ value: String, maxCharacters: Int) -> String {
        guard value.count > maxCharacters else { return value }
        return String(value.prefix(maxCharacters))
    }
}
