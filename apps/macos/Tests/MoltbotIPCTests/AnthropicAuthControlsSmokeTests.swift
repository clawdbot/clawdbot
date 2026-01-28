import Testing
@testable import Moltbot

@Suite(.serialized)
@MainActor
struct AnthropicAuthControlsSmokeTests {
    @Test func anthropicAuthControlsBuildsBodyLocal() {
        let pkce = AnthropicOAuth.PKCE(verifier: "verifier", challenge: "challenge")
        let view = AnthropicAuthControls(
            connectionMode: .local,
            oauthStatus: .connected(expiresAtMs: 1_700_000_000_000),
            pkce: pkce,
            code: "code#state",
            statusText: "Detected code",
            autoDetectClipboard: false,
            autoConnectClipboard: false)
        _ = view.body
    }

    @Test func anthropicAuthControlsBuildsBodyRemote() {
        let view = AnthropicAuthControls(
            connectionMode: .remote,
            oauthStatus: .missingFile,
            pkce: nil,
            code: "",
            statusText: nil)
        _ = view.body
    }
}
