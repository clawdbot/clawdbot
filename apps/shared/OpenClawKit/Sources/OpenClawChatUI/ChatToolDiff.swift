import Foundation
import OpenClawKit

enum ChatToolDiffLineKind: Equatable, Sendable {
    case add
    case del
    case ctx
    case skip
}

struct ChatToolDiffLine: Equatable, Sendable {
    let kind: ChatToolDiffLineKind
    let lineNo: Int?
    let text: String

    init(kind: ChatToolDiffLineKind, lineNo: Int? = nil, text: String) {
        self.kind = kind
        self.lineNo = lineNo
        self.text = text
    }
}

struct ChatToolDiffStat: Equatable, Sendable {
    let added: Int
    let removed: Int
}

enum ChatToolDiff {
    private struct EditPair {
        let oldText: String
        let newText: String
    }

    private struct ParsedDetailsDiff {
        let lines: [ChatToolDiffLine]
        let truncated: Bool
    }

    private static let maxInputLines = 600
    private static let maxRenderLines = 400
    private static let maxLocalPairs = 8
    private static let maxWritePreviewLines = 80
    private static let maxLocalInputCharacters = 120_000

    private static let editToolNames: Set<String> = [
        "edit",
        "edit_file",
        "multiedit",
        "multi_edit",
        "notebookedit",
        "notebook_edit",
    ]
    private static let textEditorToolNames: Set<String> = [
        "str_replace_editor",
        "str_replace_based_edit_tool",
    ]
    private static let writeToolNames: Set<String> = ["write", "write_file", "create_file"]
    private static let patchToolNames: Set<String> = ["apply_patch", "applypatch", "patch"]

    private static func parseDetailsDiffResult(_ diff: String) -> ParsedDetailsDiff? {
        guard !diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }

        var lines: [ChatToolDiffLine] = []
        var truncated = diff.components(separatedBy: "\n").contains { raw in
            raw.trimmingCharacters(in: .whitespacesAndNewlines) == "...(truncated)..."
        }
        for raw in diff.components(separatedBy: "\n") {
            guard !raw.isEmpty else { continue }
            let marker = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let line: ChatToolDiffLine
            if marker == "..." || marker == "...(truncated)..." {
                line = ChatToolDiffLine(kind: .skip, text: "")
            } else {
                guard let numberedLine = self.parseNumberedLine(raw) else { return nil }
                line = numberedLine
            }
            if lines.count >= self.maxRenderLines {
                truncated = true
                if lines.last?.kind != .skip {
                    lines.append(ChatToolDiffLine(kind: .skip, text: ""))
                }
                break
            }
            lines.append(line)
        }

        guard lines.contains(where: { $0.kind == .add || $0.kind == .del }) else { return nil }
        return ParsedDetailsDiff(lines: lines, truncated: truncated)
    }

    static func computeLineDiff(old: String, new: String) -> [ChatToolDiffLine] {
        let allOldLines = self.splitLines(old)
        let allNewLines = self.splitLines(new)
        let inputTruncated = allOldLines.count > self.maxInputLines || allNewLines.count > self.maxInputLines
        let oldLines = Array(allOldLines.prefix(self.maxInputLines))
        let newLines = Array(allNewLines.prefix(self.maxInputLines))
        let oldCount = oldLines.count
        let newCount = newLines.count
        let width = newCount + 1
        var lcs = Array(repeating: 0, count: (oldCount + 1) * width)

        if oldCount > 0, newCount > 0 {
            for oldIndex in stride(from: oldCount - 1, through: 0, by: -1) {
                for newIndex in stride(from: newCount - 1, through: 0, by: -1) {
                    let index = oldIndex * width + newIndex
                    if oldLines[oldIndex] == newLines[newIndex] {
                        lcs[index] = lcs[(oldIndex + 1) * width + newIndex + 1] + 1
                    } else {
                        lcs[index] = max(
                            lcs[(oldIndex + 1) * width + newIndex],
                            lcs[oldIndex * width + newIndex + 1])
                    }
                }
            }
        }

        var lines: [ChatToolDiffLine] = []
        var oldIndex = 0
        var newIndex = 0
        while oldIndex < oldCount, newIndex < newCount {
            if oldLines[oldIndex] == newLines[newIndex] {
                lines.append(ChatToolDiffLine(kind: .ctx, text: oldLines[oldIndex]))
                oldIndex += 1
                newIndex += 1
            } else if lcs[(oldIndex + 1) * width + newIndex] >= lcs[oldIndex * width + newIndex + 1] {
                lines.append(ChatToolDiffLine(kind: .del, text: oldLines[oldIndex]))
                oldIndex += 1
            } else {
                lines.append(ChatToolDiffLine(kind: .add, text: newLines[newIndex]))
                newIndex += 1
            }
        }
        while oldIndex < oldCount {
            lines.append(ChatToolDiffLine(kind: .del, text: oldLines[oldIndex]))
            oldIndex += 1
        }
        while newIndex < newCount {
            lines.append(ChatToolDiffLine(kind: .add, text: newLines[newIndex]))
            newIndex += 1
        }
        return self.compact(lines, inputTruncated: inputTruncated)
    }

    static func resolveDiff(
        name: String?,
        arguments: AnyCodable?,
        details: AnyCodable?) -> (lines: [ChatToolDiffLine], stat: ChatToolDiffStat?)?
    {
        let normalizedName = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let argumentsRecord = arguments?.dictionaryValue
        if self.textEditorToolNames.contains(normalizedName) {
            switch self.string(in: argumentsRecord, keys: ["command"])?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            {
            case "create":
                return self.resolveWriteDiff(
                    argumentsRecord,
                    keys: ["file_text", "content"])
            case "insert":
                return self.resolveInsertionDiff(argumentsRecord, details: details)
            default:
                return self.resolveEditDiff(argumentsRecord, details: details)
            }
        }

        // Plugin tools own their details schema; only edit-family tools may
        // interpret details.diff as a filesystem diff (mirrors the web guard).
        if self.editToolNames.contains(normalizedName) {
            return self.resolveEditDiff(argumentsRecord, details: details)
        }
        if self.writeToolNames.contains(normalizedName) {
            if let detailsDiff = self.resolveDetailsDiff(details) {
                return detailsDiff
            }
            return self.resolveWriteDiff(argumentsRecord, keys: ["content", "text", "file_text"])
        }
        if self.patchToolNames.contains(normalizedName) {
            return self.resolveDetailsDiff(details)
        }
        return nil
    }

    private static func parseNumberedLine(_ raw: String) -> ChatToolDiffLine? {
        guard let sign = raw.first, sign == "+" || sign == "-" || sign == " " else { return nil }
        var remainder = raw.dropFirst()
        while remainder.first?.isWhitespace == true {
            remainder = remainder.dropFirst()
        }
        let digits = remainder.prefix { character in
            character >= "0" && character <= "9"
        }
        guard !digits.isEmpty, let lineNo = Int(digits) else { return nil }
        remainder = remainder.dropFirst(digits.count)
        if remainder.first == " " {
            remainder = remainder.dropFirst()
        }
        let kind: ChatToolDiffLineKind = switch sign {
        case "+": .add
        case "-": .del
        default: .ctx
        }
        return ChatToolDiffLine(kind: kind, lineNo: lineNo, text: String(remainder))
    }

    private static func splitLines(_ text: String) -> [String] {
        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        guard !normalized.isEmpty else { return [] }
        var lines = normalized.components(separatedBy: "\n")
        if lines.count > 1, lines.last?.isEmpty == true {
            lines.removeLast()
        }
        return lines
    }

    private static func compact(
        _ lines: [ChatToolDiffLine],
        inputTruncated: Bool) -> [ChatToolDiffLine]
    {
        if lines.count <= self.maxRenderLines, !inputTruncated {
            return lines
        }
        let hasChange = lines.contains { $0.kind == .add || $0.kind == .del }
        guard hasChange else {
            return inputTruncated
                ? [ChatToolDiffLine(kind: .skip, text: "")]
                : Array(lines.prefix(self.maxRenderLines)) + [ChatToolDiffLine(kind: .skip, text: "")]
        }

        var keep = Array(repeating: false, count: lines.count)
        for index in lines.indices where lines[index].kind == .add || lines[index].kind == .del {
            let start = max(0, index - 3)
            let end = min(lines.count, index + 4)
            for contextIndex in start..<end {
                keep[contextIndex] = true
            }
        }

        var preview: [ChatToolDiffLine] = []
        var gap = false
        var clipped = inputTruncated
        for index in lines.indices {
            guard keep[index] else {
                gap = true
                clipped = true
                continue
            }
            if gap, preview.last?.kind != .skip {
                preview.append(ChatToolDiffLine(kind: .skip, text: ""))
            }
            gap = false
            if preview.count >= self.maxRenderLines {
                clipped = true
                break
            }
            preview.append(lines[index])
        }
        if clipped, preview.last?.kind != .skip {
            preview.append(ChatToolDiffLine(kind: .skip, text: ""))
        }
        return preview
    }

    private static func resolveDetailsDiff(
        _ details: AnyCodable?) -> (lines: [ChatToolDiffLine], stat: ChatToolDiffStat?)?
    {
        guard let diff = details?.dictionaryValue?["diff"]?.stringValue,
              !diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let parsed = self.parseDetailsDiffResult(diff)
        else {
            return nil
        }
        // Only explicit truncation or the render cap makes a persisted stat incomplete.
        return (parsed.lines, parsed.truncated ? nil : self.stat(for: parsed.lines))
    }

    private static func resolveInsertionDiff(
        _ arguments: [String: AnyCodable]?,
        details: AnyCodable?) -> (lines: [ChatToolDiffLine], stat: ChatToolDiffStat?)?
    {
        if let detailsDiff = self.resolveDetailsDiff(details) {
            return detailsDiff
        }
        guard let insertText = self.string(in: arguments, keys: ["insert_text"]) else { return nil }
        let lines = self.computeLineDiff(old: "", new: insertText)
        // The inserted text is known, but its final placement is not, so keep the stat absent.
        return lines.isEmpty ? nil : (lines, nil)
    }

    private static func resolveWriteDiff(
        _ arguments: [String: AnyCodable]?,
        keys: [String]) -> (lines: [ChatToolDiffLine], stat: ChatToolDiffStat?)?
    {
        guard let content = self.string(in: arguments, keys: keys) else { return nil }
        let allLines = self.splitLines(content)
        guard !allLines.isEmpty else { return nil }
        // Written content is fully known, so number additions from line 1 and
        // keep the exact stat even when the rendered preview is clipped.
        var lines: [ChatToolDiffLine] = []
        var remainingCharacters = self.maxLocalInputCharacters
        for (index, text) in allLines.prefix(self.maxWritePreviewLines).enumerated() {
            let lineCharacters = text.utf16.count
            guard lineCharacters <= remainingCharacters else { break }
            remainingCharacters -= lineCharacters
            lines.append(ChatToolDiffLine(kind: .add, lineNo: index + 1, text: text))
        }
        if lines.count < allLines.count {
            lines.append(ChatToolDiffLine(kind: .skip, text: ""))
        }
        return (lines, ChatToolDiffStat(added: allLines.count, removed: 0))
    }

    private static func resolveEditDiff(
        _ arguments: [String: AnyCodable]?,
        details: AnyCodable?) -> (lines: [ChatToolDiffLine], stat: ChatToolDiffStat?)?
    {
        // Persisted details are authoritative; args are a local fallback for live/foreign harnesses.
        if let detailsDiff = self.resolveDetailsDiff(details) {
            return detailsDiff
        }
        guard let arguments else { return nil }
        let resolved = self.readEditPairs(arguments)
        guard !resolved.pairs.isEmpty else {
            return resolved.truncated
                ? ([ChatToolDiffLine(kind: .skip, text: "")], nil)
                : nil
        }

        let sections = resolved.pairs.map { pair in
            self.computeLineDiff(old: pair.oldText, new: pair.newText)
        }
        let sectionTruncated = sections.contains { section in
            section.contains(where: { $0.kind == .skip })
        }
        let joined = self.join(sections, truncated: resolved.truncated)
        guard !joined.lines.isEmpty else { return nil }
        let truncated = resolved.truncated || sectionTruncated || joined.truncated
        let stat = truncated ? nil : sections.reduce(ChatToolDiffStat(added: 0, removed: 0)) { sum, section in
            let sectionStat = self.stat(for: section)
            return ChatToolDiffStat(
                added: sum.added + sectionStat.added,
                removed: sum.removed + sectionStat.removed)
        }
        return (joined.lines, stat)
    }

    private static func readEditPairs(
        _ arguments: [String: AnyCodable]) -> (pairs: [EditPair], truncated: Bool)
    {
        var pairs: [EditPair] = []
        var inputCharacters = 0
        var truncated = false

        func appendPair(oldValue: AnyCodable?, newValue: AnyCodable?) {
            guard let oldText = oldValue?.stringValue, let newText = newValue?.stringValue else { return }
            let pairCharacters = oldText.utf16.count + newText.utf16.count
            guard pairCharacters <= self.maxLocalInputCharacters - inputCharacters else {
                truncated = true
                return
            }
            inputCharacters += pairCharacters
            pairs.append(EditPair(oldText: oldText, newText: newText))
        }

        if let edits = arguments["edits"]?.arrayValue {
            for (index, edit) in edits.enumerated() {
                guard index < self.maxLocalPairs else {
                    truncated = true
                    break
                }
                guard let record = edit.dictionaryValue else { continue }
                appendPair(
                    oldValue: self.firstValue(in: record, keys: ["oldText", "old_string", "oldString", "old_str"]),
                    newValue: self.firstValue(in: record, keys: ["newText", "new_string", "newString", "new_str"]))
                if truncated { break }
            }
        } else {
            appendPair(
                oldValue: self.firstValue(
                    in: arguments,
                    keys: ["oldText", "old_string", "oldString", "old_str"]),
                newValue: self.firstValue(
                    in: arguments,
                    keys: ["newText", "new_string", "newString", "new_str"]))
        }
        return (pairs, truncated)
    }

    private static func join(
        _ sections: [[ChatToolDiffLine]],
        truncated initialTruncated: Bool) -> (lines: [ChatToolDiffLine], truncated: Bool)
    {
        var joined: [ChatToolDiffLine] = []
        var truncated = initialTruncated
        for section in sections where !section.isEmpty {
            if !joined.isEmpty {
                guard joined.count < self.maxRenderLines else {
                    truncated = true
                    break
                }
                joined.append(ChatToolDiffLine(kind: .skip, text: ""))
            }
            let remaining = self.maxRenderLines - joined.count
            guard section.count <= remaining else {
                joined.append(contentsOf: section.prefix(remaining))
                truncated = true
                break
            }
            joined.append(contentsOf: section)
        }
        if truncated, joined.last?.kind != .skip {
            joined.append(ChatToolDiffLine(kind: .skip, text: ""))
        }
        return (joined, truncated)
    }

    private static func stat(for lines: [ChatToolDiffLine]) -> ChatToolDiffStat {
        lines.reduce(ChatToolDiffStat(added: 0, removed: 0)) { stat, line in
            switch line.kind {
            case .add:
                ChatToolDiffStat(added: stat.added + 1, removed: stat.removed)
            case .del:
                ChatToolDiffStat(added: stat.added, removed: stat.removed + 1)
            case .ctx, .skip:
                stat
            }
        }
    }

    private static func string(in record: [String: AnyCodable]?, keys: [String]) -> String? {
        guard let record else { return nil }
        return self.firstValue(in: record, keys: keys)?.stringValue
    }

    private static func firstValue(in record: [String: AnyCodable], keys: [String]) -> AnyCodable? {
        for key in keys {
            if let value = record[key] {
                return value
            }
        }
        return nil
    }
}
