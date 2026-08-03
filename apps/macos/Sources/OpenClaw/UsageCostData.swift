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

    var input: Int {
        self.totals.input
    }

    var output: Int {
        self.totals.output
    }

    var cacheRead: Int {
        self.totals.cacheRead
    }

    var cacheWrite: Int {
        self.totals.cacheWrite
    }

    var totalTokens: Int {
        self.totals.totalTokens
    }

    var totalCost: Double {
        self.totals.totalCost
    }

    var missingCostEntries: Int {
        self.totals.missingCostEntries
    }

    init(
        date: String,
        input: Int,
        output: Int,
        cacheRead: Int,
        cacheWrite: Int,
        totalTokens: Int,
        totalCost: Double,
        missingCostEntries: Int)
    {
        self.date = date
        self.totals = GatewayCostUsageTotals(
            input: input,
            output: output,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
            totalTokens: totalTokens,
            totalCost: totalCost,
            missingCostEntries: missingCostEntries)
    }

    private enum CodingKeys: String, CodingKey {
        case date
        case input
        case output
        case cacheRead
        case cacheWrite
        case totalTokens
        case totalCost
        case missingCostEntries
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.date = try c.decode(String.self, forKey: .date)
        self.totals = try GatewayCostUsageTotals(
            input: c.decode(Int.self, forKey: .input),
            output: c.decode(Int.self, forKey: .output),
            cacheRead: c.decode(Int.self, forKey: .cacheRead),
            cacheWrite: c.decode(Int.self, forKey: .cacheWrite),
            totalTokens: c.decode(Int.self, forKey: .totalTokens),
            totalCost: c.decode(Double.self, forKey: .totalCost),
            missingCostEntries: c.decode(Int.self, forKey: .missingCostEntries))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.date, forKey: .date)
        try c.encode(self.input, forKey: .input)
        try c.encode(self.output, forKey: .output)
        try c.encode(self.cacheRead, forKey: .cacheRead)
        try c.encode(self.cacheWrite, forKey: .cacheWrite)
        try c.encode(self.totalTokens, forKey: .totalTokens)
        try c.encode(self.totalCost, forKey: .totalCost)
        try c.encode(self.missingCostEntries, forKey: .missingCostEntries)
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
        if value >= 1 { return String(format: "$%.2f", value) }
        if value >= 0.01 { return String(format: "$%.2f", value) }
        return String(format: "$%.4f", value)
    }
}

@MainActor
enum CostUsageLoader {
    static func loadSummary() async throws -> GatewayCostUsageSummary {
        let data = try await ControlChannel.shared.request(
            method: "usage.cost",
            params: nil,
            timeoutMs: 7000)
        return try JSONDecoder().decode(GatewayCostUsageSummary.self, from: data)
    }
}
