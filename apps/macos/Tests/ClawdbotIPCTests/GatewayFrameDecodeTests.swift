import MoltbotProtocol
import Foundation
import Testing

@Suite struct GatewayFrameDecodeTests {
    @Test func decodesEventFrameWithAnyCodablePayload() throws {
        let json = """
        {
          "type": "event",
          "event": "presence",
          "payload": { "foo": "bar", "count": 1 },
          "seq": 7
        }
        """

        let frame = try JSONDecoder().decode(GatewayFrame.self, from: Data(json.utf8))

        #expect({
            if case .event = frame { true } else { false }
        }(), "expected .event frame")

        guard case let .event(evt) = frame else {
            return
        }

        let payload = evt.payload?.value as? [String: AnyCodable]
        #expect(payload?["foo"]?.value as? String == "bar")
        #expect(payload?["count"]?.value as? Int == 1)
        #expect(evt.seq == 7)
    }

    @Test func decodesRequestFrameWithNestedParams() throws {
        let json = """
        {
          "type": "req",
          "id": "1",
          "method": "agent.send",
          "params": {
            "text": "hi",
            "items": [1, null, {"ok": true}],
            "meta": { "count": 2 }
          }
        }
        """

        let frame = try JSONDecoder().decode(GatewayFrame.self, from: Data(json.utf8))

        #expect({
            if case .req = frame { true } else { false }
        }(), "expected .req frame")

        guard case let .req(req) = frame else {
            return
        }

        let params = req.params?.value as? [String: AnyCodable]
        #expect(params?["text"]?.value as? String == "hi")

        let items = params?["items"]?.value as? [AnyCodable]
        #expect(items?.count == 3)
        #expect(items?[0].value as? Int == 1)
        #expect(items?[1].value is NSNull)

        let item2 = items?[2].value as? [String: AnyCodable]
        #expect(item2?["ok"]?.value as? Bool == true)

        let meta = params?["meta"]?.value as? [String: AnyCodable]
        #expect(meta?["count"]?.value as? Int == 2)
    }

    @Test func decodesUnknownFrameAndPreservesRaw() throws {
        let json = """
        {
          "type": "made-up",
          "foo": "bar",
          "count": 1,
          "nested": { "ok": true }
        }
        """

        let frame = try JSONDecoder().decode(GatewayFrame.self, from: Data(json.utf8))

        #expect({
            if case .unknown = frame { true } else { false }
        }(), "expected .unknown frame")

        guard case let .unknown(type, raw) = frame else {
            return
        }

        #expect(type == "made-up")
        #expect(raw["type"]?.value as? String == "made-up")
        #expect(raw["foo"]?.value as? String == "bar")
        #expect(raw["count"]?.value as? Int == 1)
        let nested = raw["nested"]?.value as? [String: AnyCodable]
        #expect(nested?["ok"]?.value as? Bool == true)
    }
}
