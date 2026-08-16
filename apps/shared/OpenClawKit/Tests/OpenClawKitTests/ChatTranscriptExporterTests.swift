import Foundation
import Testing
@testable import OpenClawChatUI

@Suite("ChatTranscriptExporter")
struct ChatTranscriptExporterTests {
    @Test func `exports system transcript rows without leaking internal prompts`() throws {
        let wire = Data(#"""
        [
          {
            "role": "user",
            "content": [{"type": "text", "text": "[System] Resume the interrupted turn with private context."}],
            "timestamp": 0,
            "provenance": {"kind": "internal_system", "sourceTool": "main_session_restart_recovery"}
          },
          {
            "role": "user",
            "content": [{"type": "text", "text": "[System] Gateway restarted after an update."}],
            "timestamp": 500,
            "provenance": {"kind": "internal_system", "sourceTool": "restart-sentinel"}
          },
          {
            "role": "system",
            "content": [],
            "timestamp": 1000,
            "__openclaw": {"kind": "compaction", "id": "compact-1", "tokensBefore": 25000, "tokensAfter": 12500}
          },
          {
            "role": "system",
            "content": [],
            "timestamp": 2000,
            "__openclaw": {"kind": "reset", "id": "reset-1"}
          },
          {
            "role": "system",
            "content": [{"type": "text", "text": "Unknown marker body"}],
            "timestamp": 3000,
            "__openclaw": {"kind": "future-marker", "id": "future-1"}
          }
        ]
        """#.utf8)
        let messages = try JSONDecoder().decode([OpenClawChatMessage].self, from: wire)

        let markdown = ChatTranscriptExporter.markdown(
            sessionTitle: "System events",
            sessionKey: "agent:main",
            messages: messages)

        #expect(!markdown.contains("private context"))
        #expect(markdown.contains("System · restart recovery"))
        #expect(markdown.contains("[System · gateway restarted] Gateway restarted after an update."))
        #expect(markdown.contains("[Compacted history · saved 12.5k tokens]"))
        #expect(markdown.contains("[Session reset — The earlier conversation was cleared.]"))
        #expect(!markdown.contains("Unknown marker body"))
    }

    @Test func `formats visible messages and attachments`() {
        let messages = [
            self.message(role: "system", text: "Hidden setup", timestamp: 0),
            self.message(role: "user", text: "Hello, 世界 👋", timestamp: 0),
            self.message(
                role: "assistant",
                text: """
                <think>Do not export this reasoning.</think><final>
                | Item | Value |
                | --- | --- |
                | code | `ok` |

                ```swift
                print("hi")
                ```
                </final>
                """,
                timestamp: 1000),
            OpenClawChatMessage(
                role: "user",
                content: [
                    OpenClawChatMessageContent(
                        type: "attachment",
                        text: nil,
                        mimeType: "text/plain",
                        fileName: "résumé.txt",
                        content: nil),
                ],
                timestamp: 2000),
            self.message(role: "assistant", text: "   ", timestamp: 3000),
        ]

        let markdown = ChatTranscriptExporter.markdown(
            sessionTitle: "Project 🐾",
            sessionKey: "agent:main",
            messages: messages)

        #expect(markdown == """
        # Project 🐾

        ### User — 1970-01-01T00:00:00Z

        Hello, 世界 👋

        ### Assistant — 1970-01-01T00:00:01Z

        | Item | Value |
        | --- | --- |
        | code | `ok` |

        ```swift
        print("hi")
        ```

        ### User — 1970-01-01T00:00:02Z

        _[attachment: résumé.txt]_

        """)
    }

    @Test(arguments: [
        "file", "attachment", "image", "audio", "video",
        "FILE", "ATTACHMENT", "IMAGE", "AuDiO", "ViDeO",
    ])
    func `classifies gateway media and historical file attachments consistently`(type: String) {
        let content = OpenClawChatMessageContent(
            type: type,
            text: nil,
            mimeType: nil,
            fileName: nil,
            content: nil)

        #expect(content.isInlineAttachment)
    }

    @Test(arguments: ["text", "canvas", "toolCall", "tool_result"])
    func `does not classify unrelated content as an attachment`(type: String) {
        let content = OpenClawChatMessageContent(
            type: type,
            text: nil,
            mimeType: "image/png",
            fileName: "not-an-attachment.png",
            content: nil)

        #expect(!content.isInlineAttachment)
    }

    @Test func `does not classify content without a type as an attachment`() {
        let content = OpenClawChatMessageContent(
            type: nil,
            text: nil,
            mimeType: "image/png",
            fileName: "not-an-attachment.png",
            content: nil)

        #expect(!content.isInlineAttachment)
    }

    @Test(arguments: ["user", "assistant"], ["image", "audio", "video", "IMAGE", "AuDiO", "ViDeO"])
    func `exports canonical media-only messages`(role: String, type: String) {
        let isAudio = type.lowercased() == "audio"
        let isVideo = type.lowercased() == "video"
        let filename = isAudio ? "voice-note.m4a" : isVideo ? "clip.mp4" : "photo.png"
        let message = OpenClawChatMessage(
            role: role,
            content: [
                OpenClawChatMessageContent(
                    type: type,
                    text: nil,
                    mimeType: isAudio ? "audio/mp4" : isVideo ? "video/mp4" : "image/png",
                    fileName: filename,
                    content: nil),
            ],
            timestamp: 0)

        let markdown = ChatTranscriptExporter.markdown(
            sessionTitle: "Media chat",
            sessionKey: "agent:main",
            messages: [message])

        #expect(markdown == """
        # Media chat

        ### \(role == "user" ? "User" : "Assistant") — 1970-01-01T00:00:00Z

        _[attachment: \(filename)]_

        """)
    }

    @Test(arguments: ["image", "audio", "IMAGE", "AuDiO"])
    func `preserves canonical media alongside message text`(type: String) {
        let isAudio = type.lowercased() == "audio"
        let filename = isAudio ? "voice-note.m4a" : "photo.png"
        let message = OpenClawChatMessage(
            role: "user",
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: "Here is the attachment.",
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
                OpenClawChatMessageContent(
                    type: type,
                    text: nil,
                    mimeType: isAudio ? "audio/mp4" : "image/png",
                    fileName: filename,
                    content: nil),
            ],
            timestamp: 0)

        let markdown = ChatTranscriptExporter.markdown(
            sessionTitle: "Media chat",
            sessionKey: "agent:main",
            messages: [message])

        #expect(markdown == """
        # Media chat

        ### User — 1970-01-01T00:00:00Z

        Here is the attachment.

        _[attachment: \(filename)]_

        """)
    }

    @Test(arguments: ["canvas", "toolCall", "tool_result"])
    func `does not export non-attachment content as media`(type: String) {
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [
                OpenClawChatMessageContent(
                    type: type,
                    text: nil,
                    mimeType: "image/png",
                    fileName: "not-an-attachment.png",
                    content: nil),
            ],
            timestamp: 0)

        #expect(ChatTranscriptExporter.markdown(
            sessionTitle: "Media chat",
            sessionKey: "agent:main",
            messages: [message]) == "# Media chat\n")
    }

    @Test func `sanitizes filename`() {
        #expect(
            ChatTranscriptExporter.filename(
                sessionTitle: "  Project / Q3: \"Résumé\"?  ",
                sessionKey: "fallback") == "Project-Q3-Résumé.md")
        #expect(
            ChatTranscriptExporter.filename(
                sessionTitle: "///",
                sessionKey: "fallback") == "fallback.md")

        let emojiFilename = ChatTranscriptExporter.filename(
            sessionTitle: String(repeating: "🐾", count: 200),
            sessionKey: "fallback")
        #expect(emojiFilename.utf8.count <= 243)
        #expect(emojiFilename.hasSuffix(".md"))
    }

    @Test func `empty transcript contains header only`() {
        #expect(
            ChatTranscriptExporter.markdown(
                sessionTitle: nil,
                sessionKey: "agent:main",
                messages: []) == "# agent:main\n")
    }

    private func message(role: String, text: String, timestamp: Double) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: role,
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: text,
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
            ],
            timestamp: timestamp)
    }
}
