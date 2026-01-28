import Foundation

enum ChatMarkdownPreprocessor {
    struct InlineImage: Identifiable {
        let id = UUID()
        let label: String
        let image: MoltbotPlatformImage?
    }

    struct Result {
        let cleaned: String
        let images: [InlineImage]
    }

    static func preprocess(markdown raw: String) -> Result {
        let pattern = #"!\[([^\]]*)\]\((data:image\/[^;]+;base64,[^)]+)\)"#
        guard let re = try? NSRegularExpression(pattern: pattern) else {
            return Result(cleaned: raw, images: [])
        }

        let ns = raw as NSString
        let matches = re.matches(in: raw, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return Result(cleaned: raw, images: []) }

        var images: [InlineImage] = []
        var cleaned = raw

        for match in matches.reversed() {
            guard match.numberOfRanges >= 3 else { continue }
            let label = ns.substring(with: match.range(at: 1))
            let dataURL = ns.substring(with: match.range(at: 2))

            let image: MoltbotPlatformImage? = {
                guard let comma = dataURL.firstIndex(of: ",") else { return nil }
                let b64 = String(dataURL[dataURL.index(after: comma)...])
                guard let data = Data(base64Encoded: b64) else { return nil }
                return MoltbotPlatformImage(data: data)
            }()
            images.append(InlineImage(label: label, image: image))

            let start = cleaned.index(cleaned.startIndex, offsetBy: match.range.location)
            let end = cleaned.index(start, offsetBy: match.range.length)
            cleaned.replaceSubrange(start..<end, with: "")
        }

        let normalized = cleaned
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Result(cleaned: normalized, images: images.reversed())
    }
}
