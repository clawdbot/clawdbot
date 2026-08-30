import Testing
@testable import OpenClawChatUI

@Suite("ToolResultTextFormatter")
struct ToolResultTextFormatterTests {
    @Test func leavesPlainTextUntouched() {
        let result = ToolResultTextFormatter.format(text: "All good", toolName: "nodes")
        #expect(result == "All good")
    }

    @Test func summarizesNodesListJSON() {
        let json = """
        {
          "ts": 1771610031380,
          "nodes": [
            {
              "displayName": "iPhone 16 Pro Max",
              "connected": true,
              "platform": "ios"
            }
          ]
        }
        """

        let result = ToolResultTextFormatter.format(text: json, toolName: "nodes")
        #expect(result.contains("1 node found."))
        #expect(result.contains("iPhone 16 Pro Max"))
        #expect(result.contains("connected"))
    }

    @Test func summarizesErrorJSONAndDropsAgentPrefix() {
        let json = """
        {
          "status": "error",
          "tool": "nodes",
          "error": "agent=main node=iPhone gateway=default action=invoke: pairing required"
        }
        """

        let result = ToolResultTextFormatter.format(text: json, toolName: "nodes")
        #expect(result == "Error: pairing required")
    }

    @Test func suppressesUnknownStructuredPayload() {
        let json = """
        {
          "foo": "bar"
        }
        """

        let result = ToolResultTextFormatter.format(text: json, toolName: "nodes")
        #expect(result.isEmpty)
    }
}
