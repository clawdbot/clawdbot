import Foundation
import Testing
@testable import OpenClaw

struct UsageCostDataTests {
    private static let fields = [
        "date", "input", "output", "cacheRead", "cacheWrite", "totalTokens", "totalCost", "missingCostEntries",
    ]

    private var row: [String: Any] {
        [
            "date": "2026-08-27",
            "input": 11,
            "output": 7,
            "cacheRead": 3,
            "cacheWrite": 2,
            "totalTokens": 23,
            "totalCost": 0.125,
            "missingCostEntries": 1,
        ]
    }

    @Test func `summary round trip preserves flat daily totals and ignores extra fields`() throws {
        var row = self.row
        row["futureCostField"] = ["value": 42]
        let data = try JSONSerialization.data(withJSONObject: [
            "updatedAt": 1234.5,
            "days": 1,
            "daily": [row],
            "totals": row,
            "futureSummaryField": true,
        ])
        let summary = try JSONDecoder().decode(GatewayCostUsageSummary.self, from: data)
        let day = try #require(summary.daily.first)
        #expect(day.date == "2026-08-27")
        #expect(day.totalCost == 0.125)
        #expect(summary.totals.missingCostEntries == 1)

        let encoded = try JSONEncoder().encode(summary)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let daily = try #require(object["daily"] as? [[String: Any]])
        let encodedDay = try #require(daily.first)
        #expect(NSDictionary(dictionary: encodedDay) == NSDictionary(dictionary: self.row))
        #expect(object["updatedAt"] as? Double == 1234.5)
        #expect(object["days"] as? Int == 1)
        #expect(Set(object.keys) == ["updatedAt", "days", "daily", "totals"])
        let totals = try #require(object["totals"] as? [String: Any])
        #expect(Set(totals.keys) == Set(Self.fields.dropFirst()))
    }

    @Test(arguments: ["0", "-0", "-0.125"])
    func `zero and negative costs survive the flat wire format`(_ cost: String) throws {
        let data = Data("""
        {"date":"","input":0,"output":0,"cacheRead":0,"cacheWrite":0,
         "totalTokens":0,"totalCost":\(cost),"missingCostEntries":0}
        """.utf8)
        let day = try JSONDecoder().decode(GatewayCostUsageDay.self, from: data)
        let expected = try #require(Double(cost))
        #expect(day.date.isEmpty)
        #expect(day.totalCost.bitPattern == expected.bitPattern)
        let decoded = try JSONDecoder().decode(GatewayCostUsageDay.self, from: JSONEncoder().encode(day))
        #expect(decoded.totalCost.bitPattern == expected.bitPattern)
    }

    enum InvalidField: CaseIterable {
        case missing, null, wrongType
    }

    @Test(arguments: Self.fields, InvalidField.allCases)
    func `every flat field is required with its original type`(_ field: String, _ invalid: InvalidField) throws {
        var row = self.row
        switch invalid {
        case .missing: row.removeValue(forKey: field)
        case .null: row[field] = NSNull()
        case .wrongType: row[field] = false
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "updatedAt": 0, "days": 1, "daily": [row], "totals": self.row,
        ])
        do {
            _ = try JSONDecoder().decode(GatewayCostUsageSummary.self, from: data)
            Issue.record("Accepted invalid required field \(field)")
        } catch let DecodingError.keyNotFound(key, context) {
            #expect(invalid == .missing)
            #expect(key.stringValue == field)
            #expect(context.codingPath.map(\.stringValue) == ["daily", "Index 0"])
        } catch let DecodingError.valueNotFound(_, context) {
            #expect(invalid == .null)
            #expect(context.codingPath.map(\.stringValue) == ["daily", "Index 0", field])
        } catch let DecodingError.typeMismatch(_, context) {
            #expect(invalid == .wrongType)
            #expect(context.codingPath.map(\.stringValue) == ["daily", "Index 0", field])
        }
    }

    @Test(arguments: Self.fields.indices)
    func `date then totals declaration order determines the first decoding failure`(_ index: Int) throws {
        var row = self.row
        for field in Self.fields[index...] {
            row.removeValue(forKey: field)
        }
        let data = try JSONSerialization.data(withJSONObject: row)
        do {
            _ = try JSONDecoder().decode(GatewayCostUsageDay.self, from: data)
            Issue.record("Accepted missing required fields")
        } catch let DecodingError.keyNotFound(key, context) {
            #expect(key.stringValue == Self.fields[index])
            #expect(context.codingPath.isEmpty)
        }
    }

    @Test(arguments: ["NaN", "Infinity", "-Infinity"])
    func `nonfinite daily costs fail encoding at the flat totalCost path`(_ cost: String) throws {
        var row = self.row
        row["totalCost"] = cost
        let decoder = JSONDecoder()
        decoder.nonConformingFloatDecodingStrategy = .convertFromString(
            positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
        let data = try JSONSerialization.data(withJSONObject: [
            "updatedAt": 0, "days": 2, "daily": [self.row, row], "totals": self.row,
        ])
        let summary = try decoder.decode(GatewayCostUsageSummary.self, from: data)
        do {
            _ = try JSONEncoder().encode(summary)
            Issue.record("Encoded a nonfinite daily cost")
        } catch let EncodingError.invalidValue(_, context) {
            #expect(context.codingPath.map(\.stringValue) == ["daily", "Index 1", "totalCost"])
        }
    }

    @Test(arguments: [
        (nil, nil),
        (Double.nan, nil),
        (Double.infinity, nil),
        (-Double.infinity, nil),
        (-1.25, "$-1.2500"),
        (-0.0, "$-0.0000"),
        (0.0, "$0.0000"),
        (0.0001, "$0.0001"),
        (0.01.nextDown, "$0.0100"),
        (0.01, "$0.01"),
        (0.01.nextUp, "$0.01"),
        (1.0.nextDown, "$1.00"),
        (1.0, "$1.00"),
        (1.0.nextUp, "$1.00"),
    ] as [(Double?, String?)])
    func `USD precision follows the one-cent boundary`(_ value: Double?, _ expected: String?) {
        #expect(CostUsageFormatting.formatUsd(value) == expected)
    }
}
