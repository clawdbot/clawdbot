import Foundation
import OpenClawKit
import OpenClawProtocol

struct AgentOverviewRefreshGate {
    private var generation: UInt64 = 0

    mutating func begin() -> UInt64 {
        self.generation &+= 1
        return self.generation
    }

    func isCurrent(_ generation: UInt64) -> Bool {
        self.generation == generation
    }
}

enum AgentProValueReader {
    static func intValue(_ value: AnyCodable?) -> Int? {
        switch value?.value {
        case let int as Int: int
        case let double as Double where double.isFinite: Int(double)
        case let string as String: Int(string)
        default: nil
        }
    }

    static func doubleValue(_ value: AnyCodable?) -> Double? {
        switch value?.value {
        case let double as Double where double.isFinite: double
        case let int as Int: Double(int)
        case let string as String: Double(string)
        default: nil
        }
    }
}

struct AgentOverviewSnapshot {
    let gatewayID: String
    let skills: SkillStatusReportLite?
    let presence: [PresenceEntry]
    let cronStatus: CronStatusLite?
    let cronJobs: [CronJob]
    let dreaming: DreamingStatusLite?
    let dreamDiary: DreamDiaryLite?
    let usage: CostUsageSummaryLite?
    let agentSkillFilter: [String]?

    var hasAnyLiveData: Bool {
        self.skills != nil
            || !self.presence.isEmpty
            || self.cronStatus != nil
            || !self.cronJobs.isEmpty
            || self.dreaming != nil
            || self.dreamDiary != nil
            || self.usage != nil
    }
}

extension AgentOverviewSnapshot {
    static var screenshotFixture: AgentOverviewSnapshot {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let daily = CronJob(
            id: "release-briefing",
            name: "Release briefing",
            description: "Summarize mobile release readiness and open risks.",
            enabled: true,
            deleteafterrun: false,
            createdatms: now - 86_400_000 * 12,
            updatedatms: now - 3_600_000,
            configrevision: "sha256:screenshot-release-briefing",
            schedule: AnyCodable([
                "kind": AnyCodable("cron"),
                "expr": AnyCodable("0 9 * * 1-5"),
                "tz": AnyCodable("America/Los_Angeles"),
            ]),
            sessiontarget: AnyCodable("isolated"),
            wakemode: AnyCodable("now"),
            payload: AnyCodable([
                "kind": AnyCodable("agentTurn"),
                "message": AnyCodable("Summarize mobile release readiness and open risks."),
                "model": AnyCodable("openai/gpt-5.6-sol"),
            ]),
            state: [
                "nextRunAtMs": AnyCodable(now + 3_600_000),
                "lastRunAtMs": AnyCodable(now - 82_800_000),
                "lastStatus": AnyCodable("ok"),
            ],
            nextrunatms: now + 3_600_000,
            lastrunatms: now - 82_800_000,
            lastrunstatus: AnyCodable("ok"))
        let weekly = CronJob(
            id: "weekly-project-review",
            name: "Weekly project review",
            description: "Prepare a concise progress report every Friday.",
            enabled: false,
            deleteafterrun: false,
            createdatms: now - 86_400_000 * 30,
            updatedatms: now - 86_400_000,
            configrevision: "sha256:screenshot-weekly-review",
            schedule: AnyCodable([
                "kind": AnyCodable("cron"),
                "expr": AnyCodable("30 16 * * 5"),
                "tz": AnyCodable("America/Los_Angeles"),
            ]),
            sessiontarget: AnyCodable("isolated"),
            wakemode: AnyCodable("now"),
            payload: AnyCodable([
                "kind": AnyCodable("agentTurn"),
                "message": AnyCodable("Prepare the weekly project review."),
            ]),
            state: ["lastStatus": AnyCodable("ok")],
            lastrunatms: now - 86_400_000 * 7,
            lastrunstatus: AnyCodable("ok"))
        return AgentOverviewSnapshot(
            gatewayID: ScreenshotFixtureMode.gatewayID,
            skills: nil,
            presence: [],
            cronStatus: CronStatusLite(enabled: true, jobs: 2, nextwakeatms: now + 3_600_000),
            cronJobs: [daily, weekly],
            dreaming: nil,
            dreamDiary: nil,
            usage: nil,
            agentSkillFilter: nil)
    }
}

struct SkillStatusReportLite: Decodable {
    let workspaceDir: String?
    let managedSkillsDir: String?
    let agentId: String?
    let agentSkillFilter: [String]?
    let skills: [SkillStatusEntryLite]

    var totalCount: Int {
        self.skills.count
    }

    var enabledCount: Int {
        self.skills.count {
            $0.isEnabled
        }
    }

    var blockedCount: Int {
        self.skills.count {
            $0.blockedByAllowlist == true || $0.blockedByAgentFilter == true
        }
    }

    var missingRequirementCount: Int {
        self.skills.count {
            $0.hasMissingRequirements
        }
    }
}

struct SkillStatusEntryLite: Decodable {
    let name: String
    let description: String?
    let source: String?
    let filePath: String?
    let skillKey: String?
    let primaryEnv: String?
    let emoji: String?
    let homepage: String?
    let disabled: Bool?
    let blockedByAllowlist: Bool?
    let blockedByAgentFilter: Bool?
    let missing: SkillStatusMissingLite?
    let install: [SkillInstallOptionLite]?

    var displayName: String {
        if let emoji, !emoji.isEmpty {
            return "\(emoji) \(self.name)"
        }
        return self.name
    }

    var effectiveSkillKey: String {
        let trimmed = (skillKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? self.name : trimmed
    }

    var isGloballyEnabled: Bool {
        self.disabled != true
    }

    var isEnabled: Bool {
        self.disabled != true
            && self.blockedByAllowlist != true
            && self.blockedByAgentFilter != true
    }

    var hasMissingRequirements: Bool {
        guard let missing else { return false }
        return !missing.bins.isEmpty
            || !missing.anyBins.isEmpty
            || !missing.env.isEmpty
            || !missing.config.isEmpty
            || !missing.os.isEmpty
    }

    var missingSummary: String? {
        guard let missing else { return nil }
        let values = [
            missing.bins,
            missing.anyBins,
            missing.env,
            missing.config,
            missing.os,
        ].flatMap(\.self)
        return values.isEmpty ? nil : values.prefix(3).joined(separator: ", ")
    }

    var installSummary: String? {
        guard let option = install?.first else { return nil }
        return option.label
    }

    var missingBins: [String] {
        guard let missing else { return [] }
        return missing.bins + missing.anyBins
    }

    var homepageURL: URL? {
        guard let homepage else { return nil }
        return URL(string: homepage)
    }
}

struct SkillInstallOptionLite: Decodable {
    let id: String?
    let kind: String?
    let label: String
    let bins: [String]?
}

struct SkillUpdateParams: Encodable {
    let skillKey: String
    var enabled: Bool?
    var apiKey: String?
}

struct SkillInstallParams: Encodable {
    let name: String
    let installId: String
    let timeoutMs: Int
}

struct SkillInstallResultLite: Decodable {
    let message: String?
}

struct ClawHubSearchParams: Encodable {
    let query: String?
    let limit: Int
}

struct ClawHubSearchResponseLite: Decodable {
    let results: [ClawHubSearchResultLite]
}

struct ClawHubSearchResultLite: Decodable {
    let slug: String
    let displayName: String
    let summary: String?
    let version: String?
}

struct ClawHubInstallParams: Encodable {
    let source = "clawhub"
    let slug: String
}

struct SkillStatusMissingLite: Decodable {
    let bins: [String]
    let anyBins: [String]
    let env: [String]
    let config: [String]
    let os: [String]

    private enum CodingKeys: String, CodingKey {
        case bins
        case anyBins
        case env
        case config
        case os
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.bins = try container.decode([String].self, forKey: .bins)
        self.anyBins = try container.decodeIfPresent([String].self, forKey: .anyBins) ?? []
        self.env = try container.decode([String].self, forKey: .env)
        self.config = try container.decode([String].self, forKey: .config)
        self.os = try container.decodeIfPresent([String].self, forKey: .os) ?? []
    }
}

struct CronStatusLite: Decodable {
    let enabled: Bool
    let jobs: Int
    let nextwakeatms: Int?

    enum CodingKeys: String, CodingKey {
        case enabled
        case jobs
        case nextwakeatms = "nextWakeAtMs"
    }
}

struct CronJobsListLite: Decodable {
    let jobs: [CronJob]
    let snapshotRevision: String?
    let total: Int?
    let hasMore: Bool
    let nextOffset: Int?

    private enum CodingKeys: String, CodingKey {
        case jobs
        case snapshotRevision
        case total
        case hasMore
        case nextOffset
    }

    init(
        jobs: [CronJob],
        snapshotRevision: String? = nil,
        total: Int?,
        hasMore: Bool,
        nextOffset: Int?)
    {
        self.jobs = jobs
        self.snapshotRevision = snapshotRevision
        self.total = total
        self.hasMore = hasMore
        self.nextOffset = nextOffset
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.jobs = try container.decode([CronJob].self, forKey: .jobs)
        self.snapshotRevision = try container.decodeIfPresent(String.self, forKey: .snapshotRevision)
        self.total = try container.decodeIfPresent(Int.self, forKey: .total)
        self.hasMore = try container.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
        self.nextOffset = try container.decodeIfPresent(Int.self, forKey: .nextOffset)
    }
}

struct CronJobsSnapshotIdentity: Equatable {
    let total: Int?
    let revision: String?
}

func cronJobsSnapshotIdentity(page: CronJobsListLite, maximumCount: Int) -> CronJobsSnapshotIdentity? {
    guard page.total.map({ (0...maximumCount).contains($0) }) ?? true else { return nil }
    let revision = page.snapshotRevision?.trimmingCharacters(in: .whitespacesAndNewlines)
    return CronJobsSnapshotIdentity(
        total: page.total,
        revision: revision?.isEmpty == false ? revision : nil)
}

func nextCronJobsListOffset(page: CronJobsListLite, currentOffset: Int) -> Int? {
    guard page.hasMore, let nextOffset = page.nextOffset, nextOffset > currentOffset else { return nil }
    return nextOffset
}

struct DreamingStatusEnvelope: Decodable {
    let dreaming: DreamingStatusLite?
}

struct DreamingStatusLite: Decodable {
    let enabled: Bool
    let shortTermCount: Int?
    let totalSignalCount: Int?
    let promotedToday: Int?
    let storeError: String?
    let shortTermEntries: [DreamingEntryLite]?
    let signalEntries: [DreamingEntryLite]?
    let promotedEntries: [DreamingEntryLite]?
    let phases: [String: DreamingPhaseStatusLite]?

    var nextRunAtMs: Int? {
        self.phases?.values
            .compactMap(\.nextRunAtMs)
            .min()
    }
}

struct DreamingEntryLite: Decodable, Identifiable {
    let key: String
    let path: String
    let startLine: Int
    let endLine: Int
    let snippet: String
    let recallCount: Int
    let dailyCount: Int
    let groundedCount: Int
    let totalSignalCount: Int
    let lightHits: Int
    let remHits: Int
    let phaseHitCount: Int
    let promotedAt: String?
    let lastRecalledAt: String?

    var id: String {
        "\(self.key):\(self.path):\(self.startLine):\(self.endLine)"
    }
}

struct DreamDiaryLite: Decodable {
    let agentId: String
    let found: Bool
    let path: String
    let content: String?
    let updatedAtMs: Int?
}

struct DreamingPhaseStatusLite: Decodable {
    let enabled: Bool?
    let cron: String?
    let managedCronPresent: Bool?
    let nextRunAtMs: Int?
}

struct DreamingPhaseRow: Identifiable {
    let id: String
    let title: String
    let status: DreamingPhaseStatusLite
}

struct ConfigSnapshotLite: Decodable {
    let hash: String?
    let config: ConfigRootLite?

    func agentConfig(id: String) -> AgentConfigLite? {
        self.config?.agents?.list?.first { $0.id == id }
    }

    func effectiveSkillFilter(agentId: String) -> [String]? {
        if let agentSkills = agentConfig(id: agentId)?.skills {
            return agentSkills
        }
        return self.config?.agents?.defaults?.skills
    }
}

struct ConfigRootLite: Decodable {
    let agents: AgentsConfigLite?
}

struct AgentsConfigLite: Decodable {
    let defaults: AgentDefaultsConfigLite?
    let list: [AgentConfigLite]?
}

struct AgentDefaultsConfigLite: Decodable {
    let skills: [String]?
}

struct AgentConfigLite: Decodable {
    let id: String
    let skills: [String]?
}

struct ConfigPatchParams: Encodable {
    let raw: String
    let baseHash: String
    let replacePaths: [String]?

    init(raw: String, baseHash: String, replacePaths: [String]? = nil) {
        self.raw = raw
        self.baseHash = baseHash
        self.replacePaths = replacePaths
    }
}

enum SkillMutationError: LocalizedError {
    case liveGatewayUnavailable
    case missingConfigHash
    case invalidPatchPayload

    var errorDescription: String? {
        switch self {
        case .liveGatewayUnavailable:
            "Connect a live gateway to edit agent skills."
        case .missingConfigHash:
            "Config hash missing; refresh and retry."
        case .invalidPatchPayload:
            "Could not encode the skill config update."
        }
    }
}

struct CostUsageSummaryLite: Decodable {
    let updatedAt: Int?
    let days: Int?
    let daily: [CostUsageDailyEntryLite]?
    let totals: [String: AnyCodable]?
    let cacheStatus: [String: AnyCodable]?

    var totalCost: Double? {
        AgentProValueReader.doubleValue(self.totals?["totalCost"])
    }

    var totalTokens: Int? {
        AgentProValueReader.intValue(self.totals?["totalTokens"])
    }
}

struct CostUsageDailyEntryLite: Decodable {
    let date: String
    let totalTokens: Int?
    let totalCost: Double?
}
