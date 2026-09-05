import Foundation

struct GatewayCostUsageTotals: Codable {
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    let totalTokens: Int
    let totalCost: Double
    let missingCostEntries: Int
}

struct GatewayCostUsageDay: Codable {
    let date: String
    private let totals: GatewayCostUsageTotals

    var totalCost: Double {
        self.totals.totalCost
    }

    private enum CodingKeys: String, CodingKey {
        case date
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.date = try c.decode(String.self, forKey: .date)
        // Daily rows flatten the totals contract beside date, not under a nested key.
        self.totals = try GatewayCostUsageTotals(from: decoder)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.date, forKey: .date)
        try self.totals.encode(to: encoder)
    }
}

struct GatewayCostUsageSummary: Codable {
    let updatedAt: Double
    let days: Int
    let daily: [GatewayCostUsageDay]
    let totals: GatewayCostUsageTotals
}

enum CostUsageFormatting {
    static func formatUsd(_ value: Double?) -> String? {
        guard let value, value.isFinite else { return nil }
        if value >= 0.01 { return String(format: "$%.2f", value) }
        return String(format: "$%.4f", value)
    }
}
