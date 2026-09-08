import Foundation

struct ExecApprovalTerminalTombstone: Codable, Equatable {
    var approvalId: String
    var gatewayStableID: String
    var outcome: WatchExecApprovalOutcome
    var outcomeIsAuthoritative: Bool?
    var recordedAt: Date

    private enum CodingKeys: String, CodingKey {
        case approvalId
        case gatewayStableID
        case outcome
        case outcomeText
        case outcomeIsAuthoritative
        case recordedAt
    }

    init(
        approvalId: String,
        gatewayStableID: String,
        outcome: WatchExecApprovalOutcome,
        outcomeIsAuthoritative: Bool?,
        recordedAt: Date)
    {
        self.approvalId = approvalId
        self.gatewayStableID = gatewayStableID
        self.outcome = outcome
        self.outcomeIsAuthoritative = outcomeIsAuthoritative
        self.recordedAt = recordedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.approvalId = try container.decode(String.self, forKey: .approvalId)
        self.gatewayStableID = try container.decode(String.self, forKey: .gatewayStableID)
        self.outcome = try container.decodeIfPresent(
            WatchExecApprovalOutcome.self,
            forKey: .outcome) ?? Self.decodeLegacyOutcome(
            container.decodeIfPresent(String.self, forKey: .outcomeText))
        self.outcomeIsAuthoritative = try container.decodeIfPresent(
            Bool.self,
            forKey: .outcomeIsAuthoritative)
        self.recordedAt = try container.decode(Date.self, forKey: .recordedAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.approvalId, forKey: .approvalId)
        try container.encode(self.gatewayStableID, forKey: .gatewayStableID)
        try container.encode(self.outcome, forKey: .outcome)
        try container.encodeIfPresent(
            self.outcomeIsAuthoritative,
            forKey: .outcomeIsAuthoritative)
        try container.encode(self.recordedAt, forKey: .recordedAt)
    }

    private static func decodeLegacyOutcome(_ text: String?) -> WatchExecApprovalOutcome {
        text.flatMap(WatchExecApprovalOutcome.decodeLegacyLocalizedText)
            ?? WatchExecApprovalOutcome(code: .unavailable)
    }
}
