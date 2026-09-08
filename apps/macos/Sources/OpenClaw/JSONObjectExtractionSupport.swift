import Foundation

enum JSONObjectExtractionSupport {
    struct ExtractedObject {
        let text: String
        let object: [String: Any]

        var message: String? {
            JSONObjectExtractionSupport.mergeHints(
                message: (self.object["error"] as? String) ?? (self.object["message"] as? String),
                hints: (self.object["hints"] as? [String]) ?? [])
        }
    }

    static func extract(from raw: String) -> ExtractedObject? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let start = trimmed.firstIndex(of: "{"),
              let end = trimmed.lastIndex(of: "}")
        else {
            return nil
        }
        let jsonText = String(trimmed[start...end])
        guard let data = jsonText.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return ExtractedObject(text: jsonText, object: object)
    }

    static func mergeHints(message: String?, hints: [String]) -> String? {
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nonEmpty = trimmed?.isEmpty == false ? trimmed : nil
        guard !hints.isEmpty else { return nonEmpty }
        let hintText = hints.prefix(2).joined(separator: " · ")
        if let nonEmpty {
            return "\(nonEmpty) (\(hintText))"
        }
        return hintText
    }
}
