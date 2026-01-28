import Foundation

enum CronSessionTarget: String, CaseIterable, Identifiable, Codable {
    case main
    case isolated

    var id: String { self.rawValue }
}

enum CronWakeMode: String, CaseIterable, Identifiable, Codable {
    case now
    case nextHeartbeat = "next-heartbeat"

    var id: String { self.rawValue }
}

enum CronSchedule: Codable, Equatable {
    case at(atMs: Int)
    case every(everyMs: Int, anchorMs: Int?)
    case cron(expr: String, tz: String?)

    enum CodingKeys: String, CodingKey { case kind, atMs, everyMs, anchorMs, expr, tz }

    var kind: String {
        switch self {
        case .at: "at"
        case .every: "every"
        case .cron: "cron"
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "at":
            self = try .at(atMs: container.decode(Int.self, forKey: .atMs))
        case "every":
            self = try .every(
                everyMs: container.decode(Int.self, forKey: .everyMs),
                anchorMs: container.decodeIfPresent(Int.self, forKey: .anchorMs))
        case "cron":
            self = try .cron(
                expr: container.decode(String.self, forKey: .expr),
                tz: container.decodeIfPresent(String.self, forKey: .tz))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unknown schedule kind: \(kind)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.kind, forKey: .kind)
        switch self {
        case let .at(atMs):
            try container.encode(atMs, forKey: .atMs)
        case let .every(everyMs, anchorMs):
            try container.encode(everyMs, forKey: .everyMs)
            try container.encodeIfPresent(anchorMs, forKey: .anchorMs)
        case let .cron(expr, tz):
            try container.encode(expr, forKey: .expr)
            try container.encodeIfPresent(tz, forKey: .tz)
        }
    }
}

enum CronPayload: Codable, Equatable {
    case systemEvent(text: String)
    case agentTurn(
        message: String,
        thinking: String?,
        timeoutSeconds: Int?,
        deliver: Bool?,
        channel: String?,
        to: String?,
        bestEffortDeliver: Bool?)

    enum CodingKeys: String, CodingKey {
        case kind, text, message, thinking, timeoutSeconds, deliver, channel, provider, to, bestEffortDeliver
    }

    var kind: String {
        switch self {
        case .systemEvent: "systemEvent"
        case .agentTurn: "agentTurn"
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "systemEvent":
            self = try .systemEvent(text: container.decode(String.self, forKey: .text))
        case "agentTurn":
            self = try .agentTurn(
                message: container.decode(String.self, forKey: .message),
                thinking: container.decodeIfPresent(String.self, forKey: .thinking),
                timeoutSeconds: container.decodeIfPresent(Int.self, forKey: .timeoutSeconds),
                deliver: container.decodeIfPresent(Bool.self, forKey: .deliver),
                channel: container.decodeIfPresent(String.self, forKey: .channel)
                    ?? container.decodeIfPresent(String.self, forKey: .provider),
                to: container.decodeIfPresent(String.self, forKey: .to),
                bestEffortDeliver: container.decodeIfPresent(Bool.self, forKey: .bestEffortDeliver))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unknown payload kind: \(kind)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.kind, forKey: .kind)
        switch self {
        case let .systemEvent(text):
            try container.encode(text, forKey: .text)
        case let .agentTurn(message, thinking, timeoutSeconds, deliver, channel, to, bestEffortDeliver):
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(thinking, forKey: .thinking)
            try container.encodeIfPresent(timeoutSeconds, forKey: .timeoutSeconds)
            try container.encodeIfPresent(deliver, forKey: .deliver)
            try container.encodeIfPresent(channel, forKey: .channel)
            try container.encodeIfPresent(to, forKey: .to)
            try container.encodeIfPresent(bestEffortDeliver, forKey: .bestEffortDeliver)
        }
    }
}

struct CronIsolation: Codable, Equatable {
    var postToMainPrefix: String?
}

struct CronJobState: Codable, Equatable {
    var nextRunAtMs: Int?
    var runningAtMs: Int?
    var lastRunAtMs: Int?
    var lastStatus: String?
    var lastError: String?
    var lastDurationMs: Int?
}

struct CronJob: Identifiable, Codable, Equatable {
    let id: String
    let agentId: String?
    var name: String
    var description: String?
    var enabled: Bool
    var deleteAfterRun: Bool?
    let createdAtMs: Int
    let updatedAtMs: Int
    let schedule: CronSchedule
    let sessionTarget: CronSessionTarget
    let wakeMode: CronWakeMode
    let payload: CronPayload
    let isolation: CronIsolation?
    let state: CronJobState

    var displayName: String {
        let trimmed = self.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled job" : trimmed
    }

    var nextRunDate: Date? {
        guard let ms = self.state.nextRunAtMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }

    var lastRunDate: Date? {
        guard let ms = self.state.lastRunAtMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }
}

struct CronEvent: Codable, Sendable {
    let jobId: String
    let action: String
    let runAtMs: Int?
    let durationMs: Int?
    let status: String?
    let error: String?
    let summary: String?
    let nextRunAtMs: Int?
}

struct CronRunLogEntry: Codable, Identifiable, Sendable {
    var id: String { "\(self.jobId)-\(self.ts)" }

    let ts: Int
    let jobId: String
    let action: String
    let status: String?
    let error: String?
    let summary: String?
    let runAtMs: Int?
    let durationMs: Int?
    let nextRunAtMs: Int?

    var date: Date { Date(timeIntervalSince1970: TimeInterval(self.ts) / 1000) }
    var runDate: Date? {
        guard let runAtMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(runAtMs) / 1000)
    }
}

struct CronListResponse: Codable {
    let jobs: [CronJob]
}

struct CronRunsResponse: Codable {
    let entries: [CronRunLogEntry]
}
