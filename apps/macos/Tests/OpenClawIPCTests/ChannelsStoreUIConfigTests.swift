import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct ChannelsStoreUIConfigTests {
    @Test func `WhatsApp QR login requests select the WhatsApp provider`() {
        let start = whatsappLoginStartParams(force: true)
        let wait = whatsappLoginWaitParams(
            timeoutMs: 120_000,
            currentQrDataUrl: "data:image/png;base64,current",
            sessionKey: "opaque-session")

        #expect(start["channel"]?.value as? String == "whatsapp")
        #expect(wait["channel"]?.value as? String == "whatsapp")
        #expect(wait["sessionKey"]?.value as? String == "opaque-session")

        let legacyWait = whatsappLoginWaitParams(timeoutMs: 120_000, currentQrDataUrl: nil)
        #expect(legacyWait["sessionKey"] == nil)
    }

    @Test func `user accent overrides the operator seam color`() {
        #expect(ChannelsStore.uiAccent(userAccent: " #112233 ", seamColor: "#445566") == "#112233")
    }

    @Test func `empty user accent falls back to the operator seam color`() {
        #expect(ChannelsStore.uiAccent(userAccent: "", seamColor: " #445566 ") == "#445566")
        #expect(ChannelsStore.uiAccent(userAccent: " \n\t ", seamColor: "#445566") == "#445566")
    }

    @Test func `missing accents use the theme default`() {
        #expect(ChannelsStore.uiAccent(userAccent: nil, seamColor: nil) == nil)
        #expect(ChannelsStore.uiAccent(userAccent: "  ", seamColor: " \n ") == nil)
    }

    @Test func `profile accent wins over the gateway seam color`() {
        let store = AppStateStore.shared
        let savedSeam = store.seamColorHex
        let savedProfile = store.profileAccentHex
        defer {
            store.seamColorHex = savedSeam
            store.profileAccentHex = savedProfile
        }
        store.seamColorHex = "#445566"
        store.profileAccentHex = nil
        #expect(store.effectiveAccentHex == "#445566")
        store.profileAccentHex = "#112233"
        #expect(store.effectiveAccentHex == "#112233")
    }

    @Test func `profile accent entries validate strictly`() {
        #expect(ColorHexSupport.profileAccentHex(entries: ["ui.accent": "#A1B2C3"]) == "#a1b2c3")
        #expect(ColorHexSupport.profileAccentHex(entries: ["ui.accent": "not-a-color"]) == nil)
        #expect(ColorHexSupport.profileAccentHex(entries: [:]) == nil)
        #expect(ColorHexSupport.profileAccentHex(entries: nil) == nil)
    }

    @Test func `config snapshots preserve the Control UI user accent`() {
        let previousAccent = AppStateStore.shared.seamColorHex
        defer { AppStateStore.shared.seamColorHex = previousAccent }

        let store = ChannelsStore(isPreview: true)
        store.configSourceKey = "gateway"
        let snapshot = ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: [
                "ui": AnyCodable([
                    "prefs": ["accent": " #112233 "],
                    "seamColor": "#445566",
                ]),
            ],
            issues: nil)

        store.applyConfigSnapshot(snapshot, sourceKey: "gateway", force: true)

        #expect(AppStateStore.shared.seamColorHex == "#112233")
    }

    @Test func `gateway pushes refresh config only when its snapshot may be stale`() {
        let hello = HelloOk(
            type: "hello-ok",
            _protocol: 3,
            server: [:],
            features: [:],
            snapshot: Snapshot(
                presence: [],
                health: [:],
                stateversion: StateVersion(presence: 0, health: 0),
                uptimems: 0),
            auth: [:],
            policy: [:])

        #expect(ChannelsStore.gatewayPushRequestsConfigRefresh(
            .event(EventFrame(type: "event", event: "config.changed"))))
        #expect(ChannelsStore.gatewayPushRequestsConfigRefresh(.snapshot(hello)))
        #expect(ChannelsStore.gatewayPushRequestsConfigRefresh(.seqGap(expected: 1, received: 3)))
        #expect(!ChannelsStore.gatewayPushRequestsConfigRefresh(
            .event(EventFrame(type: "event", event: "presence"))))
    }
}
