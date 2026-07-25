import Foundation
import SwiftMath
import SwiftUI
#if os(macOS)
import AppKit

typealias ChatInlineMathPlatformImage = NSImage
#else
import UIKit

typealias ChatInlineMathPlatformImage = UIImage
#endif

struct ChatInlineMathSpan {
    let latex: String
    let source: String
}

enum ChatInlineMathScanner {
    enum Piece: Equatable {
        case markdown(String)
        case math(latex: String, source: String)
        case literal(String)
    }

    static let maxSpanCount = 16
    static let maxSourceBytes = 200

    static func pieces(in markdown: String) -> [Piece] {
        guard markdown.contains(#"\("#) else { return [.markdown(markdown)] }

        var pieces: [Piece] = []
        var textStart = markdown.startIndex
        var cursor = markdown.startIndex
        var spanCount = 0
        let codeSpans = self.confirmedCodeSpans(in: markdown)
        var codeSpanIndex = 0

        while cursor < markdown.endIndex {
            if codeSpanIndex < codeSpans.count,
               cursor == codeSpans[codeSpanIndex].lowerBound
            {
                cursor = codeSpans[codeSpanIndex].upperBound
                codeSpanIndex += 1
                continue
            }

            guard markdown[cursor...].hasPrefix(#"\("#),
                  !self.isEscaped(at: cursor, in: markdown)
            else {
                cursor = markdown.index(after: cursor)
                continue
            }

            if textStart < cursor {
                pieces.append(.markdown(String(markdown[textStart..<cursor])))
            }
            let opener = cursor
            let contentStart = markdown.index(cursor, offsetBy: 2)
            guard let candidate = self.candidate(
                startingAt: contentStart,
                in: markdown,
                codeSpans: codeSpans)
            else {
                pieces.append(.literal(String(markdown[opener...])))
                return pieces
            }

            spanCount += 1
            let source = String(markdown[opener..<candidate.end])
            let latex = String(markdown[contentStart..<candidate.closeStart])
            if spanCount <= self.maxSpanCount,
               !candidate.containsNewline,
               source.utf8.count <= self.maxSourceBytes
            {
                pieces.append(.math(latex: latex, source: source))
            } else {
                pieces.append(.literal(source))
            }
            cursor = candidate.end
            textStart = cursor
        }

        if textStart < markdown.endIndex {
            pieces.append(.markdown(String(markdown[textStart...])))
        }
        return pieces
    }

    private struct Candidate {
        let closeStart: String.Index
        let end: String.Index
        let containsNewline: Bool
    }

    private static func candidate(
        startingAt start: String.Index,
        in markdown: String,
        codeSpans: [Range<String.Index>]) -> Candidate?
    {
        var cursor = start
        var codeSpanIndex = self.firstCodeSpan(endingAfter: start, in: codeSpans)
        var containsNewline = false
        while cursor < markdown.endIndex {
            if codeSpanIndex < codeSpans.count,
               cursor == codeSpans[codeSpanIndex].lowerBound
            {
                cursor = codeSpans[codeSpanIndex].upperBound
                codeSpanIndex += 1
                continue
            }
            let character = markdown[cursor]
            if character == "\n" || character == "\r" {
                containsNewline = true
            }
            if markdown[cursor...].hasPrefix(#"\)"#),
               !self.isEscaped(at: cursor, in: markdown)
            {
                return Candidate(
                    closeStart: cursor,
                    end: markdown.index(cursor, offsetBy: 2),
                    containsNewline: containsNewline)
            }
            cursor = markdown.index(after: cursor)
        }
        return nil
    }

    private struct BacktickRun {
        let start: String.Index
        let end: String.Index
        let length: Int
        let canOpen: Bool
    }

    private static func confirmedCodeSpans(in markdown: String) -> [Range<String.Index>] {
        var runs: [BacktickRun] = []
        var cursor = markdown.startIndex
        while cursor < markdown.endIndex {
            guard markdown[cursor] == "`" else {
                cursor = markdown.index(after: cursor)
                continue
            }
            let end = self.endOfBacktickRun(at: cursor, in: markdown)
            runs.append(BacktickRun(
                start: cursor,
                end: end,
                length: markdown.distance(from: cursor, to: end),
                canOpen: !self.isEscaped(at: cursor, in: markdown)))
            cursor = end
        }

        var nextMatchingRun = [Int?](repeating: nil, count: runs.count)
        var nextIndexByLength: [Int: Int] = [:]
        for index in runs.indices.reversed() {
            nextMatchingRun[index] = nextIndexByLength[runs[index].length]
            nextIndexByLength[runs[index].length] = index
        }

        var spans: [Range<String.Index>] = []
        var index = 0
        while index < runs.count {
            guard runs[index].canOpen,
                  let closeIndex = nextMatchingRun[index]
            else {
                index += 1
                continue
            }
            spans.append(runs[index].start..<runs[closeIndex].end)
            index = closeIndex + 1
        }
        return spans
    }

    private static func firstCodeSpan(
        endingAfter index: String.Index,
        in spans: [Range<String.Index>]) -> Int
    {
        var lower = 0
        var upper = spans.count
        while lower < upper {
            let middle = lower + (upper - lower) / 2
            if spans[middle].upperBound <= index {
                lower = middle + 1
            } else {
                upper = middle
            }
        }
        return lower
    }

    private static func endOfBacktickRun(at start: String.Index, in markdown: String) -> String.Index {
        var end = start
        while end < markdown.endIndex, markdown[end] == "`" {
            end = markdown.index(after: end)
        }
        return end
    }

    private static func isEscaped(at index: String.Index, in markdown: String) -> Bool {
        var cursor = index
        var slashCount = 0
        while cursor > markdown.startIndex {
            let previous = markdown.index(before: cursor)
            guard markdown[previous] == "\\" else { break }
            slashCount += 1
            cursor = previous
        }
        return slashCount.isMultiple(of: 2) == false
    }
}

/// Parsed math is stable after its delimiter closes. A bounded cache avoids
/// repeating SwiftMath parsing as later streaming deltas rerender old blocks.
@MainActor
enum ChatMathParseCache {
    private enum Result {
        case parsed(MTMathList)
        case invalid
    }

    private static var cache: [String: Result] = [:]
    private static let capacity = 80
    private static let maxNestingDepth = 64
    private static let maxCommandCount = 128
    private static let unsafeCommands = [#"\color"#, #"\colorbox"#, #"\textcolor"#]

    static func mathList(latex: String) -> MTMathList? {
        guard !latex.isEmpty else { return nil }
        // SwiftMath silently drops unsupported Unicode instead of reporting a
        // parse error. Preserve the source through the raw-text fallback.
        guard latex.unicodeScalars.allSatisfy(\.isASCII) else { return nil }
        // SwiftMath recursively parses groups. Bound hostile nesting before
        // entering the dependency so a short expression cannot exhaust stack.
        guard self.isWithinParserLimits(latex) else { return nil }
        // SwiftMath 1.7.3 traps while typesetting empty color-command bodies.
        // Chat owns the surrounding color, so preserve these as raw source.
        guard !self.unsafeCommands.contains(where: latex.contains) else { return nil }
        if let hit = self.cache[latex] {
            if case let .parsed(mathList) = hit {
                return mathList
            }
            return nil
        }

        let result = MTMathListBuilder.build(fromString: latex)
            .map(Result.parsed) ?? .invalid
        if self.cache.count >= self.capacity {
            self.cache.removeAll(keepingCapacity: true)
        }
        self.cache[latex] = result
        if case let .parsed(mathList) = result {
            return mathList
        }
        return nil
    }

    private static func isWithinParserLimits(_ latex: String) -> Bool {
        var depth = 0
        var commandCount = 0
        var escaped = false
        for character in latex {
            if escaped {
                escaped = false
                continue
            }
            if character == "\\" {
                commandCount += 1
                if commandCount > self.maxCommandCount {
                    return false
                }
                escaped = true
            } else if character == "{" {
                depth += 1
                if depth > self.maxNestingDepth {
                    return false
                }
            } else if character == "}" {
                depth = max(0, depth - 1)
            }
        }
        return true
    }
}

@MainActor
enum ChatInlineMathImageCache {
    struct RenderedImage {
        let image: ChatInlineMathPlatformImage
        let baselineOffset: CGFloat
    }

    private struct Key: Hashable {
        let latex: String
        let fontSize: CGFloat
        let colorHash: Int
    }

    private static var cache: [Key: RenderedImage] = [:]
    private static let capacity = 80
    private static let maxRenderedPixelArea: CGFloat = 262_144
    private static let maxRenderedPixelDimension: CGFloat = 4096

    static func image(
        latex: String,
        fontSize: CGFloat,
        textColor: Color,
        colorScheme: ColorScheme) -> RenderedImage?
    {
        guard fontSize.isFinite, fontSize > 0,
              let mathList = ChatMathParseCache.mathList(latex: latex)
        else { return nil }
        let platformColor = self.platformColor(textColor, colorScheme: colorScheme)
        let key = Key(
            latex: latex,
            fontSize: fontSize,
            colorHash: self.colorHash(platformColor))
        if let cached = self.cache[key] {
            return cached
        }

        let metricsLabel = MTMathUILabel()
        metricsLabel.mathList = mathList
        metricsLabel.labelMode = .text
        metricsLabel.fontSize = fontSize
        metricsLabel.textColor = platformColor
        let size: CGSize
        #if os(macOS)
        size = metricsLabel.fittingSize
        metricsLabel.frame = CGRect(origin: .zero, size: size)
        metricsLabel.layoutSubtreeIfNeeded()
        #else
        size = metricsLabel.intrinsicContentSize
        metricsLabel.frame = CGRect(origin: .zero, size: size)
        metricsLabel.layoutIfNeeded()
        #endif
        guard self.isSafeImageSize(size, scale: self.imageScale) else { return nil }

        // MTMathImage allocates immediately in asImage(). Measure with the same
        // text-mode typesetter first so hostile input cannot request an empty or
        // oversized backing bitmap.
        let imageRenderer = MTMathImage(
            latex: latex,
            fontSize: fontSize,
            textColor: platformColor,
            labelMode: .text,
            textAlignment: .left)
        guard let image = imageRenderer.asImage().1 else { return nil }

        // Text(Image) places the image bottom on the surrounding baseline.
        // SwiftMath exposes its baseline descent through displayList, so lower
        // the image by that descent to align the two typographic baselines.
        let rendered = RenderedImage(
            image: image,
            baselineOffset: -(metricsLabel.displayList?.descent ?? 0))
        if self.cache.count >= self.capacity {
            self.cache.removeAll(keepingCapacity: true)
        }
        self.cache[key] = rendered
        return rendered
    }

    static func isSafeImageSize(_ size: CGSize, scale: CGFloat) -> Bool {
        guard size.width.isFinite, size.height.isFinite, scale.isFinite,
              size.width > 0, size.height > 0, scale > 0
        else { return false }
        let pixelWidth = size.width * scale
        let pixelHeight = size.height * scale
        return pixelWidth.isFinite && pixelHeight.isFinite &&
            pixelWidth <= self.maxRenderedPixelDimension &&
            pixelHeight <= self.maxRenderedPixelDimension &&
            pixelWidth * pixelHeight <= self.maxRenderedPixelArea
    }

    private static var imageScale: CGFloat {
        #if os(macOS)
        NSScreen.main?.backingScaleFactor ?? 2
        #else
        UIScreen.main.scale
        #endif
    }

    private static func platformColor(_ color: Color, colorScheme: ColorScheme) -> MTColor {
        #if os(macOS)
        guard let appearance = NSAppearance(
            named: colorScheme == .dark ? .darkAqua : .aqua)
        else { return NSColor(color) }
        var platformColor = NSColor.clear
        appearance.performAsCurrentDrawingAppearance {
            let resolved = NSColor(color)
            platformColor = resolved.usingColorSpace(.deviceRGB) ?? resolved
        }
        return platformColor
        #else
        let style: UIUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        return UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        #endif
    }

    private static func colorHash(_ color: MTColor) -> Int {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        var hasher = Hasher()
        hasher.combine(red)
        hasher.combine(green)
        hasher.combine(blue)
        hasher.combine(alpha)
        return hasher.finalize()
    }
}
