import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing

struct AnyCodableTests {
    @Test
    func `round trips epoch milliseconds beyond int 32`() throws {
        let epochMilliseconds: Int64 = 1_800_000_000_000
        let values = try self.representations([epochMilliseconds], json: "1800000000000")

        #expect(try String(decoding: JSONEncoder().encode(values[0]), as: UTF8.self) == "1800000000000")
        try self.expectRoundTrips(values, as: epochMilliseconds)
    }

    @Test(arguments: [Int64.min, -42, -1, 0, 1, 42, 9_007_199_254_740_993, Int64.max])
    func `round trips signed numbers from native and foundation`(_ value: Int64) throws {
        var native: [Any] = [value, NSNumber(value: value)]
        if let integer = Int(exactly: value) { native.append(integer) }
        let values = try self.representations(native, json: String(value))
        try self.expectRoundTrips(values, as: value)
    }

    @Test(arguments: [UInt64(Int64.max) + 1, UInt64(Int64.max) + 2, UInt64.max])
    func `round trips unsigned numbers beyond int 64`(_ value: UInt64) throws {
        let values = try self.representations([value, NSNumber(value: value)], json: String(value))
        try self.expectRoundTrips(values, as: value)
    }

    @Test(arguments: [0.0, 1.0, -0.5, 0.5, 1.5, Double(Int64.min), Double(Int64.max), Double(UInt64.max)])
    func `round trips floating numbers from native and foundation`(_ value: Double) throws {
        let values = try self.representations([value, NSNumber(value: value)], json: String(value))
        for wrapped in values {
            let data = try JSONEncoder().encode(wrapped)
            #expect(try JSONDecoder().decode(Double.self, from: data) == value)
        }
    }

    @Test
    func `boxed floating point values do not saturate integer bounds`() throws {
        let signedOverflow = try JSONEncoder().encode(AnyCodable(NSNumber(value: Double(Int64.max))))
        #expect(try JSONDecoder().decode(UInt64.self, from: signedOverflow) == UInt64(Int64.max) + 1)

        let unsignedOverflow = try JSONEncoder().encode(AnyCodable(NSNumber(value: Double(UInt64.max))))
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(UInt64.self, from: unsignedOverflow)
        }
    }

    @Test
    func `preserves exact decimal integers from nested JSON serialization`() throws {
        let json = #"{"values":[9223372036854775807.0,18446744073709551615.0]}"#
        let foundation = try JSONSerialization.jsonObject(with: Data(json.utf8))
        let data = try JSONEncoder().encode(AnyCodable(foundation))
        let decoded = try JSONDecoder().decode([String: [UInt64]].self, from: data)
        #expect(decoded["values"] == [UInt64(Int64.max), UInt64.max])
    }

    @Test(arguments: [false, true])
    func `round trips booleans without equating them to numbers`(_ value: Bool) throws {
        let booleans = try self.representations([value, NSNumber(value: value)], json: value ? "true" : "false")
        try self.expectRoundTrips(booleans, as: value)

        let number = value ? 1 : 0
        let numbers = try self.representations(
            [number, NSNumber(value: number), Double(number), NSNumber(value: Double(number))],
            json: String(number))
        for numeric in numbers {
            #expect(numeric.boolValue == nil)
        }
        for boolean in booleans {
            #expect(boolean.boolValue == value)
            for numeric in numbers {
                #expect(boolean != numeric)
                #expect(numeric != boolean)
                #expect(Set([boolean, numeric]).count == 2)
                #expect(Set([numeric, boolean]).count == 2)
            }
        }
    }

    @Test
    func `round trips nested mixed payloads from native and foundation`() throws {
        struct Row: Decodable, Equatable {
            let signed: Int64
            let unsigned: UInt64
            let enabled: Bool
            let fraction: Double

            init(from decoder: Decoder) throws {
                var row = try decoder.unkeyedContainer()
                self.signed = try row.decode(Int64.self)
                self.unsigned = try row.decode(UInt64.self)
                self.enabled = try row.decode(Bool.self)
                self.fraction = try row.decode(Double.self)
            }
        }

        struct Payload: Decodable, Equatable {
            let generation: UInt64
            let enabled: Bool
            let nested: [String: [Row]]
        }

        let json = """
        {"generation":1,"enabled":true,"nested":{"rows":[
          [-42,1,false,0.5],
          [0,42,true,1.5]
        ]}}
        """
        let native: [String: Any] = [
            "generation": 1,
            "enabled": true,
            "nested": ["rows": [
                [Int64(-42), 1, false, 0.5] as [Any],
                [Int64(0), 42, true, 1.5] as [Any],
            ]],
        ]
        let foundation = NSDictionary(dictionary: [
            "generation": NSNumber(value: 1),
            "enabled": NSNumber(value: true),
            "nested": NSDictionary(dictionary: ["rows": NSArray(array: [
                NSArray(array: [
                    NSNumber(value: -42), NSNumber(value: 1),
                    NSNumber(value: false), NSNumber(value: 0.5),
                ]),
                NSArray(array: [
                    NSNumber(value: 0), NSNumber(value: 42),
                    NSNumber(value: true), NSNumber(value: 1.5),
                ]),
            ])]),
        ])
        let expected = try JSONDecoder().decode(Payload.self, from: Data(json.utf8))
        let values = try self.representations([native, foundation], json: json)

        try self.expectRoundTrips(values, as: expected)
    }

    private func representations(_ values: [Any], json: String) throws -> [AnyCodable] {
        let data = Data(json.utf8)
        return try values.map(AnyCodable.init) + [
            AnyCodable(JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])),
            JSONDecoder().decode(AnyCodable.self, from: data),
        ]
    }

    private func expectRoundTrips<Value: Decodable & Equatable>(
        _ values: [AnyCodable],
        as expected: Value,
        sourceLocation: SourceLocation = #_sourceLocation) throws
    {
        for lhs in values {
            for rhs in values {
                #expect(lhs == rhs, sourceLocation: sourceLocation)
            }
        }
        #expect(Set(values).count == 1, sourceLocation: sourceLocation)
        #expect(Set(values.reversed()).count == 1, sourceLocation: sourceLocation)

        for value in values {
            let data = try JSONEncoder().encode(value)
            #expect(try JSONDecoder().decode(Value.self, from: data) == expected, sourceLocation: sourceLocation)

            let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
            #expect(value == decoded, sourceLocation: sourceLocation)
            #expect(decoded == value, sourceLocation: sourceLocation)
            #expect(Set([value, decoded]).count == 1, sourceLocation: sourceLocation)

            let reencoded = try JSONEncoder().encode(decoded)
            #expect(try JSONDecoder().decode(Value.self, from: reencoded) == expected, sourceLocation: sourceLocation)
        }
    }
}

struct AnyCodableIntegerAccessTests {
    @Test
    func `integer access accepts only exact in-range values`() {
        let cases: [(Any, Int?)] = [
            (0, 0), (1, 1), (-1.0, -1), (-0.0, 0), (1.5, nil),
            (Int64.min, Int(exactly: Int64.min)),
            (Int64.max, Int(exactly: Int64.max)),
            (UInt64(Int.max) + 1, nil),
            (NSNumber(value: UInt64(Int.max) + 1), nil),
            (Double(Int.max) + 1, nil),
            (NSNumber(value: Double(Int.max) + 1), nil),
            (UInt64.max, nil), (Double.infinity, nil), (true, nil), (false, nil),
        ]
        for (value, expected) in cases {
            #expect(AnyCodable(value).intValue == expected)
        }
    }
}
