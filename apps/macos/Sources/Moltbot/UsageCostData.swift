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
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    let totalTokens: Int
    let totalCost: Double
    let missingCostEntries: Int
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

    static func formatTokenCount(_ value: Int?) -> String? {
        guard let value else { return nil }
        let safe = max(0, value)
        if safe >= 1_000_000 { return String(format: "%.1fm", Double(safe) / 1_000_000.0) }
        if safe >= 1000 { return safe >= 10000
            ? String(format: "%.0fk", Double(safe) / 1000.0)
            : String(format: "%.1fk", Double(safe) / 1000.0)
        }
        return String(safe)
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
