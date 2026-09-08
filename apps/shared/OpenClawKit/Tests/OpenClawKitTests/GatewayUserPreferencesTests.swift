import Foundation
import OpenClawKit
import Testing

struct GatewayUserPreferencesTests {
    @Test func `normalizes bare and prefixed hex`() {
        #expect(GatewayUserPreferences.normalizedAccentHex("#A1B2C3") == "#a1b2c3")
        #expect(GatewayUserPreferences.normalizedAccentHex("a1b2c3") == "#a1b2c3")
        #expect(GatewayUserPreferences.normalizedAccentHex("  #ff0000  ") == "#ff0000")
    }

    @Test(arguments: [
        nil,
        "",
        "#fff",
        "#ff0000aa",
        "red",
        "#12345g",
        "+abcde1",
        "+12345",
        "-12345",
        "#ＦＦＦＦＦＦ"
    ] as [String?])
    func `rejects invalid hex`(value: String?) {
        #expect(GatewayUserPreferences.normalizedAccentHex(value) == nil)
    }

    @Test func `profile accent reads its entry without rejecting unrelated fields`() throws {
        let response = Data(##"{"status":"ok","entries":{"ui.accent":"#A1B2C3","ui.theme":"dark"},"extra":true}"##.utf8)

        #expect(try GatewayUserPreferences.decodeProfileAccentHex(response) == "#a1b2c3")
    }

    @Test(arguments: [
        #"{"status":"ok"}"#,
        #"{"status":"ok","entries":null}"#,
        #"{"status":"ok","entries":[]}"#,
        #"{"status":"ok","entries":{}}"#,
        #"{"status":"ok","entries":{"ui.accent":"not-a-color"}}"#,
        #"{"status":"ok","entries":{"ui.accent":42}}"#,
        #"{"status":"ok","entries":{"ui.accent":null}}"#,
    ])
    func `profile accent rejects missing or malformed entries`(payload: String) throws {
        #expect(try GatewayUserPreferences.decodeProfileAccentHex(Data(payload.utf8)) == nil)
    }

    @Test(arguments: [
        ##"{"entries":{"ui.accent":"#123456"}}"##,
        ##"{"status":"no_durable_identity","entries":{"ui.accent":"#123456"}}"##,
        ##"{"status":"OK","entries":{"ui.accent":"#123456"}}"##,
        ##"[{"status":"ok","entries":{"ui.accent":"#123456"}}]"##,
    ])
    func `only an ok profile response can supply an accent`(payload: String) throws {
        #expect(try GatewayUserPreferences.decodeProfileAccentHex(Data(payload.utf8)) == nil)
    }

    @Test(arguments: ["", "{"])
    func `malformed JSON preserves the callers error path`(payload: String) {
        #expect(throws: Error.self) {
            try GatewayUserPreferences.decodeProfileAccentHex(Data(payload.utf8))
        }
    }
}
