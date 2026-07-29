#!/usr/bin/env swift

import AppKit
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func htmlEscaped(_ value: String) -> String {
  var escaped = ""
  escaped.reserveCapacity(value.count)
  for character in value {
    switch character {
    case "&":
      escaped += "&amp;"
    case "<":
      escaped += "&lt;"
    case ">":
      escaped += "&gt;"
    case "\"":
      escaped += "&quot;"
    default:
      escaped.append(character)
    }
  }
  return escaped
}

func renderInlineMarkdown(_ value: String) -> String {
  let escaped = htmlEscaped(value)
  let pieces = escaped.split(separator: "`", omittingEmptySubsequences: false)
  guard pieces.count > 1 else {
    return escaped
  }

  return pieces.enumerated().map { index, piece in
    index.isMultiple(of: 2) ? String(piece) : "<code>\(piece)</code>"
  }.joined()
}

func absoluteFileURL(_ path: String) -> URL {
  if path.hasPrefix("/") {
    return URL(fileURLWithPath: path).standardizedFileURL
  }

  return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent(path)
    .standardizedFileURL
}

func markdownToHTML(_ markdown: String) -> String {
  var body: [String] = []
  var paragraph: [String] = []
  var inCodeBlock = false
  var codeLines: [String] = []
  var previousListItem = false

  func flushParagraph() {
    guard !paragraph.isEmpty else {
      return
    }
    body.append("<p>\(paragraph.map(renderInlineMarkdown).joined(separator: " "))</p>")
    paragraph.removeAll()
    previousListItem = false
  }

  func flushCodeBlock() {
    guard !codeLines.isEmpty else {
      return
    }
    body.append("<pre><code>\(htmlEscaped(codeLines.joined(separator: "\n")))</code></pre>")
    codeLines.removeAll()
    previousListItem = false
  }

  let headingPattern = try! NSRegularExpression(pattern: "^(#{1,6})\\s+(.+)$")
  let orderedListPattern = try! NSRegularExpression(pattern: "^\\s*(\\d+)\\.\\s+(.+)$")
  let unorderedListPattern = try! NSRegularExpression(pattern: "^\\s*-\\s+(.+)$")

  for rawLine in markdown.components(separatedBy: .newlines) {
    let line = rawLine.trimmingCharacters(in: .whitespaces)

    if line.hasPrefix("```") {
      if inCodeBlock {
        flushCodeBlock()
        inCodeBlock = false
      } else {
        flushParagraph()
        inCodeBlock = true
        previousListItem = false
      }
      continue
    }

    if inCodeBlock {
      codeLines.append(rawLine)
      continue
    }

    if line.isEmpty {
      flushParagraph()
      previousListItem = false
      continue
    }

    let lineRange = NSRange(line.startIndex..<line.endIndex, in: line)
    if let match = headingPattern.firstMatch(in: line, range: lineRange),
       let levelRange = Range(match.range(at: 1), in: line),
       let textRange = Range(match.range(at: 2), in: line) {
      flushParagraph()
      let level = line[levelRange].count
      if level == 2 {
        body.append("<p class=\"section-spacer\">&nbsp;</p>")
        body.append("<p class=\"section-spacer\">&nbsp;</p>")
      }
      body.append("<h\(level)>\(renderInlineMarkdown(String(line[textRange])))</h\(level)>")
      if level <= 2 {
        body.append("<p class=\"heading-rule\">\(String(repeating: "─", count: 85))</p>")
      }
      previousListItem = false
      continue
    }

    if let match = orderedListPattern.firstMatch(in: line, range: lineRange),
       let numberRange = Range(match.range(at: 1), in: line),
       let itemRange = Range(match.range(at: 2), in: line) {
      flushParagraph()
      let marker = htmlEscaped(String(line[numberRange])) + "."
      body.append(
        "<p class=\"list-item\"><span class=\"marker\">\(marker)</span> \(renderInlineMarkdown(String(line[itemRange])))</p>"
      )
      previousListItem = true
      continue
    }

    if let match = unorderedListPattern.firstMatch(in: line, range: lineRange),
       let itemRange = Range(match.range(at: 1), in: line) {
      flushParagraph()
      body.append("<p class=\"list-item\"><span class=\"marker\">&bull;</span> \(renderInlineMarkdown(String(line[itemRange])))</p>")
      previousListItem = true
      continue
    }

    if previousListItem && rawLine.hasPrefix("   ") {
      body.append("<p class=\"list-continuation\">\(renderInlineMarkdown(line))</p>")
    } else {
      paragraph.append(line)
      previousListItem = false
    }
  }

  if inCodeBlock {
    flushCodeBlock()
  }
  flushParagraph()

  return """
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <style>
      body {
        background: #ffffff;
        color: #111111;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        font-size: 10pt;
        line-height: 1.42;
      }
      h1 {
        color: #111111;
        font-size: 25pt;
        margin: 0 0 5pt 0;
      }
      h2 {
        color: #111111;
        font-size: 17pt;
        margin: 0 0 5pt 0;
      }
      .section-spacer {
        color: #ffffff;
        font-size: 10pt;
        margin: 0;
      }
      .heading-rule {
        color: #d8dee4;
        font-family: Menlo, Monaco, monospace;
        font-size: 6pt;
        line-height: 0.55;
        margin: 0 0 7pt 0;
      }
      p {
        margin: 0 0 9pt 0;
      }
      .list-item {
        margin: 0 0 5pt 0;
        padding-left: 24pt;
        text-indent: -24pt;
      }
      .marker {
        display: inline-block;
        min-width: 20pt;
      }
      .list-continuation {
        margin-left: 24pt;
      }
      code {
        background: #eef2f6;
        border-radius: 4pt;
        color: #24292f;
        font-family: Menlo, Monaco, monospace;
        font-size: 9.5pt;
        padding: 1.5pt 3pt;
      }
      pre {
        background: #f6f8fa;
        border: 1px solid #d0d7de;
        border-radius: 5pt;
        color: #24292f;
        margin: 0 0 10pt 0;
        padding: 8pt;
      }
      pre code {
        background: transparent;
        border-radius: 0;
        padding: 0;
      }
    </style>
  </head>
  <body>
  \(body.joined(separator: "\n"))
  </body>
  </html>
  """
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  fail("Usage: scripts/ios-app-review-notes-pdf.swift <APP-REVIEW-NOTES.md> <output.pdf>")
}

let sourceURL = absoluteFileURL(arguments[1])
let outputURL = absoluteFileURL(arguments[2])

guard FileManager.default.fileExists(atPath: sourceURL.path) else {
  fail("Missing App Review notes Markdown: \(sourceURL.path)")
}

let markdown: String
do {
  markdown = try String(contentsOf: sourceURL, encoding: .utf8)
} catch {
  fail("Failed to read \(sourceURL.path): \(error)")
}

let htmlData = Data(markdownToHTML(markdown).utf8)
let attributed: NSAttributedString
do {
  attributed = try NSAttributedString(
    data: htmlData,
    options: [
      .documentType: NSAttributedString.DocumentType.html,
      .characterEncoding: String.Encoding.utf8.rawValue
    ],
    documentAttributes: nil
  )
} catch {
  fail("Failed to render App Review notes Markdown as HTML: \(error)")
}

let fileManager = FileManager.default
do {
  try fileManager.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
} catch {
  fail("Failed to create PDF output directory: \(error)")
}

let pageSize = NSSize(width: 612, height: 792)
let margin: CGFloat = 42
let textWidth = pageSize.width - (margin * 2)

let textStorage = NSTextStorage(attributedString: attributed)
let layoutManager = NSLayoutManager()
layoutManager.usesFontLeading = true
textStorage.addLayoutManager(layoutManager)

let contentSize = NSSize(width: textWidth, height: pageSize.height - (margin * 2))
var pageGlyphRanges: [NSRange] = []

while pageGlyphRanges.last.map({ NSMaxRange($0) < layoutManager.numberOfGlyphs }) ?? true {
  let textContainer = NSTextContainer(containerSize: contentSize)
  textContainer.lineFragmentPadding = 0
  layoutManager.addTextContainer(textContainer)
  layoutManager.ensureLayout(for: textContainer)

  let glyphRange = layoutManager.glyphRange(for: textContainer)
  guard glyphRange.length > 0 else {
    break
  }

  pageGlyphRanges.append(glyphRange)
  if pageGlyphRanges.count > 100 {
    fail("Refusing to render more than 100 App Review notes PDF pages.")
  }
}

let pdfData = NSMutableData()
var mediaBox = CGRect(origin: .zero, size: pageSize)
guard let dataConsumer = CGDataConsumer(data: pdfData),
      let pdfContext = CGContext(consumer: dataConsumer, mediaBox: &mediaBox, nil) else {
  fail("Failed to create PDF context: \(outputURL.path)")
}

let pageBackground = CGColor(gray: 1, alpha: 1)

for glyphRange in pageGlyphRanges {
  pdfContext.beginPDFPage(nil)
  pdfContext.setFillColor(pageBackground)
  pdfContext.fill(mediaBox)

  pdfContext.saveGState()
  pdfContext.translateBy(x: 0, y: pageSize.height)
  pdfContext.scaleBy(x: 1, y: -1)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: pdfContext, flipped: true)
  layoutManager.drawBackground(forGlyphRange: glyphRange, at: NSPoint(x: margin, y: margin))
  layoutManager.drawGlyphs(forGlyphRange: glyphRange, at: NSPoint(x: margin, y: margin))
  NSGraphicsContext.restoreGraphicsState()
  pdfContext.restoreGState()

  pdfContext.endPDFPage()
}

pdfContext.closePDF()

do {
  try pdfData.write(to: outputURL, options: .atomic)
} catch {
  fail("Failed to write App Review notes PDF: \(error)")
}

print(outputURL.path)
