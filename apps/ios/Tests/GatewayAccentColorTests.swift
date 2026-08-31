import Foundation
import Testing
@testable import OpenClaw

struct GatewayAccentColorTests {
    @Test func `normalizes bare and prefixed hex`() {
        #expect(ColorHexSupport.normalizedHex("#A1B2C3") == "#a1b2c3")
        #expect(ColorHexSupport.normalizedHex("a1b2c3") == "#a1b2c3")
        #expect(ColorHexSupport.normalizedHex("  #ff0000  ") == "#ff0000")
    }

    @Test func `rejects invalid hex`() {
        #expect(ColorHexSupport.normalizedHex(nil) == nil)
        #expect(ColorHexSupport.normalizedHex("") == nil)
        #expect(ColorHexSupport.normalizedHex("#fff") == nil)
        #expect(ColorHexSupport.normalizedHex("#ff0000aa") == nil)
        #expect(ColorHexSupport.normalizedHex("red") == nil)
        #expect(ColorHexSupport.normalizedHex("#12345g") == nil)
        #expect(ColorHexSupport.normalizedHex("+abcde1") == nil)
    }

    @Test func `user accent wins over seam color`() {
        let ui: [String: Any] = [
            "prefs": ["accent": "#123456"],
            "seamColor": "#654321",
        ]
        #expect(ColorHexSupport.gatewayUserAccentHex(configUI: ui) == "#123456")
    }

    @Test func `invalid accent falls back to seam color`() {
        let ui: [String: Any] = [
            "prefs": ["accent": "not-a-color"],
            "seamColor": "#654321",
        ]
        #expect(ColorHexSupport.gatewayUserAccentHex(configUI: ui) == "#654321")
    }

    @Test func `missing UI returns nil`() {
        #expect(ColorHexSupport.gatewayUserAccentHex(configUI: nil) == nil)
        #expect(ColorHexSupport.gatewayUserAccentHex(configUI: [:]) == nil)
    }

    @Test func `profile accent reads ui accent entry`() {
        #expect(ColorHexSupport.profileAccentHex(entries: ["ui.accent": "#A1B2C3"]) == "#a1b2c3")
    }

    @Test func `profile accent rejects missing or malformed entries`() {
        #expect(ColorHexSupport.profileAccentHex(entries: nil) == nil)
        #expect(ColorHexSupport.profileAccentHex(entries: [:]) == nil)
        #expect(ColorHexSupport.profileAccentHex(entries: ["ui.accent": "not-a-color"]) == nil)
        #expect(ColorHexSupport.profileAccentHex(entries: ["ui.accent": 42]) == nil)
    }
}
