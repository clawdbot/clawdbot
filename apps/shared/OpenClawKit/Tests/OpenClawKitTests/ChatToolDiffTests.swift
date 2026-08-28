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

    @Test func `write created flags control fallback stats`() throws {
        let arguments = AnyCodable(["content": "one\ntwo\n"])
        let created = try #require(ChatToolDiff.resolveDiff(
            name: "write",
            arguments: arguments,
            details: AnyCodable(["created": true])))
        let overwritten = try #require(ChatToolDiff.resolveDiff(
            name: "write",
            arguments: arguments,
            details: AnyCodable(["created": false])))
        let unknown = try #require(ChatToolDiff.resolveDiff(
            name: "write",
            arguments: arguments,
            details: AnyCodable(["changed": true])))

        #expect(created.stat == ChatToolDiffStat(added: 2, removed: 0))
        #expect(overwritten.lines == created.lines)
        #expect(overwritten.stat == nil)
        #expect(unknown.lines == created.lines)
        #expect(unknown.stat == nil)
        #expect(ChatToolDiff.resolveDiff(
            name: "write",
            arguments: arguments,
            details: AnyCodable(["changed": false])) == nil)
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

        let overwrittenCreate = try #require(ChatToolDiff.resolveDiff(
            name: "str_replace_editor",
            arguments: AnyCodable(["command": "create", "file_text": "replacement"]),
            details: AnyCodable(["created": false])))
        #expect(overwrittenCreate.stat == nil)
        #expect(ChatToolDiff.resolveDiff(
            name: "str_replace_editor",
            arguments: AnyCodable(["command": "create", "file_text": "unchanged"]),
            details: AnyCodable(["changed": false])) == nil)

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

    @Test func `move only patches render the file header`() throws {
        let patch = "*** Begin Patch\n*** Update File: a/old.txt\n*** Move to: a/new.txt\n*** End Patch"
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "apply_patch",
            arguments: AnyCodable(["input": AnyCodable(patch)]),
            details: nil))
        #expect(resolved.lines == [ChatToolDiffLine(kind: .file, text: "Move a/old.txt → a/new.txt")])
        #expect(resolved.stat == nil)
    }

    @Test func `patch tools resolve persisted details`() throws {
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "apply_patch",
            arguments: nil,
            details: AnyCodable(["diff": AnyCodable("+1 added\n-1 removed")])))
        #expect(resolved.stat == ChatToolDiffStat(added: 1, removed: 1))
    }

    @Test func `parses numbered update patch envelopes from every argument spelling`() throws {
        let patch = [
            "*** Begin Patch",
            "*** Update File: src/a.swift",
            "@@ -4,2 +4,2 @@",
            " context",
            "-old",
            "+new",
            "*** End Patch",
        ].joined(separator: "\n")

        for key in ["patch", "input", "diff"] {
            let resolved = try #require(ChatToolDiff.resolveDiff(
                name: "apply_patch",
                arguments: AnyCodable([key: AnyCodable(patch)]),
                details: nil))
            #expect(resolved.lines == [
                ChatToolDiffLine(kind: .ctx, lineNo: 4, text: "context"),
                ChatToolDiffLine(kind: .del, lineNo: 5, text: "old"),
                ChatToolDiffLine(kind: .add, lineNo: 5, text: "new"),
            ])
            #expect(resolved.stat == ChatToolDiffStat(added: 1, removed: 1))
        }
    }

    @Test func `patch envelope precedence matches transcript caching`() throws {
        let input = "*** Begin Patch\n*** Add File: input.txt\n+input\n*** End Patch"
        let patch = "*** Begin Patch\n*** Add File: patch.txt\n+patch\n*** End Patch"
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "apply_patch",
            arguments: AnyCodable([
                "input": AnyCodable(input),
                "patch": AnyCodable(patch),
            ]),
            details: nil))

        #expect(resolved.lines.first == ChatToolDiffLine(kind: .add, lineNo: 1, text: "input"))
    }

    @Test func `separates add delete and move patch files`() throws {
        let patch = [
            "*** Begin Patch",
            "*** Update File: src/old.swift",
            "*** Move to: src/new.swift",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "*** Add File: src/added.swift",
            "+added",
            "*** Delete File: src/deleted.swift",
            "-deleted",
            "*** End Patch",
        ].joined(separator: "\n")
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "applypatch",
            arguments: AnyCodable(["input": AnyCodable(patch)]),
            details: nil))

        #expect(resolved.lines == [
            ChatToolDiffLine(kind: .file, text: "Move src/old.swift → src/new.swift"),
            ChatToolDiffLine(kind: .del, lineNo: 1, text: "old"),
            ChatToolDiffLine(kind: .add, lineNo: 1, text: "new"),
            ChatToolDiffLine(kind: .skip, text: ""),
            ChatToolDiffLine(kind: .file, text: "Add src/added.swift"),
            ChatToolDiffLine(kind: .add, lineNo: 1, text: "added"),
            ChatToolDiffLine(kind: .skip, text: ""),
            ChatToolDiffLine(kind: .file, text: "Delete src/deleted.swift"),
            ChatToolDiffLine(kind: .del, lineNo: 1, text: "deleted"),
        ])
        #expect(resolved.stat == ChatToolDiffStat(added: 2, removed: 2))
    }

    @Test func `rejects malformed patch envelopes`() {
        for patch in [
            "*** Begin Patch\nnot a file\n*** End Patch",
            "*** Update File: \n+orphaned",
            "*** Add File: empty.swift\n*** End Patch",
        ] {
            #expect(ChatToolDiff.resolveDiff(
                name: "patch",
                arguments: AnyCodable(["patch": AnyCodable(patch)]),
                details: nil) == nil)
        }
    }

    @Test func `renders header only deletes without an exact stat`() throws {
        let deleted = try #require(ChatToolDiff.resolveDiff(
            name: "apply_patch",
            arguments: AnyCodable(["patch": AnyCodable("*** Delete File: obsolete.swift")]),
            details: nil))
        #expect(deleted.lines == [ChatToolDiffLine(kind: .file, text: "Delete obsolete.swift")])
        #expect(deleted.stat == nil)

        let multi = try #require(ChatToolDiff.resolveDiff(
            name: "apply_patch",
            arguments: AnyCodable(["patch": AnyCodable(
                "*** Add File: added.swift\n+new\n*** Delete File: obsolete.swift")]),
            details: nil))
        #expect(multi.lines.last == ChatToolDiffLine(kind: .file, text: "Delete obsolete.swift"))
        #expect(multi.stat == nil)
    }

    @Test func `caps patch rows and omits a partial stat`() throws {
        let patch = (["*** Begin Patch", "*** Update File: big.swift"] +
            (0..<450).map { "+line \($0)" } + ["*** End Patch"])
            .joined(separator: "\n")
        let resolved = try #require(ChatToolDiff.resolveDiff(
            name: "apply_patch",
            arguments: AnyCodable(["patch": AnyCodable(patch)]),
            details: nil))

        #expect(resolved.lines.count == 401)
        #expect(resolved.lines.last == ChatToolDiffLine(kind: .skip, text: ""))
        #expect(resolved.stat == nil)
    }

    @Test func `failed edits suppress argument proposals but keep applied details`() throws {
        #expect(ChatToolDiff.resolveDiff(
            name: "edit",
            arguments: AnyCodable(["oldText": "old", "newText": "new"]),
            details: nil,
            isError: true) == nil)

        let details = try #require(ChatToolDiff.resolveDiff(
            name: "edit",
            arguments: AnyCodable(["oldText": "arg old", "newText": "arg new"]),
            details: AnyCodable(["diff": AnyCodable("-1 applied old\n+1 applied new")]),
            isError: true))
        #expect(details.lines == [
            ChatToolDiffLine(kind: .del, lineNo: 1, text: "applied old"),
            ChatToolDiffLine(kind: .add, lineNo: 1, text: "applied new"),
        ])
        #expect(details.stat == ChatToolDiffStat(added: 1, removed: 1))
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

    @Test func `message and content decode snake case errors and encode canonically`() throws {
        let data = Data(#"{"role":"toolResult","is_error":true,"content":[{"type":"tool_result","is_error":true}]}"#
            .utf8)
        let decoded = try JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        let encoded = try JSONEncoder().encode(decoded)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let content = try #require((object["content"] as? [[String: Any]])?.first)

        #expect(decoded.isError == true)
        #expect(decoded.content.first?.isError == true)
        #expect(object["isError"] as? Bool == true)
        #expect(object["is_error"] == nil)
        #expect(content["isError"] as? Bool == true)
        #expect(content["is_error"] == nil)
    }
}
