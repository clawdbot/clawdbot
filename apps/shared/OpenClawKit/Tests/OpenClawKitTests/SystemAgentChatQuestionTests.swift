import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing

struct SystemAgentChatQuestionTests {
    @Test
    func `valid gateway question keeps display and reply fields`() throws {
        let decoded = try Self.parse(
            """
            {
              "id": " onboarding-next-step ",
              "header": " Next step ",
              "question": " What would you like to do first? ",
              "options": [
                {
                  "label": " Talk to my agent ",
                  "reply": " talk to agent ",
                  "recommended": true
                },
                {
                  "label": "Connect WhatsApp",
                  "reply": "connect whatsapp",
                  "description": " Chat there. "
                }
              ],
              "isOther": true
            }
            """)
        let parsed = try #require(decoded)

        #expect(parsed.id == "onboarding-next-step")
        #expect(parsed.header == "Next step")
        #expect(parsed.question == "What would you like to do first?")
        #expect(parsed.isOther)
        #expect(parsed.options.count == 2)
        #expect(parsed.options[0].label == "Talk to my agent")
        #expect(parsed.options[0].reply == "talk to agent")
        #expect(parsed.options[0].recommended)
        #expect(parsed.options[1].description == "Chat there.")
        #expect(!parsed.options[1].recommended)
    }

    @Test
    func `optional malformed metadata is ignored`() throws {
        let decoded = try Self.parse(
            """
            {
              "id": "channel",
              "header": "Channel",
              "question": "Which channel?",
              "options": [
                {"label": "WhatsApp", "description": 42, "reply": "   ", "recommended": "yes"},
                {"label": "Telegram"}
              ],
              "isOther": "yes"
            }
            """)
        let parsed = try #require(decoded)

        #expect(parsed.options[0].description == nil)
        #expect(parsed.options[0].reply == nil)
        #expect(!parsed.options[0].recommended)
        #expect(!parsed.isOther)
    }

    @Test
    func `malformed gateway questions degrade to nil`() throws {
        let malformedQuestions = [
            #"{"id":"one","header":"H","question":"Q","options":[{"label":"Only"}]}"#,
            """
            {"id":"five","header":"H","question":"Q","options":\
            [{"label":"A"},{"label":"B"},{"label":"C"},{"label":"D"},{"label":"E"}]}
            """,
            #"{"id":"dupes","header":"H","question":"Q","options":[{"label":"Same"},{"label":"same"}]}"#,
            """
            {"id":"recommended","header":"H","question":"Q","options":\
            [{"label":"A","recommended":true},{"label":"B","recommended":true}]}
            """,
            #"{"id":"blank","header":"H","question":"Q","options":[{"label":"A"},{"label":"   "}]}"#,
            #"{"id":"missing-header","question":"Q","options":[{"label":"A"},{"label":"B"}]}"#,
            #"{"id":"bad-option","header":"H","question":"Q","options":[{"label":"A"},"B"]}"#,
        ]

        for json in malformedQuestions {
            #expect(try Self.parse(json) == nil)
        }
    }

    private static func parse(_ questionJSON: String) throws -> SystemAgentChatQuestion? {
        let result = try JSONDecoder().decode(
            SystemAgentChatResult.self,
            from: Data(
                """
                {
                  "sessionId": "test-session",
                  "reply": "The prose reply stands alone.",
                  "action": "none",
                  "question": \(questionJSON)
                }
                """.utf8))
        return SystemAgentChatQuestion.parse(result.question)
    }
}
