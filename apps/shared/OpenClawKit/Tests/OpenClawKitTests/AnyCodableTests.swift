import Foundation
import Testing
import OpenClawProtocol

struct AnyCodableTests {
    @Test
    func roundTripsEpochMillisecondsBeyondInt32() throws {
        let epochMilliseconds: Int64 = 1_800_000_000_000
        let original = AnyCodable(epochMilliseconds)

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
        let decodedMilliseconds = (decoded.value as? Int64)
            ?? (decoded.value as? Int).map(Int64.init)

        #expect(String(decoding: data, as: UTF8.self) == "1800000000000")
        #expect(decodedMilliseconds == epochMilliseconds)
        #expect(decoded == original)
        #expect(Set([decoded, original]).count == 1)
    }

    @Test
    func encodesNSNumberBooleansAsJSONBooleans() throws {
        let trueData = try JSONEncoder().encode(AnyCodable(NSNumber(value: true)))
        let falseData = try JSONEncoder().encode(AnyCodable(NSNumber(value: false)))

        #expect(String(data: trueData, encoding: .utf8) == "true")
        #expect(String(data: falseData, encoding: .utf8) == "false")
    }

    @Test
    func preservesBooleanLiteralsFromJSONSerializationBridge() throws {
        let raw = try #require(
            JSONSerialization.jsonObject(with: Data(#"{"enabled":true,"nested":{"active":false}}"#.utf8))
                as? [String: Any]
        )
        let enabled = try #require(raw["enabled"])
        let nested = try #require(raw["nested"])

        struct RequestEnvelope: Codable {
            let params: [String: AnyCodable]
        }

        let envelope = RequestEnvelope(
            params: [
                "enabled": AnyCodable(enabled),
                "nested": AnyCodable(nested),
            ]
        )
        let data = try JSONEncoder().encode(envelope)
        let json = try #require(String(data: data, encoding: .utf8))

        #expect(json.contains(#""enabled":true"#))
        #expect(json.contains(#""active":false"#))
    }
}
