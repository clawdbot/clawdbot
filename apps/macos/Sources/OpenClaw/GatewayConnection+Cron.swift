import Foundation
import OpenClawKit
import OSLog

private let gatewayCronLogger = Logger(subsystem: "ai.openclaw", category: "gateway.connection")

struct CronJobsSummary {
    static let previewLimit = 8
    static let empty = Self(total: 0, jobs: [])
    // The server total covers the filtered catalog; jobs contains only the preview page.
    let total: Int
    let jobs: [CronJob]
}

extension CronJobsSummary: Decodable {
    private struct LossyJob: Decodable {
        let value: CronJob?

        init(from decoder: Decoder) throws {
            self.value = try? CronJob(from: decoder)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case total
        case jobs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.total = try container.decode(Int.self, forKey: .total)
        let decoded = try container.decodeIfPresent([LossyJob].self, forKey: .jobs) ?? []
        self.jobs = decoded.compactMap(\.value)
        let skipped = decoded.count - self.jobs.count
        if skipped > 0 {
            gatewayCronLogger.warning("cron.list skipped \(skipped, privacy: .public) malformed jobs")
        }
    }
}

extension GatewayConnection {
    func cronSummary(ifCurrentServerLease lease: ServerLease) async throws -> CronJobsSummary {
        let data = try await self.request(
            method: Method.cronList.rawValue,
            params: [
                "includeDisabled": AnyCodable(false),
                "limit": AnyCodable(CronJobsSummary.previewLimit),
                "sortBy": AnyCodable("nextRunAtMs"),
                "sortDir": AnyCodable("asc"),
            ],
            ifCurrentServerLease: lease)
        return try JSONDecoder().decode(CronJobsSummary.self, from: data)
    }
}
