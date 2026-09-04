import Foundation

/// A phone-committed routing owner, captured before the Watch accepts user input.
public struct OpenClawWatchChatDeliveryContext: Codable, Sendable, Hashable {
    public let version: Int
    public let gatewayStableID: String
    public let routeGeneration: String
    public let agentId: String
    public let sessionKey: String
    public let deliverySessionKey: String
    public let sessionRoutingContract: String

    public init(
        gatewayStableID: String,
        routeGeneration: String,
        agentId: String,
        sessionKey: String,
        deliverySessionKey: String,
        sessionRoutingContract: String,
        version: Int = 1)
    {
        self.version = version
        self.gatewayStableID = gatewayStableID
        self.routeGeneration = routeGeneration
        self.agentId = agentId
        self.sessionKey = sessionKey
        self.deliverySessionKey = deliverySessionKey
        self.sessionRoutingContract = sessionRoutingContract
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.version == rhs.version && lhs.identityBytes == rhs.identityBytes
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(self.version)
        hasher.combine(self.identityBytes)
    }

    private var identityBytes: [Data] {
        [
            self.gatewayStableID,
            self.routeGeneration,
            self.agentId,
            self.sessionKey,
            self.deliverySessionKey,
            self.sessionRoutingContract,
        ].map { Data($0.utf8) }
    }
}

public enum OpenClawWatchChatDeliveryKind: String, Codable, Sendable {
    case chat
    case quickReply
}

public enum OpenClawWatchChatDeliveryBody: Codable, Sendable, Equatable {
    case chat(text: String)
    case quickReply(promptId: String, actionId: String, actionLabel: String?, note: String?)

    public var kind: OpenClawWatchChatDeliveryKind {
        switch self {
        case .chat: .chat
        case .quickReply: .quickReply
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case let (.chat(left), .chat(right)):
            left.utf8.elementsEqual(right.utf8)
        case let (.quickReply(lp, la, ll, ln), .quickReply(rp, ra, rl, rn)):
            lp.utf8.elementsEqual(rp.utf8) && la.utf8.elementsEqual(ra.utf8)
                && ll.map { Data($0.utf8) } == rl.map { Data($0.utf8) }
                && ln.map { Data($0.utf8) } == rn.map { Data($0.utf8) }
        default:
            false
        }
    }
}

public struct OpenClawWatchChatDeliveryCommand: Codable, Sendable, Equatable {
    public let type: OpenClawWatchPayloadType
    public let context: OpenClawWatchChatDeliveryContext
    public let commandId: String
    public let submittedAtMs: Int64
    public let body: OpenClawWatchChatDeliveryBody

    public init(
        context: OpenClawWatchChatDeliveryContext,
        commandId: String,
        submittedAtMs: Int64,
        body: OpenClawWatchChatDeliveryBody)
    {
        self.type = .chatDeliveryCommand
        self.context = context
        self.commandId = commandId
        self.submittedAtMs = submittedAtMs
        self.body = body
    }

    public var kind: OpenClawWatchChatDeliveryKind {
        self.body.kind
    }

    public var expiresAtMs: Int64 {
        let sum = self.submittedAtMs.addingReportingOverflow(OpenClawWatchChatDeliveryCodec.lifetimeMs)
        // Validation rejects overflow before admission; diagnostics must not trap on an invalid DTO.
        return sum.overflow ? Int64.max : sum.partialValue
    }

    public var text: String {
        switch self.body {
        case let .chat(text):
            return text
        case let .quickReply(promptId, actionId, actionLabel, note):
            let label = actionLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
            var lines = [
                "Watch reply: \(label?.isEmpty == false ? label! : actionId)",
                "promptId=\(promptId)",
                "actionId=\(actionId)",
                "replyId=\(self.commandId)",
                "sentAtMs=\(self.submittedAtMs)",
            ]
            if let note, !note.isEmpty { lines.append("note=\(note)") }
            return lines.joined(separator: "\n")
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.type == rhs.type && lhs.context == rhs.context
            && lhs.commandId.utf8.elementsEqual(rhs.commandId.utf8)
            && lhs.submittedAtMs == rhs.submittedAtMs && lhs.body == rhs.body
    }
}

public enum OpenClawWatchChatDeliveryOutcome: Codable, Sendable, Equatable {
    case reply(text: String)
    case forwarded
    case failed(code: String, message: String)
    case uncertain(message: String)

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case let (.reply(left), .reply(right)), let (.uncertain(left), .uncertain(right)):
            left.utf8.elementsEqual(right.utf8)
        case (.forwarded, .forwarded):
            true
        case let (.failed(lc, lm), .failed(rc, rm)):
            lc.utf8.elementsEqual(rc.utf8) && lm.utf8.elementsEqual(rm.utf8)
        default:
            false
        }
    }
}

public struct OpenClawWatchChatDeliveryTerminal: Codable, Sendable, Equatable {
    public let receiptId: String
    public let outcome: OpenClawWatchChatDeliveryOutcome
    public let runId: String?
    public let completedAtMs: Int64

    public init(
        receiptId: String,
        outcome: OpenClawWatchChatDeliveryOutcome,
        runId: String? = nil,
        completedAtMs: Int64)
    {
        self.receiptId = receiptId
        self.outcome = outcome
        self.runId = runId
        self.completedAtMs = completedAtMs
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.receiptId.utf8.elementsEqual(rhs.receiptId.utf8)
            && lhs.outcome == rhs.outcome && lhs.completedAtMs == rhs.completedAtMs
            && lhs.runId.map { Data($0.utf8) } == rhs.runId.map { Data($0.utf8) }
    }
}

public struct OpenClawWatchChatDeliveryReceipt: Codable, Sendable, Equatable {
    public enum State: Codable, Sendable, Equatable {
        case admitted(atMs: Int64)
        case terminal(OpenClawWatchChatDeliveryTerminal)
        case rejected(code: String, message: String)

        public static func == (lhs: Self, rhs: Self) -> Bool {
            switch (lhs, rhs) {
            case let (.admitted(left), .admitted(right)): left == right
            case let (.terminal(left), .terminal(right)): left == right
            case let (.rejected(lc, lm), .rejected(rc, rm)):
                lc.utf8.elementsEqual(rc.utf8) && lm.utf8.elementsEqual(rm.utf8)
            default: false
            }
        }
    }

    public let type: OpenClawWatchPayloadType
    public let context: OpenClawWatchChatDeliveryContext
    public let commandId: String
    public let state: State

    public init(context: OpenClawWatchChatDeliveryContext, commandId: String, state: State) {
        self.type = .chatDeliveryReceipt
        self.context = context
        self.commandId = commandId
        self.state = state
    }

    public var terminal: OpenClawWatchChatDeliveryTerminal? {
        guard case let .terminal(value) = self.state else { return nil }
        return value
    }

    /// Rejections are final presentation, not evidence that the phone took custody.
    public var outcome: OpenClawWatchChatDeliveryOutcome? {
        switch self.state {
        case .admitted: nil
        case let .terminal(terminal): terminal.outcome
        case let .rejected(code, message): .failed(code: code, message: message)
        }
    }

    public var isFinal: Bool {
        self.outcome != nil
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.type == rhs.type && lhs.context == rhs.context && lhs.state == rhs.state
            && lhs.commandId.utf8.elementsEqual(rhs.commandId.utf8)
    }
}

public struct OpenClawWatchChatDeliveryReceiptAck: Codable, Sendable, Equatable {
    public let type: OpenClawWatchPayloadType
    public let context: OpenClawWatchChatDeliveryContext
    public let commandId: String
    public let receiptId: String

    public init(context: OpenClawWatchChatDeliveryContext, commandId: String, receiptId: String) {
        self.type = .chatDeliveryReceiptAck
        self.context = context
        self.commandId = commandId
        self.receiptId = receiptId
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.type == rhs.type && lhs.context == rhs.context
            && lhs.commandId.utf8.elementsEqual(rhs.commandId.utf8)
            && lhs.receiptId.utf8.elementsEqual(rhs.receiptId.utf8)
    }
}

public struct OpenClawWatchChatDeliveryError: Error, LocalizedError, Sendable, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? {
        self.message
    }
}

/// The closed, bounded companion contract. These are app limits, not Gateway schema limits.
public enum OpenClawWatchChatDeliveryCodec {
    public static let lifetimeMs: Int64 = 48 * 60 * 60 * 1000
    public static let maxFutureSkewMs: Int64 = 5 * 60 * 1000
    public static let maxEnvelopeBytes = 48 * 1024
    public static let maxTextCharacters = 4000
    public static let maxTextUTF8Bytes = 16 * 1024
    public static let maxUnexpiredCommands = 1024
    public static let maxPendingCommands = 128
    public static let staleRouteCode = "stale_route"

    public static func encode(_ value: some Encodable) throws -> [String: Any] {
        let data = try self.canonicalData(value)
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw self.invalidPayload()
        }
        try self.validateEnvelopeSize(payload)
        return payload
    }

    public static func canonicalData(_ value: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        guard data.count <= self.maxEnvelopeBytes else { throw self.tooLarge() }
        return data
    }

    public static func decodeContext(_ payload: [String: Any]) throws -> OpenClawWatchChatDeliveryContext {
        let context: OpenClawWatchChatDeliveryContext = try self.decode(payload)
        try self.validateContext(context)
        return context
    }

    public static func decodeCommandStructure(_ payload: [String: Any]) throws -> OpenClawWatchChatDeliveryCommand {
        let command: OpenClawWatchChatDeliveryCommand = try self.decode(payload)
        try self.validateCommandStructure(command)
        return command
    }

    public static func decodeReceipt(_ payload: [String: Any]) throws -> OpenClawWatchChatDeliveryReceipt {
        let receipt: OpenClawWatchChatDeliveryReceipt = try self.decode(payload)
        try self.validateReceipt(receipt)
        return receipt
    }

    public static func decodeReceiptAck(_ payload: [String: Any]) throws -> OpenClawWatchChatDeliveryReceiptAck {
        let ack: OpenClawWatchChatDeliveryReceiptAck = try self.decode(payload)
        try self.validateReceiptAck(ack)
        return ack
    }

    public static func validateReceiptAck(_ ack: OpenClawWatchChatDeliveryReceiptAck) throws {
        guard ack.type == .chatDeliveryReceiptAck else { throw self.invalidPayload() }
        try self.validateContext(ack.context)
        try self.identifier(ack.commandId)
        try self.identifier(ack.receiptId)
        _ = try self.encode(ack)
    }

    public static func validateContext(_ context: OpenClawWatchChatDeliveryContext) throws {
        guard context.version == 1 else {
            throw OpenClawWatchChatDeliveryError(
                code: "upgrade_required",
                message: String(localized: "Update OpenClaw on iPhone and Watch."))
        }
        try self.identifier(context.gatewayStableID, limit: 2048)
        try self.identifier(context.routeGeneration)
        try self.identifier(context.agentId)
        try self.identifier(context.sessionKey, limit: 512)
        try self.identifier(context.deliverySessionKey, limit: 512)
        try self.identifier(context.sessionRoutingContract, limit: 2048)
    }

    public static func validateCommand(_ command: OpenClawWatchChatDeliveryCommand, nowMs: Int64) throws {
        try self.validateCommandStructure(command)
        guard nowMs >= 0,
              nowMs <= Int64.max - self.maxFutureSkewMs,
              command.submittedAtMs <= nowMs + self.maxFutureSkewMs
        else {
            throw OpenClawWatchChatDeliveryError(
                code: "clock_error",
                message: String(localized: "Check the date and time on iPhone and Watch."))
        }
        guard nowMs < command.expiresAtMs else {
            throw OpenClawWatchChatDeliveryError(
                code: "expired",
                message: String(localized: "This Watch message expired. Check Chat on iPhone."))
        }
    }

    public static func validateCommandStructure(_ command: OpenClawWatchChatDeliveryCommand) throws {
        guard command.type == .chatDeliveryCommand else { throw self.invalidPayload() }
        try self.validateContext(command.context)
        try self.identifier(command.commandId)
        guard command.submittedAtMs >= 0,
              command.submittedAtMs <= Int64.max - self.lifetimeMs
        else {
            throw OpenClawWatchChatDeliveryError(
                code: "clock_error", message: String(localized: "Invalid Watch message submission time."))
        }
        if case let .quickReply(promptId, actionId, actionLabel, note) = command.body {
            try self.identifier(promptId)
            try self.identifier(actionId)
            if let actionLabel { try self.text(actionLabel, allowEmpty: true) }
            if let note { try self.text(note, allowEmpty: true) }
        }
        try self.text(command.text)
        _ = try self.encode(command)
    }

    public static func validateReceipt(_ receipt: OpenClawWatchChatDeliveryReceipt) throws {
        guard receipt.type == .chatDeliveryReceipt else { throw self.invalidPayload() }
        try self.validateContext(receipt.context)
        try self.identifier(receipt.commandId)
        switch receipt.state {
        case let .admitted(atMs):
            guard atMs >= 0 else { throw self.invalidPayload() }
        case let .rejected(code, message):
            guard self.isPermanentRejectionCode(code) else { throw self.invalidPayload() }
            try self.text(message)
        case let .terminal(terminal):
            try self.identifier(terminal.receiptId)
            if let runId = terminal.runId { try self.identifier(runId) }
            guard terminal.completedAtMs >= 0 else { throw self.invalidPayload() }
            switch terminal.outcome {
            case let .reply(text): try self.text(text)
            case .forwarded: break
            case let .failed(code, message):
                try self.identifier(code)
                try self.text(message)
            case let .uncertain(message): try self.text(message)
            }
        }
        _ = try self.encode(receipt)
    }

    public static func isPermanentRejectionCode(_ code: String) -> Bool {
        switch code {
        case self.staleRouteCode, "expired", "routing_changed", "identity_conflict", "clock_error": true
        default: false
        }
    }

    public static func boundedReplyText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var result = ""
        var bytes = 0
        var count = 0
        for character in trimmed {
            let part = String(character)
            guard count < self.maxTextCharacters, bytes + part.utf8.count <= self.maxTextUTF8Bytes else {
                while !result.isEmpty, count >= self.maxTextCharacters || bytes + 3 > self.maxTextUTF8Bytes {
                    bytes -= String(result.removeLast()).utf8.count
                    count -= 1
                }
                return result + "…"
            }
            result.append(character)
            bytes += part.utf8.count
            count += 1
        }
        return result
    }

    private static func decode<Value: Codable>(_ payload: [String: Any]) throws -> Value {
        try self.validateEnvelopeSize(payload)
        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            guard data.count <= self.maxEnvelopeBytes else { throw self.tooLarge() }
            let value = try JSONDecoder().decode(Value.self, from: data)
            let canonical = try JSONSerialization.jsonObject(with: self.canonicalData(value))
            guard self.sameFields(payload, canonical) else { throw self.invalidPayload() }
            return value
        } catch let error as OpenClawWatchChatDeliveryError {
            throw error
        } catch {
            throw self.invalidPayload()
        }
    }

    private static func sameFields(_ value: Any, _ canonical: Any) -> Bool {
        if let expected = canonical as? [String: Any] {
            guard let actual = value as? [String: Any], Set(actual.keys) == Set(expected.keys) else { return false }
            return expected.allSatisfy { key, value in
                actual[key].map { self.sameFields($0, value) } == true
            }
        }
        if let expected = canonical as? [Any] {
            guard let actual = value as? [Any], actual.count == expected.count else { return false }
            return zip(actual, expected).allSatisfy { self.sameFields($0, $1) }
        }
        return true
    }

    private static func validateEnvelopeSize(_ payload: [String: Any]) throws {
        guard PropertyListSerialization.propertyList(payload, isValidFor: .binary) else {
            throw self.invalidPayload()
        }
        let data = try PropertyListSerialization.data(fromPropertyList: payload, format: .binary, options: 0)
        guard data.count <= self.maxEnvelopeBytes else { throw self.tooLarge() }
    }

    private static func identifier(_ value: String, limit: Int = 256) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.count <= limit,
              value.utf8.count <= limit * 4,
              !value.utf8.contains(0)
        else { throw self.invalidPayload() }
    }

    private static func text(_ value: String, allowEmpty: Bool = false) throws {
        guard allowEmpty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw self.invalidPayload()
        }
        guard value.count <= self.maxTextCharacters, value.utf8.count <= self.maxTextUTF8Bytes else {
            throw self.tooLarge()
        }
    }

    private static func invalidPayload() -> OpenClawWatchChatDeliveryError {
        OpenClawWatchChatDeliveryError(
            code: "invalid_payload", message: String(localized: "Invalid Watch chat delivery message."))
    }

    private static func tooLarge() -> OpenClawWatchChatDeliveryError {
        OpenClawWatchChatDeliveryError(
            code: "too_large",
            message: String(localized: "This Watch message is too large. Shorten it and try again."))
    }
}
