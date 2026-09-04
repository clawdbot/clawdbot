import Foundation
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    func skillsStatus() async throws -> SkillsStatusReport {
        try await self.requestDecoded(method: .skillsStatus)
    }

    func skillsInstall(
        name: String,
        installId: String,
        dangerouslyForceUnsafeInstall: Bool? = nil,
        timeoutMs: Int? = nil,
        on route: Route) async throws -> SkillInstallResult
    {
        var params: [String: AnyCodable] = [
            "name": AnyCodable(name),
            "installId": AnyCodable(installId),
        ]
        if let dangerouslyForceUnsafeInstall {
            params["dangerouslyForceUnsafeInstall"] = AnyCodable(dangerouslyForceUnsafeInstall)
        }
        if let timeoutMs {
            params["timeoutMs"] = AnyCodable(timeoutMs)
        }
        return try await self.requestDecoded(method: .skillsInstall, params: params, ifCurrentRoute: route)
    }

    func skillsUpdate(
        skillKey: String,
        enabled: Bool? = nil,
        apiKey: String? = nil,
        env: [String: String]? = nil,
        on route: Route) async throws -> SkillUpdateResult
    {
        var params: [String: AnyCodable] = [
            "skillKey": AnyCodable(skillKey),
        ]
        if let enabled {
            params["enabled"] = AnyCodable(enabled)
        }
        if let apiKey {
            params["apiKey"] = AnyCodable(apiKey)
        }
        if let env, !env.isEmpty {
            params["env"] = AnyCodable(env)
        }
        return try await self.requestDecoded(method: .skillsUpdate, params: params, ifCurrentRoute: route)
    }

    func skillsStatus(on source: ServerLease) async throws -> SkillsStatusReport {
        try await JSONDecoder().decode(SkillsStatusReport.self, from: self.request(
            method: Method.skillsStatus.rawValue, params: nil, ifCurrentServerLease: source))
    }

    func skillsSearch(query: String, limit: Int = 25, on source: ServerLease) async throws -> [ClawHubSkillSummary] {
        var params: [String: AnyCodable] = ["limit": AnyCodable(limit)]
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            params["query"] = AnyCodable(trimmed)
        }
        let result = try await JSONDecoder().decode(ClawHubSkillSearchResult.self, from: self.request(
            method: Method.skillsSearch.rawValue, params: params, ifCurrentServerLease: source))
        return result.results
    }

    func skillsDetail(slug: String, on source: ServerLease) async throws -> ClawHubSkillDetail {
        try await JSONDecoder().decode(ClawHubSkillDetail.self, from: self.request(
            method: Method.skillsDetail.rawValue,
            params: ["slug": AnyCodable(slug)],
            ifCurrentServerLease: source))
    }

    /// `version` stays nil for external sources: the Gateway pins those to a commit and rejects a
    /// version selector, so sending one would fail the install the row just offered.
    func skillsInstallClawHub(
        slug: String,
        version: String?,
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
        return try await self.requestDecoded(
            method: .skillsInstall,
            params: params,
            timeoutMs: Double(clawHubInstallTimeoutMilliseconds + 5000),
            ifCurrentRoute: route)
    }
}
