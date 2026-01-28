import Testing
@testable import Moltbot

@Suite
struct AnthropicOAuthCodeStateTests {
    @Test
    func parsesRawToken() {
        let parsed = AnthropicOAuthCodeState.parse(from: "abcDEF1234#stateXYZ9876")
        #expect(parsed == .init(code: "abcDEF1234", state: "stateXYZ9876"))
    }

    @Test
    func parsesBacktickedToken() {
        let parsed = AnthropicOAuthCodeState.parse(from: "`abcDEF1234#stateXYZ9876`")
        #expect(parsed == .init(code: "abcDEF1234", state: "stateXYZ9876"))
    }

    @Test
    func parsesCallbackURL() {
        let raw = "https://console.anthropic.com/oauth/code/callback?code=abcDEF1234&state=stateXYZ9876"
        let parsed = AnthropicOAuthCodeState.parse(from: raw)
        #expect(parsed == .init(code: "abcDEF1234", state: "stateXYZ9876"))
    }

    @Test
    func extractsFromSurroundingText() {
        let raw = "Paste the code#state value: abcDEF1234#stateXYZ9876 then return."
        let parsed = AnthropicOAuthCodeState.parse(from: raw)
        #expect(parsed == .init(code: "abcDEF1234", state: "stateXYZ9876"))
    }
}
