import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@Suite("ChatToolDiff")
struct ChatToolDiffTests {
    private func parsedLines(_ diff: String) -> [ChatToolDiffLine]? {
        ChatToolDiff.resolveDiff(
            name: "edit",
            arguments: nil,
            details: AnyCodable(["diff": AnyCodable(diff)]))?.lines
    }

    @Test func `parses numbered details diffs`() {
        let parsed = self.parsedLines(" 455 before\n-456 old\n+456 new")

        #expect(parsed == [
            ChatToolDiffLine(kind: .ctx, lineNo: 455, text: "before"),
            ChatToolDiffLine(kind: .del, lineNo: 456, text: "old"),
            ChatToolDiffLine(kind: .add, lineNo: 456, text: "new"),
        ])
    }

    @Test func `parses skip markers`() {
        let cases = ["+1 kept\n...", "+1 kept\n...(truncated)..."]
        for diff in cases {
            #expect(self.parsedLines(diff) == [
                ChatToolDiffLine(kind: .add, lineNo: 1, text: "kept"),
                ChatToolDiffLine(kind: .skip, text: ""),
            ])
        }
    }

    @Test func `rejects malformed or unchanged details`() {
        for diff in ["raw line", " 1 context\n 2 context"] {
            #expect(self.parsedLines(diff) == nil)
        }
    }

    @Test func `computes basic line diffs`() {
        let cases: [(String, String, [ChatToolDiffLine])] = [
            ("before", "after", [
                ChatToolDiffLine(kind: .del, text: "before"),
                ChatToolDiffLine(kind: .add, text: "after"),
            ]),
            ("same", "same\nadded", [
                ChatToolDiffLine(kind: .ctx, text: "same"),
                ChatToolDiffLine(kind: .add, text: "added"),
            ]),
            ("same\nremoved", "same", [
                ChatToolDiffLine(kind: .ctx, text: "same"),
                ChatToolDiffLine(kind: .del, text: "removed"),
            ]),
            ("", "written", [ChatToolDiffLine(kind: .add, text: "written")]),
        ]
        for (old, new, expected) in cases {
            #expect(ChatToolDiff.computeLineDiff(old: old, new: new) == expected)
        }
    }

    @Test func `trailing newline is not an extra line`() {
        #expect(ChatToolDiff.computeLineDiff(old: "", new: "foo\n") == [
            ChatToolDiffLine(kind: .add, text: "foo"),
        ])
    }

    @Test func `oversized input degrades to a skip`() {
        let text = (0...600).map { "line \($0)" }.joined(separator: "\n")
        #expect(ChatToolDiff.computeLineDiff(old: text, new: text) == [
            ChatToolDiffLine(kind: .skip, text: ""),
        ])
    }

    @Test func `compaction keeps three context lines around a change`() {
        let oldLines = (0..<500).map { "line \($0)" }
        var newLines = oldLines
        newLines[250] = "changed"
        let expected = [
            ChatToolDiffLine(kind: .skip, text: ""),
            ChatToolDiffLine(kind: .ctx, text: "line 247"),
            ChatToolDiffLine(kind: .ctx, text: "line 248"),
            ChatToolDiffLine(kind: .ctx, text: "line 249"),
            ChatToolDiffLine(kind: .del, text: "line 250"),
            ChatToolDiffLine(kind: .add, text: "changed"),
            ChatToolDiffLine(kind: .ctx, text: "line 251"),
            ChatToolDiffLine(kind: .ctx, text: "line 252"),
            ChatToolDiffLine(kind: .ctx, text: "line 253"),
            ChatToolDiffLine(kind: .skip, text: ""),
        ]

        #expect(ChatToolDiff.computeLineDiff(
            old: oldLines.joined(separator: "\n"),
            new: newLines.joined(separator: "\n")) == expected)
    }

    @Test func `details diff wins over argument fallback`() throws {
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "edit",
            arguments: AnyCodable(["oldText": "arg old", "newText": "arg new"]),
            details: AnyCodable(["diff": "-12 detail old\n+12 detail new"])))

        #expect(resolved.lines == [
            ChatToolDiffLine(kind: .del, lineNo: 12, text: "detail old"),
            ChatToolDiffLine(kind: .add, lineNo: 12, text: "detail new"),
        ])
        #expect(resolved.stat == ChatToolDiffStat(added: 1, removed: 1))
    }

    @Test func `bare details skip keeps an exact stat`() throws {
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "edit",
            arguments: nil,
            details: AnyCodable(["diff": "+1 added\n...\n-2 removed"])))

        #expect(resolved.stat == ChatToolDiffStat(added: 1, removed: 1))
    }

    @Test func `reads multi edit pairs`() throws {
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "multiedit",
            arguments: AnyCodable(["edits": [
                ["oldText": "one", "newText": "uno"],
                ["old_string": "two", "new_string": "dos"],
            ]]),
            details: nil))

        #expect(resolved.lines == [
            ChatToolDiffLine(kind: .del, text: "one"),
            ChatToolDiffLine(kind: .add, text: "uno"),
            ChatToolDiffLine(kind: .skip, text: ""),
            ChatToolDiffLine(kind: .del, text: "two"),
            ChatToolDiffLine(kind: .add, text: "dos"),
        ])
        #expect(resolved.stat == ChatToolDiffStat(added: 2, removed: 2))
    }

    @Test func `renders write content as additions`() throws {
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "write_file",
            arguments: AnyCodable(["content": "one\ntwo\n"]),
            details: nil))

        #expect(resolved.lines == [
            ChatToolDiffLine(kind: .add, lineNo: 1, text: "one"),
            ChatToolDiffLine(kind: .add, lineNo: 2, text: "two"),
        ])
        #expect(resolved.stat == ChatToolDiffStat(added: 2, removed: 0))
    }

    @Test func `renders editor create and insert commands`() throws {
        let create = try #require(ChatToolDiff.resolveDiff(
            name: "str_replace_editor",
            arguments: AnyCodable(["command": "create", "file_text": "one\ntwo"]),
            details: nil))
        #expect(create.lines == [
            ChatToolDiffLine(kind: .add, lineNo: 1, text: "one"),
            ChatToolDiffLine(kind: .add, lineNo: 2, text: "two"),
        ])
        #expect(create.stat == ChatToolDiffStat(added: 2, removed: 0))

        let createFallback = try #require(ChatToolDiff.resolveDiff(
            name: "str_replace_editor",
            arguments: AnyCodable(["command": "create", "content": "fallback"]),
            details: nil))
        #expect(createFallback.lines == [ChatToolDiffLine(kind: .add, lineNo: 1, text: "fallback")])
        #expect(createFallback.stat == ChatToolDiffStat(added: 1, removed: 0))

        let insert = try #require(ChatToolDiff.resolveDiff(
            name: "str_replace_based_edit_tool",
            arguments: AnyCodable(["command": "insert", "insert_text": "three"]),
            details: nil))
        #expect(insert.lines == [ChatToolDiffLine(kind: .add, text: "three")])
        #expect(insert.stat == nil)
    }

    @Test func `keeps a full write stat when the preview is clipped`() throws {
        let content = (0...400).map { "line \($0)" }.joined(separator: "\n")
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "write",
            arguments: AnyCodable(["content": content]),
            details: nil))

        #expect(resolved.lines.count == 81)
        #expect(resolved.lines.last == ChatToolDiffLine(kind: .skip, text: ""))
        #expect(resolved.stat == ChatToolDiffStat(added: 401, removed: 0))
    }

    @Test func `unknown tools do not resolve local diffs`() {
        #expect(ChatToolDiff.resolveDiff(
            name: "custom_tool",
            arguments: AnyCodable(["oldText": "old", "newText": "new"]),
            details: nil) == nil)
    }

    @Test func `unknown tools never interpret details as a diff`() {
        #expect(ChatToolDiff.resolveDiff(
            name: "custom_tool",
            arguments: nil,
            details: AnyCodable(["diff": AnyCodable("+1 added\n-1 removed")])) == nil)
    }

    @Test func `patch tools resolve persisted details`() throws {
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "apply_patch",
            arguments: nil,
            details: AnyCodable(["diff": AnyCodable("+1 added\n-1 removed")])))
        #expect(resolved.stat == ChatToolDiffStat(added: 1, removed: 1))
    }

    @Test func `truncated details omit the stat`() throws {
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "edit",
            arguments: nil,
            details: AnyCodable(["diff": "+1 kept\n...(truncated)..."])))

        #expect(resolved.stat == nil)
    }

    @Test func `capped details omit the stat`() throws {
        let diff = (1...401).map { "+\($0) line \($0)" }.joined(separator: "\n")
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "edit",
            arguments: nil,
            details: AnyCodable(["diff": diff])))

        #expect(resolved.lines.count == 401)
        #expect(resolved.lines.last == ChatToolDiffLine(kind: .skip, text: ""))
        #expect(resolved.stat == nil)
    }

    @Test func `message details survive coding roundtrip`() throws {
        let data = Data(#"{"role":"toolResult","content":"done","details":{"diff":"+1 added"}}"#.utf8)
        let decoded = try JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        let roundTripped = try JSONDecoder().decode(
            OpenClawChatMessage.self,
            from: JSONEncoder().encode(decoded))

        #expect(decoded.details == AnyCodable(["diff": AnyCodable("+1 added")]))
        #expect(roundTripped.details == decoded.details)
    }
}
