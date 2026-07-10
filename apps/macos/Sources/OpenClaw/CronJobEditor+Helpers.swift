import Foundation
import OpenClawProtocol
import SwiftUI

extension CronJobEditor {
    func gridLabel(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(width: self.labelColumnWidth, alignment: .leading)
    }

    func hydrateFromJob() {
        guard let job else { return }
        self.name = job.name
        self.description = job.description ?? ""
        self.agentId = job.agentId ?? ""
        self.enabled = job.enabled
        self.deleteAfterRun = job.deleteAfterRun ?? false
        switch job.parsedSessionTarget {
        case let .predefined(target):
            self.sessionTarget = target
            self.preservedSessionTargetRaw = nil
        case let .session(id):
            self.sessionTarget = .isolated
            self.preservedSessionTargetRaw = "session:\(id)"
        }
        self.wakeMode = job.wakeMode

        switch job.schedule {
        case let .at(at):
            self.scheduleKind = .at
            if let date = CronSchedule.parseAtDate(at) {
                self.atDate = date
            }
        case let .every(everyMs, _):
            self.scheduleKind = .every
            self.everyText = self.formatDuration(ms: everyMs)
        case let .cron(expr, tz):
            self.scheduleKind = .cron
            self.cronExpr = expr
            self.cronTz = tz ?? ""
        case .onExit:
            // on-exit jobs are CLI-managed and have no editor form yet; fall back to
            // the cron form so the editor still OPENS instead of failing to compile.
            // Saving an on-exit job from the editor should be gated to avoid rewriting
            // it as cron — tracked as a macOS read-only-editor follow-up.
            self.scheduleKind = .cron
        }

        switch job.payload {
        case let .systemEvent(text):
            self.payloadKind = .systemEvent
            self.systemEventText = text
        case let .agentTurn(message, thinking, timeoutSeconds, _, _, _, _):
            self.payloadKind = .agentTurn
            self.agentMessage = message
            self.thinking = thinking ?? ""
            self.timeoutSeconds = timeoutSeconds.map(String.init) ?? ""
        }

        if let delivery = job.delivery {
            self.deliveryMode = delivery.mode == .announce ? .announce : .none
            let trimmed = (delivery.channel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self.channel = trimmed.isEmpty ? "last" : trimmed
            self.to = delivery.to ?? ""
            self.bestEffortDeliver = delivery.bestEffort ?? false
        } else if self.isIsolatedLikeSessionTarget {
            self.deliveryMode = .announce
        }
    }

    func save() {
        do {
            self.error = nil
            let payload = try self.buildPayload()
            self.onSave(payload)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func buildPayload() throws -> [String: AnyCodable] {
        // Gate on-exit saves: the editor has no on-exit schedule form (it falls back to
        // the cron form), so saving would rewrite the on-exit schedule as cron and
        // corrupt the job. Block it until a read-only/native on-exit editor exists.
        if let job, case .onExit = job.schedule {
            throw NSError(
                domain: "Cron",
                code: 0,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "on-exit cron jobs can't be edited in the macOS app yet; manage them with the CLI.",
                ])
        }
        let name = try self.requireName()
        let description = self.trimmed(self.description)
        let agentId = self.trimmed(self.agentId)
        let schedule = try self.buildSchedule()
        let payload = try self.buildSelectedPayload()

        try self.validateSessionTarget(payload)
        try self.validatePayloadRequiredFields(payload)

        var root: [String: Any] = [
            "name": name,
            "enabled": self.enabled,
            "schedule": schedule,
            "sessionTarget": self.effectiveSessionTargetRaw,
            "wakeMode": self.wakeMode.rawValue,
            "payload": payload,
        ]
        self.applyDeleteAfterRun(to: &root)
        if !description.isEmpty {
            root["description"] = description
        }
        if !agentId.isEmpty {
            root["agentId"] = agentId
        } else if self.job?.agentId != nil {
            root["agentId"] = NSNull()
        }

        if self.isIsolatedLikeSessionTarget {
            root["delivery"] = self.buildDelivery()
        }

        return root.mapValues { AnyCodable($0) }
    }

    func buildDelivery() -> [String: Any] {
        let mode = self.deliveryMode == .announce ? "announce" : "none"
        var delivery: [String: Any] = ["mode": mode]
        if self.deliveryMode == .announce {
            let trimmed = self.channel.trimmingCharacters(in: .whitespacesAndNewlines)
            delivery["channel"] = trimmed.isEmpty ? "last" : trimmed
            let to = self.to.trimmingCharacters(in: .whitespacesAndNewlines)
            if !to.isEmpty {
                delivery["to"] = to
            }
            if self.bestEffortDeliver {
                delivery["bestEffort"] = true
            } else if self.job?.delivery?.bestEffort == true {
                delivery["bestEffort"] = false
            }
        }
        return delivery
    }

    func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func requireName() throws -> String {
        let name = self.trimmed(self.name)
        if name.isEmpty {
            throw NSError(
                domain: "Cron",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Name is required."])
        }
        return name
    }

    func buildSchedule() throws -> [String: Any] {
        switch self.scheduleKind {
        case .at:
            return ["kind": "at", "at": CronSchedule.formatIsoDate(self.atDate)]
        case .every:
            guard let ms = Self.parseDurationMs(self.everyText) else {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid every duration (use 10m, 1h, 1d)."])
            }
            return ["kind": "every", "everyMs": ms]
        case .cron:
            let expr = self.trimmed(self.cronExpr)
            if expr.isEmpty {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Cron expression is required."])
            }
            let tz = self.trimmed(self.cronTz)
            if tz.isEmpty {
                return ["kind": "cron", "expr": expr]
            }
            return ["kind": "cron", "expr": expr, "tz": tz]
        }
    }

    func buildSelectedPayload() throws -> [String: Any] {
        if self.isIsolatedLikeSessionTarget {
            return self.buildAgentTurnPayload()
        }
        switch self.payloadKind {
        case .systemEvent:
            let text = self.trimmed(self.systemEventText)
            return ["kind": "systemEvent", "text": text]
        case .agentTurn:
            return self.buildAgentTurnPayload()
        }
    }

    func validateSessionTarget(_ payload: [String: Any]) throws {
        if self.effectiveSessionTargetRaw == "main", payload["kind"] as? String == "agentTurn" {
            throw NSError(
                domain: "Cron",
                code: 0,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Main session jobs require systemEvent payloads (switch Session target to isolated).",
                ])
        }

        if self.effectiveSessionTargetRaw != "main", payload["kind"] as? String == "systemEvent" {
            throw NSError(
                domain: "Cron",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Isolated jobs require agentTurn payloads."])
        }
    }

    func validatePayloadRequiredFields(_ payload: [String: Any]) throws {
        if payload["kind"] as? String == "systemEvent" {
            if (payload["text"] as? String ?? "").isEmpty {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "System event text is required."])
            }
        }
        if payload["kind"] as? String == "agentTurn" {
            if (payload["message"] as? String ?? "").isEmpty {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Agent message is required."])
            }
        }
    }

    func applyDeleteAfterRun(
        to root: inout [String: Any],
        scheduleKind: ScheduleKind? = nil,
        deleteAfterRun: Bool? = nil)
    {
        let resolvedSchedule = scheduleKind ?? self.scheduleKind
        let resolvedDelete = deleteAfterRun ?? self.deleteAfterRun
        if resolvedSchedule == .at {
            root["deleteAfterRun"] = resolvedDelete
        } else if self.job?.deleteAfterRun != nil {
            root["deleteAfterRun"] = false
        }
    }

    func buildAgentTurnPayload() -> [String: Any] {
        let msg = self.agentMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        var payload: [String: Any] = ["kind": "agentTurn", "message": msg]
        let thinking = self.thinking.trimmingCharacters(in: .whitespacesAndNewlines)
        if !thinking.isEmpty {
            payload["thinking"] = thinking
        }
        if let n = Int(self.timeoutSeconds), n > 0 {
            payload["timeoutSeconds"] = n
        }
        return payload
    }

    static func parseDurationMs(_ input: String) -> Int? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty {
            return nil
        }

        let rx = try? NSRegularExpression(pattern: "^(\\d+(?:\\.\\d+)?)(ms|s|m|h|d)$", options: [.caseInsensitive])
        guard let match = rx?.firstMatch(in: raw, range: NSRange(location: 0, length: raw.utf16.count)) else {
            return nil
        }
        func group(_ idx: Int) -> String {
            let range = match.range(at: idx)
            guard let r = Range(range, in: raw) else { return "" }
            return String(raw[r])
        }
        let n = Double(group(1)) ?? 0
        if !n.isFinite || n <= 0 {
            return nil
        }
        let unit = group(2).lowercased()
        let factor: Double = switch unit {
        case "ms": 1
        case "s": 1000
        case "m": 60000
        case "h": 3_600_000
        default: 86_400_000
        }
        return Int(floor(n * factor))
    }

    var effectiveSessionTargetRaw: String {
        if self.sessionTarget == .isolated,
           let preserved = self.preservedSessionTargetRaw?.trimmingCharacters(in: .whitespacesAndNewlines),
           !preserved.isEmpty
        {
            return preserved
        }
        return self.sessionTarget.rawValue
    }

    var isIsolatedLikeSessionTarget: Bool {
        self.effectiveSessionTargetRaw != "main"
    }

    func formatDuration(ms: Int) -> String {
        DurationFormattingSupport.conciseDuration(ms: ms)
    }
}
