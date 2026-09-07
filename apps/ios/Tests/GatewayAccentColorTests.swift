import Testing
@testable import OpenClaw

struct GatewayAccentColorTests {
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
}
