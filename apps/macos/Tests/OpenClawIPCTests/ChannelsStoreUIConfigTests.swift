import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct ChannelsStoreUIConfigTests {
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
}
