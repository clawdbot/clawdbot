import Foundation

enum CronSessionTarget: String, CaseIterable, Identifiable, Codable {
    case main
    case isolated
    case current

    var id: String {
        self.rawValue
    }
}

enum CronCustomSessionTarget: Codable, Equatable {
    case predefined(CronSessionTarget)
    case session(id: String)

    var rawValue: String {
        switch self {
        case let .predefined(target):
            target.rawValue
        case let .session(id):
            "session:\(id)"
        }
    }

    static func from(_ value: String) -> CronCustomSessionTarget {
        if let predefined = CronSessionTarget(rawValue: value) {
            return .predefined(predefined)
        }
        if value.hasPrefix("session:") {
            let sessionId = String(value.dropFirst(8))
            return .session(id: sessionId)
        }
        // Fallback to isolated for unknown values
        return .predefined(.isolated)
    }
}

enum CronWakeMode: String, CaseIterable, Identifiable, Codable {
    case now
    case nextHeartbeat = "next-heartbeat"

    var id: String {
        self.rawValue
    }
}

enum CronDeliveryMode: String, CaseIterable, Identifiable, Codable {
    case none
    case announce
    case webhook

    var id: String {
        self.rawValue
    }
}

struct CronDelivery: Codable, Equatable {
    var mode: CronDeliveryMode
    var channel: String?
    var to: String?
    var bestEffort: Bool?
}

enum CronSchedule: Codable, Equatable {
    case at(at: String)
    case every(everyMs: Int, anchorMs: Int?)
    case cron(expr: String, tz: String?)
    case onExit(command: String, cwd: String?)

    enum CodingKeys: String, CodingKey { case kind, at, atMs, everyMs, anchorMs, expr, tz, command, cwd }

    var kind: String {
        switch self {
        case .at: "at"
        case .every: "every"
        case .cron: "cron"
        case .onExit: "on-exit"
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "at":
            if let at = try container.decodeIfPresent(String.self, forKey: .at),
               !at.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                self = .at(at: at)
                return
            }
            if let atMs = try container.decodeIfPresent(Int.self, forKey: .atMs) {
                let date = Date(timeIntervalSince1970: TimeInterval(atMs) / 1000)
                self = .at(at: Self.formatIsoDate(date))
                return
            }
            throw DecodingError.dataCorruptedError(
                forKey: .at,
                in: container,
                debugDescription: "Missing schedule.at")
        case "every":
            self = try .every(
                everyMs: container.decode(Int.self, forKey: .everyMs),
                anchorMs: container.decodeIfPresent(Int.self, forKey: .anchorMs))
        case "cron":
            self = try .cron(
                expr: container.decode(String.self, forKey: .expr),
                tz: container.decodeIfPresent(String.self, forKey: .tz))
        case "on-exit":
            self = try .onExit(
                command: container.decode(String.self, forKey: .command),
                cwd: container.decodeIfPresent(String.self, forKey: .cwd))
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
        case let .at(at):
            try container.encode(at, forKey: .at)
        case let .every(everyMs, anchorMs):
            try container.encode(everyMs, forKey: .everyMs)
            try container.encodeIfPresent(anchorMs, forKey: .anchorMs)
        case let .cron(expr, tz):
            try container.encode(expr, forKey: .expr)
            try container.encodeIfPresent(tz, forKey: .tz)
        case let .onExit(command, cwd):
            try container.encode(command, forKey: .command)
            try container.encodeIfPresent(cwd, forKey: .cwd)
        }
    }

    static func parseAtDate(_ value: String) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if let date = makeIsoFormatter(withFractional: true).date(from: trimmed) { return date }
        return self.makeIsoFormatter(withFractional: false).date(from: trimmed)
    }

    static func formatIsoDate(_ date: Date) -> String {
        self.makeIsoFormatter(withFractional: false).string(from: date)
    }

    private static func makeIsoFormatter(withFractional: Bool) -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = withFractional
            ? [.withInternetDateTime, .withFractionalSeconds]
            : [.withInternetDateTime]
        return formatter
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
    case command(
        argv: [String],
        cwd: String?,
        env: [String: String]?,
        input: String?,
        timeoutSeconds: Int?,
        noOutputTimeoutSeconds: Int?,
        outputMaxBytes: Int?,
        toolsAllow: [String]?,
        toolsAllowIsDefault: Bool?)
    case script(
        script: String,
        timeoutSeconds: Int?,
        toolBudget: Int?,
        toolsAllow: [String]?,
        toolsAllowIsDefault: Bool?)

    enum CodingKeys: String, CodingKey {
        case kind, text, message, thinking, timeoutSeconds, deliver, channel, provider, to, bestEffortDeliver
        case argv, cwd, env, input, noOutputTimeoutSeconds, outputMaxBytes
        case script, toolBudget, toolsAllow, toolsAllowIsDefault
    }

    var kind: String {
        switch self {
        case .systemEvent: "systemEvent"
        case .agentTurn: "agentTurn"
        case .command: "command"
        case .script: "script"
        }
    }

    var isEditableInMacApp: Bool {
        switch self {
        case .systemEvent, .agentTurn: true
        case .command, .script: false
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
        case "command":
            self = try .command(
                argv: container.decode([String].self, forKey: .argv),
                cwd: container.decodeIfPresent(String.self, forKey: .cwd),
                env: container.decodeIfPresent([String: String].self, forKey: .env),
                input: container.decodeIfPresent(String.self, forKey: .input),
                timeoutSeconds: container.decodeIfPresent(Int.self, forKey: .timeoutSeconds),
                noOutputTimeoutSeconds: container.decodeIfPresent(Int.self, forKey: .noOutputTimeoutSeconds),
                outputMaxBytes: container.decodeIfPresent(Int.self, forKey: .outputMaxBytes),
                toolsAllow: container.decodeIfPresent([String].self, forKey: .toolsAllow),
                toolsAllowIsDefault: container.decodeIfPresent(Bool.self, forKey: .toolsAllowIsDefault))
        case "script":
            self = try .script(
                script: container.decode(String.self, forKey: .script),
                timeoutSeconds: container.decodeIfPresent(Int.self, forKey: .timeoutSeconds),
                toolBudget: container.decodeIfPresent(Int.self, forKey: .toolBudget),
                toolsAllow: container.decodeIfPresent([String].self, forKey: .toolsAllow),
                toolsAllowIsDefault: container.decodeIfPresent(Bool.self, forKey: .toolsAllowIsDefault))
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
        case let .command(
            argv,
            cwd,
            env,
            input,
            timeoutSeconds,
            noOutputTimeoutSeconds,
            outputMaxBytes,
            toolsAllow,
            toolsAllowIsDefault):
            try container.encode(argv, forKey: .argv)
            try container.encodeIfPresent(cwd, forKey: .cwd)
            try container.encodeIfPresent(env, forKey: .env)
            try container.encodeIfPresent(input, forKey: .input)
            try container.encodeIfPresent(timeoutSeconds, forKey: .timeoutSeconds)
            try container.encodeIfPresent(noOutputTimeoutSeconds, forKey: .noOutputTimeoutSeconds)
            try container.encodeIfPresent(outputMaxBytes, forKey: .outputMaxBytes)
            try container.encodeIfPresent(toolsAllow, forKey: .toolsAllow)
            try container.encodeIfPresent(toolsAllowIsDefault, forKey: .toolsAllowIsDefault)
        case let .script(script, timeoutSeconds, toolBudget, toolsAllow, toolsAllowIsDefault):
            try container.encode(script, forKey: .script)
            try container.encodeIfPresent(timeoutSeconds, forKey: .timeoutSeconds)
            try container.encodeIfPresent(toolBudget, forKey: .toolBudget)
            try container.encodeIfPresent(toolsAllow, forKey: .toolsAllow)
            try container.encodeIfPresent(toolsAllowIsDefault, forKey: .toolsAllowIsDefault)
        }
    }
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
    private let sessionTargetRaw: String
    let wakeMode: CronWakeMode
    let payload: CronPayload
    let delivery: CronDelivery?
    let state: CronJobState

    enum CodingKeys: String, CodingKey {
        case id
        case agentId
        case name
        case description
        case enabled
        case deleteAfterRun
        case createdAtMs
        case updatedAtMs
        case schedule
        case sessionTargetRaw = "sessionTarget"
        case wakeMode
        case payload
        case delivery
        case state
    }

    init(
        id: String,
        agentId: String?,
        name: String,
        description: String?,
        enabled: Bool,
        deleteAfterRun: Bool?,
        createdAtMs: Int,
        updatedAtMs: Int,
        schedule: CronSchedule,
        sessionTarget: CronSessionTarget,
        wakeMode: CronWakeMode,
        payload: CronPayload,
        delivery: CronDelivery?,
        state: CronJobState)
    {
        self.init(
            id: id,
            agentId: agentId,
            name: name,
            description: description,
            enabled: enabled,
            deleteAfterRun: deleteAfterRun,
            createdAtMs: createdAtMs,
            updatedAtMs: updatedAtMs,
            schedule: schedule,
            sessionTarget: .predefined(sessionTarget),
            wakeMode: wakeMode,
            payload: payload,
            delivery: delivery,
            state: state)
    }

    init(
        id: String,
        agentId: String?,
        name: String,
        description: String?,
        enabled: Bool,
        deleteAfterRun: Bool?,
        createdAtMs: Int,
        updatedAtMs: Int,
        schedule: CronSchedule,
        sessionTarget: CronCustomSessionTarget,
        wakeMode: CronWakeMode,
        payload: CronPayload,
        delivery: CronDelivery?,
        state: CronJobState)
    {
        self.id = id
        self.agentId = agentId
        self.name = name
        self.description = description
        self.enabled = enabled
        self.deleteAfterRun = deleteAfterRun
        self.createdAtMs = createdAtMs
        self.updatedAtMs = updatedAtMs
        self.schedule = schedule
        self.sessionTargetRaw = sessionTarget.rawValue
        self.wakeMode = wakeMode
        self.payload = payload
        self.delivery = delivery
        self.state = state
    }

    /// Parsed session target (predefined or custom session ID)
    var parsedSessionTarget: CronCustomSessionTarget {
        CronCustomSessionTarget.from(self.sessionTargetRaw)
    }

    /// Compatibility shim for existing editor/UI code paths that still use the
    /// predefined enum.
    var sessionTarget: CronSessionTarget {
        switch self.parsedSessionTarget {
        case let .predefined(target):
            target
        case .session:
            .isolated
        }
    }

    var sessionTargetDisplayValue: String {
        self.parsedSessionTarget.rawValue
    }

    var transcriptSessionKey: String? {
        switch self.parsedSessionTarget {
        case .predefined(.main):
            nil
        case .predefined(.isolated), .predefined(.current):
            "cron:\(self.id)"
        case let .session(id):
            id
        }
    }

    var supportsAnnounceDelivery: Bool {
        switch self.parsedSessionTarget {
        case .predefined(.main):
            false
        case .predefined(.isolated), .predefined(.current), .session:
            true
        }
    }

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

struct CronEvent: Codable {
    let jobId: String
    let action: String
    let runAtMs: Int?
    let durationMs: Int?
    let status: String?
    let error: String?
    let summary: String?
    let nextRunAtMs: Int?
}

struct CronRunLogEntry: Codable, Identifiable {
    var id: String {
        "\(self.jobId)-\(self.ts)"
    }

    let ts: Int
    let jobId: String
    let action: String
    let status: String?
    let error: String?
    let summary: String?
    let runAtMs: Int?
    let durationMs: Int?
    let nextRunAtMs: Int?

    var date: Date {
        Date(timeIntervalSince1970: TimeInterval(self.ts) / 1000)
    }

    var runDate: Date? {
        guard let runAtMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(runAtMs) / 1000)
    }
}
