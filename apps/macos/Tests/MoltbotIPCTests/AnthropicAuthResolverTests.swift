import Foundation
import Testing
@testable import Moltbot

@Suite
struct AnthropicAuthResolverTests {
    @Test
    func prefersOAuthFileOverEnv() throws {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-oauth-\(UUID().uuidString)", isDirectory: true)
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        let oauthFile = dir.appendingPathComponent("oauth.json")
        let payload = [
            "anthropic": [
                "type": "oauth",
                "refresh": "r1",
                "access": "a1",
                "expires": 1_234_567_890,
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: oauthFile, options: [.atomic])

        let status = MoltbotOAuthStore.anthropicOAuthStatus(at: oauthFile)
        let mode = AnthropicAuthResolver.resolve(environment: [
            "ANTHROPIC_API_KEY": "sk-ant-ignored",
        ], oauthStatus: status)
        #expect(mode == .oauthFile)
    }

    @Test
    func reportsOAuthEnvWhenPresent() {
        let mode = AnthropicAuthResolver.resolve(environment: [
            "ANTHROPIC_OAUTH_TOKEN": "token",
        ], oauthStatus: .missingFile)
        #expect(mode == .oauthEnv)
    }

    @Test
    func reportsAPIKeyEnvWhenPresent() {
        let mode = AnthropicAuthResolver.resolve(environment: [
            "ANTHROPIC_API_KEY": "sk-ant-key",
        ], oauthStatus: .missingFile)
        #expect(mode == .apiKeyEnv)
    }

    @Test
    func reportsMissingWhenNothingConfigured() {
        let mode = AnthropicAuthResolver.resolve(environment: [:], oauthStatus: .missingFile)
        #expect(mode == .missing)
    }
}
