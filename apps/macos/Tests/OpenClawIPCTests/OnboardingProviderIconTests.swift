import AppKit
import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingProviderIconTests {
    @Test func `provider aliases resolve to bundled artwork`() throws {
        let aliases = [
            ("claude", ["claude-cli", "claude-code", "anthropic"]),
            ("codex", ["codex-cli", "openai"]),
            ("kimi", ["kimi-code"]),
            ("xai", ["grok-build", "xai"]),
        ]
        for (brand, candidates) in aliases {
            let expected = try #require(OnboardingProviderIcon.resourceURL(for: brand))
            for candidate in candidates {
                #expect(OnboardingProviderIcon.resourceURL(for: candidate) == expected)
            }
        }
        #expect(OnboardingProviderIcon.resourceURL(for: "Ollama") ==
            OnboardingProviderIcon.resourceURL(for: "ollama"))
        // Composed choice ids resolve via their leading brand token.
        #expect(OnboardingProviderIcon.resourceURL(for: "xai-oauth") ==
            OnboardingProviderIcon.resourceURL(for: "xai"))
        #expect(OnboardingProviderIcon.resourceURL(for: "anthropic-vertex") ==
            OnboardingProviderIcon.resourceURL(for: "claude"))
        #expect(OnboardingProviderIcon.resourceURL(for: "unknown") == nil)
        #expect(OnboardingProviderIcon.resourceURL(for: "unknown-oauth") == nil)
    }

    @Test func `every mapped brand has decodable vector artwork`() throws {
        for brand in ["claude", "codex", "gemini", "ollama", "lmstudio", "pi", "opencode", "kimi", "xai"] {
            let url = try #require(OnboardingProviderIcon.resourceURL(for: brand))
            #expect(url.pathExtension == "svg")
            #expect(try #require(OnboardingProviderIcon.image(for: brand)).isTemplate)
        }
    }

    @Test func `remote artwork distinguishes vector and raster payloads`() throws {
        // Leading whitespace exercises the sniffer; an XML declaration after
        // whitespace would be invalid XML, so the fixture uses a bare root.
        let svg = Data(
            "  \n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><path d=\"M0 0h1v1H0z\"/></svg>"
                .utf8)
        let vector = try #require(OnboardingRemoteProviderIcon.decode(svg))
        #expect(vector.isVector)
        #expect(vector.nsImage.isTemplate)

        // Bundled assets lead with a license comment; the sniffer must scan the
        // prolog instead of expecting <svg> as the first non-whitespace token.
        let commented = try #require(OnboardingProviderIcon.resourceURL(for: "ollama"))
        let commentedData = try Data(contentsOf: commented)
        #expect(String(bytes: commentedData.prefix(4), encoding: .utf8) == "<!--")
        let commentedVector = try #require(OnboardingRemoteProviderIcon.decode(commentedData))
        #expect(commentedVector.isVector)

        let png = try #require(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
        let raster = try #require(OnboardingRemoteProviderIcon.decode(png))
        #expect(!raster.isVector)
        #expect(!raster.nsImage.isTemplate)
    }

    @Test func `provider website host is concise and validated`() {
        #expect(OnboardingProviderAuthLink.displayHost("https://www.kimi.com/code") == "kimi.com")
        #expect(OnboardingProviderAuthLink.displayHost("https://ollama.com/download") == "ollama.com")
        #expect(OnboardingProviderAuthLink.displayHost("not a url") == nil)
        #expect(OnboardingProviderAuthLink.displayHost(nil) == nil)
    }
}
