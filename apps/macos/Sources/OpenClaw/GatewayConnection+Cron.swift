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

    nonisolated static func decodeCronListResponse(_ data: Data) throws -> [CronJob] {
        let decoded = try JSONDecoder().decode(LossyCronListResponse.self, from: data)
        let jobs = decoded.jobs.compactMap(\.value)
        let skipped = decoded.jobs.count - jobs.count
        if skipped > 0 {
            gatewayCronLogger.warning("cron.list skipped \(skipped, privacy: .public) malformed jobs")
        }
        return jobs
    }

    func cronList(includeDisabled: Bool = true, ifCurrentServerLease lease: ServerLease) async throws -> [CronJob] {
        let data = try await self.request(
            method: Method.cronList.rawValue,
            params: ["includeDisabled": AnyCodable(includeDisabled)],
            ifCurrentServerLease: lease)
        return try Self.decodeCronListResponse(data)
    }
}
