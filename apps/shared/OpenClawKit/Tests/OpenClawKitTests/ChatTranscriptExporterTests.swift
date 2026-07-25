import Testing
@testable import OpenClawChatUI

@Suite("ChatTranscriptExporter")
struct ChatTranscriptExporterTests {
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
