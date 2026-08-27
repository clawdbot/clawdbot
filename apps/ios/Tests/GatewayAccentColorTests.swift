import Foundation
import Testing
@testable import OpenClaw

struct GatewayAccentColorTests {
    @Test func normalizesBareAndPrefixedHex() {
        #expect(ColorHexSupport.normalizedHex("#A1B2C3") == "#a1b2c3")
        #expect(ColorHexSupport.normalizedHex("a1b2c3") == "#a1b2c3")
        #expect(ColorHexSupport.normalizedHex("  #ff0000  ") == "#ff0000")
    }

    @Test func rejectsInvalidHex() {
        #expect(ColorHexSupport.normalizedHex(nil) == nil)
        #expect(ColorHexSupport.normalizedHex("") == nil)
        #expect(ColorHexSupport.normalizedHex("#fff") == nil)
        #expect(ColorHexSupport.normalizedHex("#ff0000aa") == nil)
        #expect(ColorHexSupport.normalizedHex("red") == nil)
        #expect(ColorHexSupport.normalizedHex("#12345g") == nil)
        #expect(ColorHexSupport.normalizedHex("+abcde1") == nil)
    }

    @Test func userAccentWinsOverSeamColor() {
        let ui: [String: Any] = [
            "prefs": ["accent": "#123456"],
            "seamColor": "#654321",
        ]
        #expect(ColorHexSupport.gatewayUserAccentHex(configUI: ui) == "#123456")
    }

    @Test func invalidAccentFallsBackToSeamColor() {
        let ui: [String: Any] = [
            "prefs": ["accent": "not-a-color"],
            "seamColor": "#654321",
        ]
        #expect(ColorHexSupport.gatewayUserAccentHex(configUI: ui) == "#654321")
    }

    @Test func missingUIReturnsNil() {
        #expect(ColorHexSupport.gatewayUserAccentHex(configUI: nil) == nil)
        #expect(ColorHexSupport.gatewayUserAccentHex(configUI: [:]) == nil)
    }
}
