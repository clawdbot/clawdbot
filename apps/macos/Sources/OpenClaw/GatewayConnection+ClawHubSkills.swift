import Foundation
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    func skillsStatus(on route: Route) async throws -> SkillsStatusReport {
        try await self.requestDecoded(method: .skillsStatus, ifCurrentRoute: route)
    }

    func skillsSearch(query: String, limit: Int = 25, on route: Route) async throws -> [ClawHubSkillSummary] {
        var params: [String: AnyCodable] = ["limit": AnyCodable(limit)]
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            params["query"] = AnyCodable(trimmed)
        }
        let result: ClawHubSkillSearchResult = try await self.requestDecoded(
            method: .skillsSearch,
            params: params,
            ifCurrentRoute: route)
        return result.results
    }

    func skillsDetail(slug: String, on route: Route) async throws -> ClawHubSkillDetail {
        try await self.requestDecoded(
            method: .skillsDetail,
            params: ["slug": AnyCodable(slug)],
            ifCurrentRoute: route)
    }

    /// `version` stays nil for external sources: the Gateway pins those to a commit and rejects a
    /// version selector, so sending one would fail the install the row just offered.
    func skillsInstallClawHub(
        slug: String,
        version: String?,
        acknowledgeRisk: Bool = false,
        on route: Route) async throws -> SkillInstallResult
    {
        var params: [String: AnyCodable] = [
            "source": AnyCodable("clawhub"),
            "slug": AnyCodable(slug),
            "timeoutMs": AnyCodable(clawHubInstallTimeoutMilliseconds),
        ]
        if let version {
            params["version"] = AnyCodable(version)
        }
        if acknowledgeRisk {
            params["acknowledgeClawHubRisk"] = AnyCodable(true)
        }
        return try await self.requestDecoded(
            method: .skillsInstall,
            params: params,
            timeoutMs: Double(clawHubInstallTimeoutMilliseconds + 5000),
            ifCurrentRoute: route)
    }
}
