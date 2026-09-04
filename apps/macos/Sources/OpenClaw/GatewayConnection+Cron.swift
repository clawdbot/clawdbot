import Foundation
import OpenClawKit
import OSLog

private let gatewayCronLogger = Logger(subsystem: "ai.openclaw", category: "gateway.connection")

extension GatewayConnection {
    private struct LossyDecodable<Value: Decodable>: Decodable {
        let value: Value?

        init(from decoder: Decoder) throws {
            do {
                self.value = try Value(from: decoder)
            } catch {
                self.value = nil
            }
        }
    }

    private struct LossyCronListResponse: Decodable {
        let jobs: [LossyDecodable<CronJob>]

        enum CodingKeys: String, CodingKey {
            case jobs
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.jobs = try container.decodeIfPresent([LossyDecodable<CronJob>].self, forKey: .jobs) ?? []
        }
    }

    private struct LossyCronRunsResponse: Decodable {
        let entries: [LossyDecodable<CronRunLogEntry>]

        enum CodingKeys: String, CodingKey {
            case entries
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.entries = try container.decodeIfPresent([LossyDecodable<CronRunLogEntry>].self, forKey: .entries) ?? []
        }
    }

    nonisolated static func decodeCronListResponse(_ data: Data) throws -> [CronJob] {
        let decoded = try JSONDecoder().decode(LossyCronListResponse.self, from: data)
        let jobs = decoded.jobs.compactMap(\.value)
        let skipped = decoded.jobs.count - jobs.count
        if skipped > 0 {
            gatewayCronLogger.warning("cron.list skipped \(skipped, privacy: .public) malformed jobs")
        }
        return jobs
    }

    nonisolated static func decodeCronRunsResponse(_ data: Data) throws -> [CronRunLogEntry] {
        let decoded = try JSONDecoder().decode(LossyCronRunsResponse.self, from: data)
        let entries = decoded.entries.compactMap(\.value)
        let skipped = decoded.entries.count - entries.count
        if skipped > 0 {
            gatewayCronLogger.warning("cron.runs skipped \(skipped, privacy: .public) malformed entries")
        }
        return entries
    }

    // MARK: - Cron

    struct CronSchedulerStatus: Decodable {
        let enabled: Bool
        let storePath: String
        let sqlitePath: String?
        let jobs: Int
        let nextWakeAtMs: Int?
    }

    func cronStatus(ifCurrentServerLease lease: ServerLease) async throws -> CronSchedulerStatus {
        let data = try await self.request(
            method: Method.cronStatus.rawValue, params: nil, ifCurrentServerLease: lease)
        return try JSONDecoder().decode(CronSchedulerStatus.self, from: data)
    }

    func cronList(includeDisabled: Bool = true, ifCurrentServerLease lease: ServerLease) async throws -> [CronJob] {
        let data = try await self.request(
            method: Method.cronList.rawValue,
            params: ["includeDisabled": AnyCodable(includeDisabled)],
            ifCurrentServerLease: lease)
        return try Self.decodeCronListResponse(data)
    }

    func cronRuns(
        jobId: String,
        limit: Int = 200,
        ifCurrentServerLease lease: ServerLease) async throws -> [CronRunLogEntry]
    {
        let data = try await self.request(
            method: Method.cronRuns.rawValue,
            params: ["id": AnyCodable(jobId), "limit": AnyCodable(limit)],
            ifCurrentServerLease: lease)
        return try Self.decodeCronRunsResponse(data)
    }

    func cronRun(jobId: String, force: Bool = true, ifCurrentRoute route: Route) async throws {
        _ = try await self.request(
            method: Method.cronRun.rawValue,
            params: [
                "id": AnyCodable(jobId),
                "mode": AnyCodable(force ? "force" : "due"),
            ],
            timeoutMs: 20000,
            ifCurrentRoute: route)
    }

    func cronRemove(jobId: String, ifCurrentRoute route: Route) async throws {
        _ = try await self.request(
            method: Method.cronRemove.rawValue,
            params: ["id": AnyCodable(jobId)],
            ifCurrentRoute: route)
    }

    func cronUpdate(jobId: String, patch: [String: AnyCodable], ifCurrentRoute route: Route) async throws {
        _ = try await self.request(
            method: Method.cronUpdate.rawValue,
            params: ["id": AnyCodable(jobId), "patch": AnyCodable(patch)],
            ifCurrentRoute: route)
    }

    func cronAdd(payload: [String: AnyCodable], ifCurrentRoute route: Route) async throws {
        _ = try await self.request(method: Method.cronAdd.rawValue, params: payload, ifCurrentRoute: route)
    }
}
