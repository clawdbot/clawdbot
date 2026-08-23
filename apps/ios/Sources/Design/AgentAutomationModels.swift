import Foundation
import Observation
import OpenClawProtocol

enum AgentAutomationScheduleDraft: Equatable {
    case at(at: String)
    case every(everyMs: String, anchorMs: String)
    case cron(expression: String, timezone: String, staggerMs: String)
    case onExit(command: String, cwd: String)

    var kindLabel: String {
        switch self {
        case .at: String(localized: "One time")
        case .every: String(localized: "Interval")
        case .cron: String(localized: "Cron expression")
        case .onExit: String(localized: "On command exit")
        }
    }
}

enum AgentAutomationPayloadDraft: Equatable {
    case systemEvent(text: String)
    case agentTurn(message: String, model: String, thinking: String)
    case command(argvJSON: String, cwd: String)

    var kindLabel: String {
        switch self {
        case .systemEvent: String(localized: "System event")
        case .agentTurn: String(localized: "Agent turn")
        case .command: String(localized: "Command")
        }
    }
}

struct AgentAutomationDraft: Equatable {
    var name: String
    var description: String
    var enabled: Bool
    var deleteAfterRun: Bool
    var schedule: AgentAutomationScheduleDraft
    var sessionTarget: String
    var wakeMode: String
    var payload: AgentAutomationPayloadDraft

    init?(job: CronJob) {
        guard let schedule = Self.schedule(from: job.schedule),
              let payload = Self.payload(from: job.payload),
              let sessionTarget = AgentAutomationValue.string(job.sessiontarget),
              let wakeMode = AgentAutomationValue.string(job.wakemode)
        else { return nil }
        self.name = job.name
        self.description = job.description ?? ""
        self.enabled = job.enabled
        if case .at = schedule {
            self.deleteAfterRun = job.deleteafterrun == true
        } else {
            self.deleteAfterRun = false
        }
        self.schedule = schedule
        self.sessionTarget = sessionTarget
        self.wakeMode = wakeMode
        self.payload = payload
    }

    private static func schedule(from value: AnyCodable) -> AgentAutomationScheduleDraft? {
        guard let object = AgentAutomationValue.object(value),
              let kind = AgentAutomationValue.string(object["kind"])
        else { return nil }
        switch kind {
        case "at":
            guard let at = AgentAutomationValue.string(object["at"]) else { return nil }
            return .at(at: at)
        case "every":
            guard let everyMs = AgentAutomationValue.int(object["everyMs"]) else { return nil }
            return .every(
                everyMs: String(everyMs),
                anchorMs: AgentAutomationValue.int(object["anchorMs"]).map(String.init) ?? "")
        case "cron":
            guard let expression = AgentAutomationValue.string(object["expr"]) else { return nil }
            return .cron(
                expression: expression,
                timezone: AgentAutomationValue.string(object["tz"]) ?? "",
                staggerMs: AgentAutomationValue.int(object["staggerMs"]).map(String.init) ?? "")
        case "on-exit":
            guard let command = AgentAutomationValue.string(object["command"]) else { return nil }
            return .onExit(command: command, cwd: AgentAutomationValue.string(object["cwd"]) ?? "")
        default:
            return nil
        }
    }

    private static func payload(from value: AnyCodable) -> AgentAutomationPayloadDraft? {
        guard let object = AgentAutomationValue.object(value),
              let kind = AgentAutomationValue.string(object["kind"])
        else { return nil }
        switch kind {
        case "systemEvent":
            guard let text = AgentAutomationValue.string(object["text"]) else { return nil }
            return .systemEvent(text: text)
        case "agentTurn":
            guard let message = AgentAutomationValue.string(object["message"]) else { return nil }
            return .agentTurn(
                message: message,
                model: AgentAutomationValue.string(object["model"]) ?? "",
                thinking: AgentAutomationValue.string(object["thinking"]) ?? "")
        case "command":
            guard let argv = AgentAutomationValue.strings(object["argv"]), !argv.isEmpty else { return nil }
            let data = try? JSONSerialization.data(withJSONObject: argv, options: [.sortedKeys])
            let argvJSON = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
            return .command(argvJSON: argvJSON, cwd: AgentAutomationValue.string(object["cwd"]) ?? "")
        default:
            return nil
        }
    }
}

struct AgentAutomationRunsResponse: Decodable {
    let entries: [CronRunLogEntry]
}

struct AgentAutomationRunResult: Decodable {
    let ok: Bool
    let ran: Bool?
    let enqueued: Bool?
    let runId: String?
    let processInstanceId: String?
    let reason: String?
}

@Observable
@MainActor
final class AgentAutomationPendingRunRegistry {
    private var runIDsByJobID: [String: String] = [:]

    func runID(for jobID: String) -> String? {
        self.runIDsByJobID[jobID]
    }

    @discardableResult
    func reserve(jobID: String, runID: String) -> Bool {
        guard self.runIDsByJobID[jobID] == nil else { return false }
        self.runIDsByJobID[jobID] = runID
        return true
    }

    func release(jobID: String, runID: String) {
        // Only the owning tracker may clear a reservation; a stale completion
        // must not reopen Run while a newer exact run is still pending.
        guard self.runIDsByJobID[jobID] == runID else { return }
        self.runIDsByJobID.removeValue(forKey: jobID)
    }
}

func agentAutomationRunSkipShouldRefresh(reason: String?) -> Bool {
    reason == "invalid-spec"
}

enum AgentAutomationRunOutcome: Equatable {
    case success
    case skipped
    case failure
    case unknown
}

func agentAutomationRunOutcome(status: String?, error: String?) -> AgentAutomationRunOutcome {
    let normalizedStatus = status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if error?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false || normalizedStatus == "error" {
        return .failure
    }
    switch normalizedStatus {
    case "ok": return .success
    case "skipped": return .skipped
    default: return .unknown
    }
}

func agentAutomationDeletesAfterSuccessfulRun(job: CronJob, outcome: AgentAutomationRunOutcome) -> Bool {
    guard outcome == .success,
          job.deleteafterrun == true,
          let draft = AgentAutomationDraft(job: job)
    else { return false }
    if case .at = draft.schedule { return true }
    return false
}

enum AgentAutomationEditError: LocalizedError {
    case invalidModel
    case missingRevision
    case noChanges
    case invalidName
    case invalidSessionTarget
    case invalidWakeMode
    case invalidSchedule(String)
    case invalidPayload(String)
    case gatewayChanged
    case gatewayChangedAfterDispatch
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidModel: String(localized: "This automation uses fields this app cannot edit safely.")
        case .missingRevision: String(localized: "Update the Gateway before saving automation changes from iOS.")
        case .noChanges: String(localized: "No automation changes to save.")
        case .invalidName: String(localized: "Automation name is required.")
        case .invalidSessionTarget:
            String(localized: "Session target must be main, isolated, current, or session:<id>.")
        case .invalidWakeMode: String(localized: "Wake mode must be now or next-heartbeat.")
        case let .invalidSchedule(message), let .invalidPayload(message): message
        case .gatewayChanged: String(localized: "The connected Gateway changed. Refresh Automations and try again.")
        case .gatewayChangedAfterDispatch:
            String(localized: "The Gateway changed after the request was sent. Check current state before retrying.")
        case .invalidResponse: String(localized: "The Gateway returned an unexpected automation response.")
        }
    }
}

enum AgentAutomationValue {
    static func object(_ value: AnyCodable?) -> [String: AnyCodable]? {
        value?.value as? [String: AnyCodable]
    }

    static func string(_ value: AnyCodable?) -> String? {
        (value?.value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func int(_ value: AnyCodable?) -> Int? {
        switch value?.value {
        case let value as Int: value
        case let value as Double where value.isFinite: Int(value)
        case let value as String: Int(value)
        default: nil
        }
    }

    static func strings(_ value: AnyCodable?) -> [String]? {
        if let values = value?.value as? [String] { return values }
        return (value?.value as? [AnyCodable])?.compactMap { $0.value as? String }
    }
}

func buildAgentAutomationUpdateParams(job: CronJob, draft: AgentAutomationDraft) throws -> String {
    guard let baseline = AgentAutomationDraft(job: job) else { throw AgentAutomationEditError.invalidModel }
    guard let revision = job.configrevision, !revision.isEmpty else { throw AgentAutomationEditError.missingRevision }
    let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { throw AgentAutomationEditError.invalidName }
    let description = draft.description.trimmingCharacters(in: .whitespacesAndNewlines)
    let sessionTarget = draft.sessionTarget.trimmingCharacters(in: .whitespacesAndNewlines)
    guard validAgentAutomationSessionTarget(sessionTarget) else {
        throw AgentAutomationEditError.invalidSessionTarget
    }
    let wakeMode = draft.wakeMode.trimmingCharacters(in: .whitespacesAndNewlines)
    guard wakeMode == "now" || wakeMode == "next-heartbeat" else {
        throw AgentAutomationEditError.invalidWakeMode
    }

    var patch: [String: Any] = [:]
    if name != baseline.name { patch["name"] = name }
    if description != baseline.description { patch["description"] = description }
    if draft.enabled != baseline.enabled { patch["enabled"] = draft.enabled }
    if draft.deleteAfterRun != baseline.deleteAfterRun { patch["deleteAfterRun"] = draft.deleteAfterRun }
    if let schedule = try agentAutomationScheduleJSON(draft.schedule, baseline: baseline.schedule) {
        patch["schedule"] = schedule
    }
    if sessionTarget != baseline.sessionTarget { patch["sessionTarget"] = sessionTarget }
    if wakeMode != baseline.wakeMode { patch["wakeMode"] = wakeMode }
    if let payload = try agentAutomationPayloadJSON(draft.payload, baseline: baseline.payload) {
        patch["payload"] = payload
    }
    guard !patch.isEmpty else { throw AgentAutomationEditError.noChanges }
    return try encodeAgentAutomationParams([
        "id": job.id,
        "expectedConfigRevision": revision,
        "patch": patch,
    ])
}

func agentAutomationHasSemanticChanges(job: CronJob, draft: AgentAutomationDraft) -> Bool {
    do {
        _ = try buildAgentAutomationUpdateParams(job: job, draft: draft)
        return true
    } catch AgentAutomationEditError.noChanges {
        return false
    } catch {
        return draft != AgentAutomationDraft(job: job)
    }
}

func buildAgentAutomationEnabledParams(job: CronJob, enabled: Bool) throws -> String {
    guard let revision = job.configrevision, !revision.isEmpty else { throw AgentAutomationEditError.missingRevision }
    return try encodeAgentAutomationParams([
        "id": job.id,
        "expectedConfigRevision": revision,
        "patch": ["enabled": enabled],
    ])
}

private func validAgentAutomationSessionTarget(_ value: String) -> Bool {
    value == "main" || value == "isolated" || value == "current"
        || (value.hasPrefix("session:") && !value.dropFirst("session:".count).isEmpty)
}

private func agentAutomationScheduleJSON(
    _ schedule: AgentAutomationScheduleDraft,
    baseline: AgentAutomationScheduleDraft) throws -> [String: Any]?
{
    switch (schedule, baseline) {
    case let (.at(at), .at(oldAt)):
        let value = at.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw AgentAutomationEditError.invalidSchedule(String(localized: "One-time automations need an ISO time."))
        }
        guard value != oldAt else { return nil }
        return ["kind": "at", "at": value]
    case let (.every(everyMs, anchorMs), .every(oldEveryMs, oldAnchorMs)):
        guard let interval = Int(everyMs), interval > 0 else {
            throw AgentAutomationEditError.invalidSchedule(
                String(localized: "Interval must be a positive number of milliseconds."))
        }
        let anchor = try optionalNonNegativeAgentAutomationInt(
            anchorMs,
            error: String(localized: "Anchor must be a non-negative number of milliseconds."))
        guard interval != Int(oldEveryMs) || anchor != Int(oldAnchorMs) else { return nil }
        var result: [String: Any] = ["kind": "every", "everyMs": interval]
        if let anchor { result["anchorMs"] = anchor }
        return result
    case let (.cron(expression, timezone, staggerMs), .cron(oldExpression, oldTimezone, oldStaggerMs)):
        let expr = expression.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !expr.isEmpty else {
            throw AgentAutomationEditError.invalidSchedule(String(localized: "Cron expression is required."))
        }
        let timezone = timezone.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedStagger = try optionalNonNegativeAgentAutomationInt(
            staggerMs,
            error: String(localized: "Stagger must be a non-negative number of milliseconds."))
        let stagger = requestedStagger ?? (oldStaggerMs.isEmpty ? nil : 0)
        guard expr != oldExpression
            || timezone != oldTimezone
            || stagger != Int(oldStaggerMs)
        else { return nil }
        var result: [String: Any] = ["kind": "cron", "expr": expr]
        if !timezone.isEmpty { result["tz"] = timezone }
        if let stagger { result["staggerMs"] = stagger }
        return result
    case let (.onExit(command, cwd), .onExit(oldCommand, oldCwd)):
        let command = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            throw AgentAutomationEditError.invalidSchedule(
                String(localized: "On-exit automations need a command."))
        }
        let cwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard command != oldCommand || cwd != oldCwd else { return nil }
        var result: [String: Any] = ["kind": "on-exit", "command": command]
        if !cwd.isEmpty { result["cwd"] = cwd }
        return result
    default:
        throw AgentAutomationEditError.invalidSchedule(
            String(localized: "Changing schedule type is available in the Control UI."))
    }
}

private func optionalNonNegativeAgentAutomationInt(_ raw: String, error message: String) throws -> Int? {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return nil }
    guard let parsed = Int(value), parsed >= 0 else {
        throw AgentAutomationEditError.invalidSchedule(message)
    }
    return parsed
}

private func agentAutomationPayloadJSON(
    _ payload: AgentAutomationPayloadDraft,
    baseline: AgentAutomationPayloadDraft) throws -> [String: Any]?
{
    switch (payload, baseline) {
    case let (.systemEvent(text), .systemEvent(oldText)):
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            throw AgentAutomationEditError.invalidPayload(String(localized: "System event text is required."))
        }
        guard text != oldText else { return nil }
        return ["kind": "systemEvent", "text": text]
    case let (.agentTurn(message, model, thinking), .agentTurn(oldMessage, oldModel, oldThinking)):
        let message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            throw AgentAutomationEditError.invalidPayload(String(localized: "Agent message is required."))
        }
        let model = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let thinking = thinking.trimmingCharacters(in: .whitespacesAndNewlines)
        guard message != oldMessage || model != oldModel || thinking != oldThinking else { return nil }
        var result: [String: Any] = ["kind": "agentTurn"]
        if message != oldMessage { result["message"] = message }
        if model != oldModel { result["model"] = model.isEmpty ? NSNull() : model }
        if thinking != oldThinking { result["thinking"] = thinking.isEmpty ? NSNull() : thinking }
        return result
    case let (.command(argvJSON, cwd), .command(oldArgvJSON, oldCwd)):
        guard let data = argvJSON.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let argv = object as? [String],
              !argv.isEmpty,
              argv.allSatisfy({ !$0.isEmpty })
        else {
            throw AgentAutomationEditError.invalidPayload(
                String(localized: "Command arguments must be a JSON array of non-empty strings."))
        }
        let cwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        if !oldCwd.isEmpty, cwd.isEmpty {
            throw AgentAutomationEditError.invalidPayload(
                String(localized: "The Gateway can change this command path but cannot clear it."))
        }
        let oldArgv: [String] = if let oldData = oldArgvJSON.data(using: .utf8),
                                   let oldObject = try? JSONSerialization.jsonObject(with: oldData),
                                   let parsed = oldObject as? [String]
        {
            parsed
        } else {
            []
        }
        guard argv != oldArgv || cwd != oldCwd else { return nil }
        var result: [String: Any] = ["kind": "command"]
        if argv != oldArgv { result["argv"] = argv }
        if cwd != oldCwd { result["cwd"] = cwd }
        return result
    default:
        throw AgentAutomationEditError.invalidPayload(
            String(localized: "Changing action type is available in the Control UI."))
    }
}

private func encodeAgentAutomationParams(_ value: [String: Any]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let text = String(data: data, encoding: .utf8) else {
        throw AgentAutomationEditError.invalidPayload(String(localized: "Could not encode automation changes."))
    }
    return text
}
