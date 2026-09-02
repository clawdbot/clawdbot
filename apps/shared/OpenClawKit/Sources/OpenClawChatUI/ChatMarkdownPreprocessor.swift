import Foundation
import Markdown

enum ChatMarkdownPreprocessor {
    /// Provenance marker appended to every OpenClaw-injected inbound context header.
    /// Keep byte-identical with `src/auto-reply/reply/inbound-context-marker.ts` INBOUND_CONTEXT_MARKER.
    private static let inboundContextMarker = "\u{27E6}openclaw:ctx\u{27E7}"

    private static let contextHeader =
        "Context: \(inboundContextMarker)"
    private static let envelopeChannels = [
        "WebChat",
        "WhatsApp",
        "Telegram",
        "Signal",
        "Slack",
        "Discord",
        "Google Chat",
        "iMessage",
        "Teams",
        "Matrix",
        "Zalo",
        "Zalo Personal",
    ]

    private static let messageIdHintPattern = #"^\s*\[message_id:\s*[^\]]+\]\s*$"#
    private static let markdownLiteralPunctuation = CharacterSet(
        charactersIn: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")

    private struct MarkdownImageOccurrence {
        let range: Range<String.Index>
        let label: String
        let source: String
    }

    /// Maps swift-markdown's 1-based UTF-8 source locations back into the
    /// original String without normalizing line endings or Unicode first.
    private struct MarkdownSourceMap {
        private let markdown: String
        private let lineStarts: [String.Index]

        init(_ markdown: String) {
            self.markdown = markdown
            var lineStarts = [markdown.startIndex]
            let bytes = markdown.utf8
            for byteIndex in bytes.indices {
                let byte = bytes[byteIndex]
                guard byte == 0x0A || byte == 0x0D else { continue }

                let nextByteIndex = bytes.index(after: byteIndex)
                // CommonMark counts CRLF as one line ending. Record the next
                // line at LF, not at the midpoint of the two-byte sequence.
                if byte == 0x0D,
                   nextByteIndex < bytes.endIndex,
                   bytes[nextByteIndex] == 0x0A
                {
                    continue
                }
                if let lineStart = String.Index(nextByteIndex, within: markdown) {
                    lineStarts.append(lineStart)
                }
            }
            self.lineStarts = lineStarts
        }

        func range(for sourceRange: SourceRange) -> Range<String.Index>? {
            guard let lowerBound = self.index(for: sourceRange.lowerBound),
                  let upperBound = self.index(for: sourceRange.upperBound),
                  lowerBound <= upperBound
            else {
                return nil
            }
            return lowerBound..<upperBound
        }

        private func index(for location: SourceLocation) -> String.Index? {
            guard location.line > 0,
                  location.column > 0,
                  self.lineStarts.indices.contains(location.line - 1)
            else {
                return nil
            }

            let bytes = self.markdown.utf8
            guard let lineStart = self.lineStarts[location.line - 1].samePosition(in: bytes),
                  let byteIndex = bytes.index(
                      lineStart,
                      offsetBy: location.column - 1,
                      limitedBy: bytes.endIndex),
                  let stringIndex = String.Index(byteIndex, within: self.markdown)
            else {
                return nil
            }

            // A malformed dependency range must not spill into the next line.
            if self.lineStarts.indices.contains(location.line),
               stringIndex >= self.lineStarts[location.line]
            {
                return nil
            }
            return stringIndex
        }
    }

    private struct MarkdownImageCollector: MarkupWalker {
        private let sourceMap: MarkdownSourceMap
        private(set) var images: [MarkdownImageOccurrence] = []

        init(markdown: String) {
            self.sourceMap = MarkdownSourceMap(markdown)
        }

        mutating func visitImage(_ image: Markdown.Image) {
            guard let sourceRange = image.range,
                  let range = self.sourceMap.range(for: sourceRange)
            else {
                return
            }
            self.images.append(MarkdownImageOccurrence(
                range: range,
                label: image.plainText,
                source: image.source ?? ""))
        }
    }

    struct InlineImage: Identifiable {
        let id = UUID()
        let label: String
        let image: OpenClawPlatformImage?
    }

    struct Result {
        let cleaned: String
        let images: [InlineImage]
    }

    static func preprocess(markdown raw: String) -> Result {
        let withoutEnvelope = self.stripEnvelope(raw)
        let withoutMessageIdHints = self.stripMessageIdHints(withoutEnvelope)
        let withoutContextBlocks = self.stripInboundContextBlocks(withoutMessageIdHints)
        let withoutTimestamps = self.stripPrefixedTimestamps(withoutContextBlocks)
        // cmark replaces NUL with U+FFFD before computing UTF-8 source columns.
        // Use those same bytes for range mapping and the downstream renderer.
        let markdown = withoutTimestamps.replacingOccurrences(of: "\0", with: "\u{FFFD}")
        guard markdown.contains("![") else {
            return Result(cleaned: self.normalize(markdown), images: [])
        }

        // Only structural CommonMark images are renderable. A document-wide
        // regex also matches examples inside code and escaped user text.
        var collector = MarkdownImageCollector(markdown: markdown)
        collector.visit(Document(parsing: markdown))
        guard !collector.images.isEmpty else {
            return Result(cleaned: self.normalize(markdown), images: [])
        }

        var images: [InlineImage] = []
        let cleaned = NSMutableString(string: markdown)

        for occurrence in collector.images.reversed() {
            let range = NSRange(occurrence.range, in: markdown)
            if let inlineImage = self.inlineImage(
                label: occurrence.label,
                source: occurrence.source)
            {
                images.append(inlineImage)
                cleaned.replaceCharacters(in: range, with: "")
            } else {
                cleaned.replaceCharacters(
                    in: range,
                    with: self.fallbackImageLabel(occurrence.label))
            }
        }

        return Result(cleaned: self.normalize(cleaned as String), images: images.reversed())
    }

    private static func inlineImage(label: String, source: String) -> InlineImage? {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comma = trimmed.firstIndex(of: ","),
              trimmed[..<comma].range(
                  of: #"^data:image\/[^;]+;base64$"#,
                  options: [.regularExpression, .caseInsensitive]) != nil
        else {
            return nil
        }

        let b64 = String(trimmed[trimmed.index(after: comma)...])
        let image = Data(base64Encoded: b64).flatMap(OpenClawPlatformImage.init(data:))
        return InlineImage(label: label, image: image)
    }

    private static func fallbackImageLabel(_ label: String) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.markdownEscapedLiteral(trimmed.isEmpty ? "image" : trimmed)
    }

    private static func markdownEscapedLiteral(_ value: String) -> String {
        var escaped = ""
        escaped.reserveCapacity(value.utf8.count)
        for scalar in value.unicodeScalars {
            if self.markdownLiteralPunctuation.contains(scalar) {
                escaped.append("\\")
            }
            escaped.unicodeScalars.append(scalar)
        }
        return escaped
    }

    private static func stripEnvelope(_ raw: String) -> String {
        guard let closeIndex = raw.firstIndex(of: "]"),
              raw.first == "["
        else {
            return raw
        }
        let header = String(raw[raw.index(after: raw.startIndex)..<closeIndex])
        guard self.looksLikeEnvelopeHeader(header) else {
            return raw
        }
        return String(raw[raw.index(after: closeIndex)...])
    }

    private static func looksLikeEnvelopeHeader(_ header: String) -> Bool {
        if header.range(of: #"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b"#, options: .regularExpression) != nil {
            return true
        }
        if header.range(of: #"\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b"#, options: .regularExpression) != nil {
            return true
        }
        return self.envelopeChannels.contains(where: { header.hasPrefix("\($0) ") })
    }

    private static func stripMessageIdHints(_ raw: String) -> String {
        guard raw.contains("[message_id:") else {
            return raw
        }
        let lines = raw.replacingOccurrences(of: "\r\n", with: "\n").split(
            separator: "\n",
            omittingEmptySubsequences: false)
        let filtered = lines.filter { line in
            String(line).range(of: self.messageIdHintPattern, options: .regularExpression) == nil
        }
        guard filtered.count != lines.count else {
            return raw
        }
        return filtered.map(String.init).joined(separator: "\n")
    }

    private static func stripInboundContextBlocks(_ raw: String) -> String {
        guard raw.contains(self.inboundContextMarker) else {
            return raw
        }

        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var outputLines: [String] = []
        var inMetaBlock = false
        var inFencedJson = false
        var inProseBlock = false

        for index in lines.indices {
            let currentLine = lines[index]

            // Prose context body (chat history/window): drop lines until the
            // block-terminating blank line so the visible marker never renders.
            if inProseBlock {
                if currentLine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    inProseBlock = false
                }
                continue
            }

            if !inMetaBlock, self.shouldStripTrailingUntrustedContext(lines: lines, index: index) {
                break
            }

            if !inMetaBlock {
                let trimmed = currentLine.trimmingCharacters(in: .whitespacesAndNewlines)
                let isContextHeader = trimmed.count > self.inboundContextMarker.count &&
                    trimmed.hasSuffix(self.inboundContextMarker)
                if isContextHeader {
                    let nextLine = index + 1 < lines.count ? lines[index + 1] : nil
                    if nextLine?.trimmingCharacters(in: .whitespacesAndNewlines) != "```json" {
                        inProseBlock = true
                        continue
                    }
                    inMetaBlock = true
                    inFencedJson = false
                    continue
                }
            }

            if inMetaBlock {
                if !inFencedJson, currentLine.trimmingCharacters(in: .whitespacesAndNewlines) == "```json" {
                    inFencedJson = true
                    continue
                }

                if inFencedJson {
                    if currentLine.trimmingCharacters(in: .whitespacesAndNewlines) == "```" {
                        inMetaBlock = false
                        inFencedJson = false
                    }
                    continue
                }

                if currentLine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    continue
                }

                inMetaBlock = false
            }

            outputLines.append(currentLine)
        }

        return outputLines
            .joined(separator: "\n")
            .replacingOccurrences(of: #"^\n+"#, with: "", options: .regularExpression)
    }

    private static func shouldStripTrailingUntrustedContext(lines: [String], index: Int) -> Bool {
        lines[index].trimmingCharacters(in: .whitespacesAndNewlines) == self.contextHeader
    }

    private static func stripPrefixedTimestamps(_ raw: String) -> String {
        let pattern = #"(?m)^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:GMT|UTC)[+-]?\d{0,2}\]\s*"#
        return raw.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
    }

    private static func normalize(_ raw: String) -> String {
        var output = raw
        output = output.replacingOccurrences(of: "\r\n", with: "\n")
        output = output.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        output = output.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
