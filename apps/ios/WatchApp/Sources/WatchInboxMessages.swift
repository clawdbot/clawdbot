import Foundation
import OpenClawKit

// Canonical transport leaf models live in OpenClawKit. The local envelope types
// below retain the existing Watch inbox persistence shape without `type`.
typealias WatchPayloadType = OpenClawWatchPayloadType
typealias WatchRiskLevel = OpenClawWatchRisk
typealias WatchExecApprovalDecision = OpenClawWatchExecApprovalDecision
typealias WatchExecApprovalTransportOutcome = OpenClawWatchExecApprovalOutcome
typealias WatchExecApprovalCloseReason = OpenClawWatchExecApprovalCloseReason
typealias WatchOpaqueUTF8Key = ExactOpaqueIdentifierKey
typealias WatchApprovalID = ExecApprovalIdentifier
typealias WatchGatewayID = GatewayStableIdentifier

struct WatchExecApprovalIdentityKey: Hashable, Sendable {
    var gatewayID: WatchGatewayID.Key
    var approvalID: WatchApprovalID.Key
}

typealias WatchExecApprovalItem = OpenClawWatchExecApprovalItem

struct WatchExecApprovalPromptMessage: Codable, Equatable {
    var approval: WatchExecApprovalItem
    var sentAtMs: Int64?
    var resetResolutionAttemptId: String?
}

struct WatchExecApprovalResolvedMessage: Codable, Equatable {
    var approvalId: String
    var gatewayStableID: String?
    var decision: WatchExecApprovalDecision?
    var outcome: WatchExecApprovalTransportOutcome?
    var resolvedAtMs: Int64?
    var source: String?
    var outcomeText: String?

    static func parseTransportOutcome(_ value: Any?) -> WatchExecApprovalTransportOutcome? {
        guard let rawValue = value as? String else { return nil }
        return WatchExecApprovalTransportOutcome(rawValue: rawValue)
    }
}

struct WatchExecApprovalExpiredMessage: Codable, Equatable {
    var approvalId: String
    var gatewayStableID: String?
    var reason: WatchExecApprovalCloseReason
    var expiredAtMs: Int64?
}

struct WatchExecApprovalSnapshotMessage: Codable, Equatable {
    var approvals: [WatchExecApprovalItem]
    var gatewayStableID: String?
    var sentAtMs: Int64?
    var snapshotId: String?
    var requestId: String?
    var requestGatewayStableID: String?

    init(
        approvals: [WatchExecApprovalItem],
        gatewayStableID: String? = nil,
        sentAtMs: Int64? = nil,
        snapshotId: String? = nil,
        requestId: String? = nil,
        requestGatewayStableID: String? = nil)
    {
        self.approvals = approvals
        self.gatewayStableID = gatewayStableID
        self.sentAtMs = sentAtMs
        self.snapshotId = snapshotId
        self.requestId = requestId
        self.requestGatewayStableID = requestGatewayStableID
    }
}

typealias WatchExecApprovalSnapshotRequestMessage = OpenClawWatchExecApprovalSnapshotRequestMessage
typealias WatchExecApprovalSnapshotRequestItem = OpenClawWatchExecApprovalSnapshotRequestItem
typealias WatchExecApprovalResolveMessage = OpenClawWatchExecApprovalResolveMessage
typealias WatchAppCommand = OpenClawWatchAppCommand

enum WatchStatusLocalizationKey: String {
    case connected
    case reconnecting
    case offline
    case gatewayProblemRequestIDFormat
    case ready
    case connecting
    case listening
    case thinking
    case speaking
    case off
    case missingFormat
    case requestingApproval
    case approvalRequested
    case apiKeyMissing
    case unavailable
    case connectIPhoneChat
    case noChatMessages
    case chatUnavailable
    case noMessagesSynced
    case waitingForIPhone
    case refresh
    case openChat
    case chat
    case startTalk
    case stopTalk
    case sendingFormat
    case failedFormat
    case sentFormat
    case queuedFormat
    case refreshingFromIPhone
    case allowOnce
    case deny
    case retryApproval
    case allowedOnce
    case approvalSetToAlwaysAllow
    case denied
    case approvalResolved
    case approvalExpired
    case approvalNoLongerAvailable
    case approvalResolvedElsewhere
    case approvalReplaced
    case approvalUnavailable

    var localized: String {
        switch self {
        case .connected:
            String(localized: "Connected")
        case .reconnecting:
            String(localized: "Reconnecting…")
        case .offline:
            String(localized: "Offline")
        case .gatewayProblemRequestIDFormat:
            String(localized: "%@ (request ID: %@)")
        case .ready:
            String(localized: "Ready")
        case .connecting:
            String(localized: "Connecting")
        case .listening:
            String(localized: "Listening")
        case .thinking:
            String(localized: "Thinking")
        case .speaking:
            String(localized: "Speaking")
        case .off:
            String(localized: "Off")
        case .missingFormat:
            String(localized: "Missing %@")
        case .requestingApproval:
            String(localized: "Requesting approval")
        case .approvalRequested:
            String(localized: "Approval requested")
        case .apiKeyMissing:
            String(localized: "API key missing")
        case .unavailable:
            String(localized: "Unavailable")
        case .connectIPhoneChat:
            String(localized: "Connect iPhone chat to read messages")
        case .noChatMessages:
            String(localized: "No chat messages yet")
        case .chatUnavailable:
            String(localized: "Chat unavailable")
        case .noMessagesSynced:
            String(localized: "No messages synced")
        case .waitingForIPhone:
            String(localized: "Waiting for iPhone")
        case .refresh:
            String(localized: "Refresh")
        case .openChat:
            String(localized: "Open Chat")
        case .chat:
            String(localized: "Chat")
        case .startTalk:
            String(localized: "Start Talk")
        case .stopTalk:
            String(localized: "Stop Talk")
        case .sendingFormat:
            String(localized: "Sending %@…")
        case .failedFormat:
            String(localized: "%@ failed: %@")
        case .sentFormat:
            String(localized: "%@: sent")
        case .queuedFormat:
            String(localized: "%@: queued")
        case .refreshingFromIPhone:
            String(localized: "Refreshing from iPhone…")
        case .allowOnce:
            String(localized: "Allow Once")
        case .deny:
            String(localized: "Deny")
        case .retryApproval:
            String(localized: "Couldn't reach iPhone. Tap to retry.")
        case .allowedOnce:
            String(localized: "Allowed once")
        case .approvalSetToAlwaysAllow:
            String(localized: "Approval set to Always Allow.")
        case .denied:
            String(localized: "Denied")
        case .approvalResolved:
            String(localized: "Approval resolved")
        case .approvalExpired:
            String(localized: "Approval expired")
        case .approvalNoLongerAvailable:
            String(localized: "Approval no longer available")
        case .approvalResolvedElsewhere:
            String(localized: "Approval resolved elsewhere")
        case .approvalReplaced:
            String(localized: "Approval replaced")
        case .approvalUnavailable:
            String(localized: "Approval unavailable")
        }
    }
}

enum WatchDeliveryStatusCode: String, Codable, Equatable {
    case sending
    case sent
    case queued
    case failed
    case blocked
}

struct WatchAppCommandStatus: Codable, Equatable {
    var command: WatchAppCommand
    var code: WatchDeliveryStatusCode
    var detail: String?
    var legacyVerbatim: String?

    func localizedText(
        localize: (WatchStatusLocalizationKey) -> String = { $0.localized }) -> String
    {
        if let legacyVerbatim {
            return legacyVerbatim
        }
        let label = self.command.localizedLabel(localize: localize)
        return switch self.code {
        case .sending:
            String(format: localize(.sendingFormat), label)
        case .sent:
            String(format: localize(.sentFormat), label)
        case .queued:
            String(format: localize(.queuedFormat), label)
        case .failed:
            String(format: localize(.failedFormat), label, self.detail ?? localize(.unavailable))
        case .blocked:
            self.detail ?? localize(.refreshingFromIPhone)
        }
    }

    static func decodeLegacyLocalizedText(_ text: String) -> Self? {
        guard !text.isEmpty else { return nil }
        return Self(
            command: .refresh,
            code: .failed,
            detail: nil,
            legacyVerbatim: text)
    }
}

struct WatchReplyStatus: Codable, Equatable {
    var code: WatchDeliveryStatusCode
    var actionLabel: String
    var detail: String?
    var legacyVerbatim: String?

    func localizedText(
        localize: (WatchStatusLocalizationKey) -> String = { $0.localized }) -> String
    {
        if let legacyVerbatim {
            return legacyVerbatim
        }
        return switch self.code {
        case .sending:
            String(format: localize(.sendingFormat), self.actionLabel)
        case .sent:
            String(format: localize(.sentFormat), self.actionLabel)
        case .queued:
            String(format: localize(.queuedFormat), self.actionLabel)
        case .failed:
            String(
                format: localize(.failedFormat),
                self.actionLabel,
                self.detail ?? localize(.unavailable))
        case .blocked:
            localize(.refreshingFromIPhone)
        }
    }

    static func decodeLegacyLocalizedText(_ text: String) -> Self? {
        guard !text.isEmpty else { return nil }
        return Self(
            code: .failed,
            actionLabel: "",
            detail: nil,
            legacyVerbatim: text)
    }
}

enum WatchExecApprovalStatusCode: String, Codable, Equatable {
    case sending
    case sent
    case queued
    case retry
    case legacy
}

struct WatchExecApprovalStatus: Codable, Equatable {
    var code: WatchExecApprovalStatusCode
    var decision: WatchExecApprovalDecision?
    var legacyVerbatim: String?

    func localizedText(
        localize: (WatchStatusLocalizationKey) -> String = { $0.localized }) -> String
    {
        if let legacyVerbatim {
            return legacyVerbatim
        }
        guard self.code != .retry else {
            return localize(.retryApproval)
        }
        let label = (self.decision ?? .allowOnce).localizedLabel(localize: localize)
        return switch self.code {
        case .sending:
            String(format: localize(.sendingFormat), label)
        case .sent:
            String(format: localize(.sentFormat), label)
        case .queued:
            String(format: localize(.queuedFormat), label)
        case .retry:
            localize(.retryApproval)
        case .legacy:
            legacyVerbatim ?? localize(.unavailable)
        }
    }

    static func decodeLegacyLocalizedText(_ text: String) -> Self? {
        guard !text.isEmpty else { return nil }
        return Self(code: .legacy, legacyVerbatim: text)
    }
}

enum WatchExecApprovalOutcomeCode: String, Codable, Equatable {
    case allowedOnce
    case allowedAlways
    case denied
    case resolved
    case expired
    case notFound
    case resolvedElsewhere
    case replaced
    case unavailable
    case verbatim
}

struct WatchExecApprovalOutcome: Codable, Equatable {
    var code: WatchExecApprovalOutcomeCode
    var verbatim: String?

    func localizedText(
        localize: (WatchStatusLocalizationKey) -> String = { $0.localized }) -> String
    {
        if let verbatim {
            return verbatim
        }
        return switch self.code {
        case .allowedOnce:
            localize(.allowedOnce)
        case .allowedAlways:
            localize(.approvalSetToAlwaysAllow)
        case .denied:
            localize(.denied)
        case .resolved:
            localize(.approvalResolved)
        case .expired:
            localize(.approvalExpired)
        case .notFound:
            localize(.approvalNoLongerAvailable)
        case .resolvedElsewhere:
            localize(.approvalResolvedElsewhere)
        case .replaced:
            localize(.approvalReplaced)
        case .unavailable:
            localize(.approvalUnavailable)
        case .verbatim:
            localize(.unavailable)
        }
    }

    static func decodeLegacyLocalizedText(_ text: String) -> Self? {
        guard !text.isEmpty else { return nil }
        return switch text {
        case "Allowed once", "Approval allowed once.", "This approval was already allowed once.":
            Self(code: .allowedOnce)
        case "Approval set to Always Allow.", "This approval was already set to Always Allow.":
            Self(code: .allowedAlways)
        case "Denied", "Approval denied.", "This approval was already denied.":
            Self(code: .denied)
        case "Approval resolved":
            Self(code: .resolved)
        case "Approval expired":
            Self(code: .expired)
        case "Approval no longer available":
            Self(code: .notFound)
        case "Approval resolved elsewhere", "This approval was already resolved elsewhere.":
            Self(code: .resolvedElsewhere)
        case "Approval replaced":
            Self(code: .replaced)
        case "Approval unavailable":
            Self(code: .unavailable)
        default:
            Self(code: .verbatim, verbatim: text)
        }
    }

    static func resolved(
        outcome: WatchExecApprovalTransportOutcome?,
        legacyText: String?,
        decision: WatchExecApprovalDecision?,
        source: String?) -> Self
    {
        if let outcome {
            return switch outcome {
            case .allowedOnce:
                Self(code: .allowedOnce)
            case .allowedAlways:
                Self(code: .allowedAlways)
            case .denied:
                Self(code: .denied)
            }
        }
        let normalizedLegacyText = legacyText?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(160)
        if let normalizedLegacyText, !normalizedLegacyText.isEmpty {
            return Self.decodeLegacyLocalizedText(String(normalizedLegacyText))
                ?? Self(code: .unavailable)
        }
        if let decision {
            return switch decision {
            case .allowOnce:
                Self(code: .allowedOnce)
            case .deny:
                Self(code: .denied)
            }
        }
        return Self(code: source == "another-reviewer" ? .resolvedElsewhere : .resolved)
    }
}

extension WatchAppCommand {
    fileprivate func localizedLabel(
        localize: (WatchStatusLocalizationKey) -> String) -> String
    {
        switch self {
        case .refresh:
            localize(.refresh)
        case .openChat:
            localize(.openChat)
        case .sendChat:
            localize(.chat)
        case .startTalk:
            localize(.startTalk)
        case .stopTalk:
            localize(.stopTalk)
        }
    }
}

extension WatchExecApprovalDecision {
    fileprivate func localizedLabel(
        localize: (WatchStatusLocalizationKey) -> String) -> String
    {
        switch self {
        case .allowOnce:
            localize(.allowOnce)
        case .deny:
            localize(.deny)
        }
    }
}

struct WatchAppSnapshotMessage: Codable, Equatable {
    var gatewayStatus: OpenClawWatchAppStatus
    var gatewayConnected: Bool
    var agentName: String
    var agentAvatarURL: String?
    var agentAvatarText: String?
    var sessionKey: String
    var gatewayStableID: String?
    var talkStatus: OpenClawWatchAppStatus
    var talkEnabled: Bool
    var talkListening: Bool
    var talkSpeaking: Bool
    var pendingApprovalCount: Int
    var chatItems: [WatchChatItem]?
    var chatStatus: OpenClawWatchAppStatus?
    var sentAtMs: Int64?
    var snapshotId: String?

    init(
        gatewayStatus: OpenClawWatchAppStatus,
        gatewayConnected: Bool,
        agentName: String,
        agentAvatarURL: String?,
        agentAvatarText: String?,
        sessionKey: String,
        gatewayStableID: String?,
        talkStatus: OpenClawWatchAppStatus,
        talkEnabled: Bool,
        talkListening: Bool,
        talkSpeaking: Bool,
        pendingApprovalCount: Int,
        chatItems: [WatchChatItem]?,
        chatStatus: OpenClawWatchAppStatus?,
        sentAtMs: Int64?,
        snapshotId: String?)
    {
        self.gatewayStatus = gatewayStatus
        self.gatewayConnected = gatewayConnected
        self.agentName = agentName
        self.agentAvatarURL = agentAvatarURL
        self.agentAvatarText = agentAvatarText
        self.sessionKey = sessionKey
        self.gatewayStableID = gatewayStableID
        self.talkStatus = talkStatus
        self.talkEnabled = talkEnabled
        self.talkListening = talkListening
        self.talkSpeaking = talkSpeaking
        self.pendingApprovalCount = pendingApprovalCount
        self.chatItems = chatItems
        self.chatStatus = chatStatus
        self.sentAtMs = sentAtMs
        self.snapshotId = snapshotId
    }

    static func parsePayload(_ payload: [String: Any]) -> Self? {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.appSnapshot.rawValue
        else {
            return nil
        }
        let gatewayConnected = Self.boolValue(payload["gatewayConnected"])
        let agentName = (payload["agentName"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let agentAvatarURL = (payload["agentAvatarURL"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let agentAvatarText = (payload["agentAvatarText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sessionKey = (payload["sessionKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gatewayStableID = WatchGatewayID.exact(payload["gatewayStableID"] as? String)
        let talkEnabled = Self.boolValue(payload["talkEnabled"])
        let talkListening = Self.boolValue(payload["talkListening"])
        let talkSpeaking = Self.boolValue(payload["talkSpeaking"])
        let pendingApprovalCount = (payload["pendingApprovalCount"] as? Int)
            ?? (payload["pendingApprovalCount"] as? NSNumber)?.intValue
            ?? 0
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        let snapshotId = (payload["snapshotId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let chatItems = (payload["chatItems"] as? [Any])?.compactMap(Self.parseChatItem)
        return Self(
            gatewayStatus: Self.parseStatus(
                payload["gatewayStatus"],
                fallbackText: payload["gatewayStatusText"] as? String)
                ?? Self.decodeLegacyGatewayStatus(
                    text: payload["gatewayStatusText"] as? String,
                    connected: gatewayConnected),
            gatewayConnected: gatewayConnected,
            agentName: agentName.isEmpty ? "Main" : agentName,
            agentAvatarURL: agentAvatarURL?.isEmpty == false ? agentAvatarURL : nil,
            agentAvatarText: agentAvatarText?.isEmpty == false ? agentAvatarText : nil,
            sessionKey: sessionKey.isEmpty ? "main" : sessionKey,
            gatewayStableID: gatewayStableID,
            talkStatus: Self.parseStatus(
                payload["talkStatus"],
                fallbackText: payload["talkStatusText"] as? String)
                ?? Self.decodeLegacyTalkStatus(
                    text: payload["talkStatusText"] as? String,
                    enabled: talkEnabled,
                    listening: talkListening,
                    speaking: talkSpeaking),
            talkEnabled: talkEnabled,
            talkListening: talkListening,
            talkSpeaking: talkSpeaking,
            pendingApprovalCount: max(0, pendingApprovalCount),
            chatItems: chatItems,
            chatStatus: Self.parseStatus(
                payload["chatStatus"],
                fallbackText: payload["chatStatusText"] as? String)
                ?? Self.decodeLegacyChatStatus(
                    code: payload["chatStatusCode"] as? String,
                    text: payload["chatStatusText"] as? String),
            sentAtMs: sentAtMs,
            snapshotId: snapshotId)
    }

    static func localizedChatStatusText(
        status: OpenClawWatchAppStatus?,
        chatCount: Int,
        hasAppSnapshot: Bool,
        localize: (WatchStatusLocalizationKey) -> String = { $0.localized }) -> String
    {
        if let status {
            return status.localizedText(localize: localize)
        }
        if chatCount > 0 {
            return String(
                AttributedString(localized: "^[\(chatCount) recent message](inflect: true)").characters)
        }
        return hasAppSnapshot
            ? localize(.noMessagesSynced)
            : localize(.waitingForIPhone)
    }

    private enum CodingKeys: String, CodingKey {
        case gatewayStatus
        case gatewayStatusText
        case gatewayConnected
        case agentName
        case agentAvatarURL
        case agentAvatarText
        case sessionKey
        case gatewayStableID
        case talkStatus
        case talkStatusText
        case talkEnabled
        case talkListening
        case talkSpeaking
        case pendingApprovalCount
        case chatItems
        case chatStatus
        case chatStatusCode
        case chatStatusText
        case sentAtMs
        case snapshotId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.gatewayConnected = try container.decode(Bool.self, forKey: .gatewayConnected)
        self.agentName = try container.decode(String.self, forKey: .agentName)
        self.agentAvatarURL = try container.decodeIfPresent(String.self, forKey: .agentAvatarURL)
        self.agentAvatarText = try container.decodeIfPresent(String.self, forKey: .agentAvatarText)
        self.sessionKey = try container.decode(String.self, forKey: .sessionKey)
        self.gatewayStableID = try container.decodeIfPresent(String.self, forKey: .gatewayStableID)
        self.talkEnabled = try container.decode(Bool.self, forKey: .talkEnabled)
        self.talkListening = try container.decode(Bool.self, forKey: .talkListening)
        self.talkSpeaking = try container.decode(Bool.self, forKey: .talkSpeaking)
        self.pendingApprovalCount = try container.decode(Int.self, forKey: .pendingApprovalCount)
        self.chatItems = try container.decodeIfPresent([WatchChatItem].self, forKey: .chatItems)
        self.sentAtMs = try container.decodeIfPresent(Int64.self, forKey: .sentAtMs)
        self.snapshotId = try container.decodeIfPresent(String.self, forKey: .snapshotId)
        let gatewayStatusText = try container.decodeIfPresent(String.self, forKey: .gatewayStatusText)
        let talkStatusText = try container.decodeIfPresent(String.self, forKey: .talkStatusText)
        let chatStatusCode = try container.decodeIfPresent(String.self, forKey: .chatStatusCode)
        let chatStatusText = try container.decodeIfPresent(String.self, forKey: .chatStatusText)
        if let gatewayStatus = try? container.decode(
            OpenClawWatchAppStatus.self,
            forKey: .gatewayStatus)
        {
            self.gatewayStatus = gatewayStatus
        } else if container.contains(.gatewayStatus),
                  let gatewayStatusText,
                  !gatewayStatusText.isEmpty
        {
            self.gatewayStatus = OpenClawWatchAppStatus(
                code: .legacy,
                verbatim: gatewayStatusText)
        } else {
            self.gatewayStatus = Self.decodeLegacyGatewayStatus(
                text: gatewayStatusText,
                connected: self.gatewayConnected)
        }
        if let talkStatus = try? container.decode(
            OpenClawWatchAppStatus.self,
            forKey: .talkStatus)
        {
            self.talkStatus = talkStatus
        } else if container.contains(.talkStatus),
                  let talkStatusText,
                  !talkStatusText.isEmpty
        {
            self.talkStatus = OpenClawWatchAppStatus(
                code: .legacy,
                verbatim: talkStatusText)
        } else {
            self.talkStatus = Self.decodeLegacyTalkStatus(
                text: talkStatusText,
                enabled: self.talkEnabled,
                listening: self.talkListening,
                speaking: self.talkSpeaking)
        }
        self.chatStatus = (try? container.decode(
            OpenClawWatchAppStatus.self,
            forKey: .chatStatus)) ?? Self.decodeLegacyChatStatus(
            code: chatStatusCode,
            text: chatStatusText)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.gatewayStatus, forKey: .gatewayStatus)
        try container.encode(self.gatewayConnected, forKey: .gatewayConnected)
        try container.encode(self.agentName, forKey: .agentName)
        try container.encodeIfPresent(self.agentAvatarURL, forKey: .agentAvatarURL)
        try container.encodeIfPresent(self.agentAvatarText, forKey: .agentAvatarText)
        try container.encode(self.sessionKey, forKey: .sessionKey)
        try container.encodeIfPresent(self.gatewayStableID, forKey: .gatewayStableID)
        try container.encode(self.talkStatus, forKey: .talkStatus)
        try container.encode(self.talkEnabled, forKey: .talkEnabled)
        try container.encode(self.talkListening, forKey: .talkListening)
        try container.encode(self.talkSpeaking, forKey: .talkSpeaking)
        try container.encode(self.pendingApprovalCount, forKey: .pendingApprovalCount)
        try container.encodeIfPresent(self.chatItems, forKey: .chatItems)
        try container.encodeIfPresent(self.chatStatus, forKey: .chatStatus)
        try container.encodeIfPresent(self.sentAtMs, forKey: .sentAtMs)
        try container.encodeIfPresent(self.snapshotId, forKey: .snapshotId)
    }

    private static func parseStatus(
        _ value: Any?,
        fallbackText: String? = nil) -> OpenClawWatchAppStatus?
    {
        guard let payload = value as? [String: Any],
              let rawCode = payload["code"] as? String
        else {
            return nil
        }
        let verbatim = payload["verbatim"] as? String
        guard let code = OpenClawWatchAppStatusCode(rawValue: rawCode) else {
            let legacyText = verbatim?.isEmpty == false ? verbatim : fallbackText
            guard let legacyText, !legacyText.isEmpty else { return nil }
            return OpenClawWatchAppStatus(code: .legacy, verbatim: legacyText)
        }
        return OpenClawWatchAppStatus(
            code: code,
            localizationKey: payload["localizationKey"] as? String,
            arguments: payload["arguments"] as? [String] ?? [],
            verbatim: verbatim)
    }

    private static func decodeLegacyGatewayStatus(
        text: String?,
        connected: Bool) -> OpenClawWatchAppStatus
    {
        if connected {
            return OpenClawWatchAppStatus(code: .gatewayConnected)
        }
        guard let text, !text.isEmpty else {
            return OpenClawWatchAppStatus(code: .gatewayOffline)
        }
        return OpenClawWatchAppStatus(code: .legacy, verbatim: text)
    }

    private static func decodeLegacyTalkStatus(
        text: String?,
        enabled: Bool,
        listening: Bool,
        speaking: Bool) -> OpenClawWatchAppStatus
    {
        if speaking {
            return OpenClawWatchAppStatus(code: .talkSpeaking)
        }
        if listening {
            return OpenClawWatchAppStatus(code: .talkListening)
        }
        if !enabled {
            return OpenClawWatchAppStatus(code: .talkOff)
        }
        guard let text, !text.isEmpty else {
            return OpenClawWatchAppStatus(code: .talkReady)
        }
        return OpenClawWatchAppStatus(code: .legacy, verbatim: text)
    }

    private static func decodeLegacyChatStatus(
        code: String?,
        text: String?) -> OpenClawWatchAppStatus?
    {
        let statusCode: OpenClawWatchAppStatusCode? = switch code {
        case "connectIPhone":
            OpenClawWatchAppStatusCode.chatConnectIPhone
        case "noMessages":
            OpenClawWatchAppStatusCode.chatNoMessages
        case "unavailable":
            OpenClawWatchAppStatusCode.chatUnavailable
        default:
            nil
        }
        if let statusCode {
            return OpenClawWatchAppStatus(code: statusCode)
        }
        guard let text, !text.isEmpty else { return nil }
        return OpenClawWatchAppStatus(code: .legacy, verbatim: text)
    }

    private static func parseChatItem(_ item: Any) -> WatchChatItem? {
        guard let dict = item as? [String: Any] else { return nil }
        guard let id = (dict["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty
        else {
            return nil
        }
        let trimmedRole = (dict["role"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let text = (dict["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let text, !text.isEmpty else { return nil }
        let timestampMs = (dict["timestampMs"] as? NSNumber)?.int64Value
        return WatchChatItem(
            id: id,
            role: trimmedRole.isEmpty ? "assistant" : trimmedRole,
            text: text,
            timestampMs: timestampMs)
    }

    private static func boolValue(_ value: Any?) -> Bool {
        if let bool = value as? Bool {
            return bool
        }
        if let number = value as? NSNumber {
            return number.boolValue
        }
        return false
    }
}

typealias WatchChatCompletionMessage = OpenClawWatchChatCompletionMessage
typealias WatchChatItem = OpenClawWatchChatItem
typealias WatchAppSnapshotRequestMessage = OpenClawWatchAppSnapshotRequestMessage
typealias WatchAppCommandMessage = OpenClawWatchAppCommandMessage
typealias WatchPromptAction = OpenClawWatchAction

struct WatchNotifyMessage: Codable {
    var id: String?
    var title: String
    var body: String
    var sentAtMs: Int64?
    var promptId: String?
    var sessionKey: String?
    var gatewayStableID: String?
    var kind: String?
    var details: String?
    var expiresAtMs: Int64?
    var risk: String?
    var actions: [WatchPromptAction]
}

struct WatchExecApprovalRecord: Codable, Equatable, Identifiable {
    var approval: WatchExecApprovalItem
    var transport: String
    var sourceSentAtMs: Int64?
    var updatedAt: Date
    var isResolving: Bool
    var pendingDecision: WatchExecApprovalDecision?
    var activeResolutionAttemptID: String?
    var status: WatchExecApprovalStatus?
    var statusAt: Date?

    var id: WatchExecApprovalIdentityKey {
        WatchExecApprovalIdentityKey(
            gatewayID: WatchOpaqueUTF8Key(self.approval.gatewayStableID ?? ""),
            approvalID: WatchOpaqueUTF8Key(self.approval.id))
    }

    var approvalID: String {
        self.approval.id
    }

    private enum CodingKeys: String, CodingKey {
        case approval
        case transport
        case sourceSentAtMs
        case updatedAt
        case isResolving
        case pendingDecision
        case activeResolutionAttemptID
        case status
        case statusText
        case statusAt
    }

    init(
        approval: WatchExecApprovalItem,
        transport: String,
        sourceSentAtMs: Int64?,
        updatedAt: Date,
        isResolving: Bool,
        pendingDecision: WatchExecApprovalDecision?,
        activeResolutionAttemptID: String?,
        status: WatchExecApprovalStatus?,
        statusAt: Date?)
    {
        self.approval = approval
        self.transport = transport
        self.sourceSentAtMs = sourceSentAtMs
        self.updatedAt = updatedAt
        self.isResolving = isResolving
        self.pendingDecision = pendingDecision
        self.activeResolutionAttemptID = activeResolutionAttemptID
        self.status = status
        self.statusAt = statusAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.approval = try container.decode(WatchExecApprovalItem.self, forKey: .approval)
        self.transport = try container.decode(String.self, forKey: .transport)
        self.sourceSentAtMs = try container.decodeIfPresent(Int64.self, forKey: .sourceSentAtMs)
        self.updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        self.isResolving = try container.decode(Bool.self, forKey: .isResolving)
        self.pendingDecision = try container.decodeIfPresent(
            WatchExecApprovalDecision.self,
            forKey: .pendingDecision)
        self.activeResolutionAttemptID = try container.decodeIfPresent(
            String.self,
            forKey: .activeResolutionAttemptID)
        self.status = try container.decodeIfPresent(
            WatchExecApprovalStatus.self,
            forKey: .status) ?? Self.decodeLegacyStatus(
            container.decodeIfPresent(String.self, forKey: .statusText))
        self.statusAt = try container.decodeIfPresent(Date.self, forKey: .statusAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.approval, forKey: .approval)
        try container.encode(self.transport, forKey: .transport)
        try container.encodeIfPresent(self.sourceSentAtMs, forKey: .sourceSentAtMs)
        try container.encode(self.updatedAt, forKey: .updatedAt)
        try container.encode(self.isResolving, forKey: .isResolving)
        try container.encodeIfPresent(self.pendingDecision, forKey: .pendingDecision)
        try container.encodeIfPresent(
            self.activeResolutionAttemptID,
            forKey: .activeResolutionAttemptID)
        try container.encodeIfPresent(self.status, forKey: .status)
        try container.encodeIfPresent(self.statusAt, forKey: .statusAt)
    }

    private static func decodeLegacyStatus(_ text: String?) -> WatchExecApprovalStatus? {
        text.flatMap(WatchExecApprovalStatus.decodeLegacyLocalizedText)
    }
}

extension OpenClawWatchAppStatus {
    func localizedText(
        localize: (WatchStatusLocalizationKey) -> String = { $0.localized },
        localizePresentation: (String, [String]) -> String = { key, arguments in
            String(
                format: String(localized: String.LocalizationValue(key)),
                locale: .current,
                arguments: arguments.map { $0 as CVarArg })
        }) -> String
    {
        switch self.code {
        case .gatewayConnected,
             .gatewayConnecting,
             .gatewayReconnecting,
             .gatewayOffline,
             .gatewayProblem,
             .gatewayProblemWithRequestID:
            self.localizedGatewayText(
                localize: localize,
                localizePresentation: localizePresentation)
        case .talkOff,
             .talkReady,
             .talkConnecting,
             .talkListening,
             .talkThinking,
             .talkSpeaking,
             .talkOffline,
             .talkPermissionRequired,
             .talkRequestingApproval,
             .talkApprovalRequested,
             .talkAPIKeyMissing,
             .talkFailure:
            self.localizedTalkText(
                localize: localize,
                localizePresentation: localizePresentation)
        case .chatConnectIPhone, .chatNoMessages, .chatUnavailable:
            self.localizedChatText(localize: localize)
        case .legacy:
            self.verbatim ?? localize(.unavailable)
        }
    }

    private func localizedGatewayText(
        localize: (WatchStatusLocalizationKey) -> String,
        localizePresentation: (String, [String]) -> String) -> String
    {
        switch self.code {
        case .gatewayConnected:
            localize(.connected)
        case .gatewayConnecting:
            localize(.connecting)
        case .gatewayReconnecting:
            localize(.reconnecting)
        case .gatewayOffline:
            localize(.offline)
        case .gatewayProblem:
            self.localizedPresentation(localize: localizePresentation)
        case .gatewayProblemWithRequestID:
            self.localizedGatewayProblemWithRequestID(
                localize: localize,
                localizePresentation: localizePresentation)
        default:
            localize(.unavailable)
        }
    }

    private func localizedTalkText(
        localize: (WatchStatusLocalizationKey) -> String,
        localizePresentation: (String, [String]) -> String) -> String
    {
        switch self.code {
        case .talkOff:
            localize(.off)
        case .talkReady:
            localize(.ready)
        case .talkConnecting:
            localize(.connecting)
        case .talkListening:
            localize(.listening)
        case .talkThinking:
            localize(.thinking)
        case .talkSpeaking:
            localize(.speaking)
        case .talkOffline:
            localize(.offline)
        case .talkPermissionRequired:
            self.arguments.first.map { String(format: localize(.missingFormat), $0) }
                ?? localize(.unavailable)
        case .talkRequestingApproval:
            localize(.requestingApproval)
        case .talkApprovalRequested:
            localize(.approvalRequested)
        case .talkAPIKeyMissing:
            localize(.apiKeyMissing)
        case .talkFailure:
            self.localizedPresentation(localize: localizePresentation)
        default:
            localize(.unavailable)
        }
    }

    private func localizedChatText(
        localize: (WatchStatusLocalizationKey) -> String) -> String
    {
        switch self.code {
        case .chatConnectIPhone:
            localize(.connectIPhoneChat)
        case .chatNoMessages:
            localize(.noChatMessages)
        case .chatUnavailable:
            localize(.chatUnavailable)
        default:
            localize(.unavailable)
        }
    }

    private func localizedPresentation(
        localize: (String, [String]) -> String) -> String
    {
        if let verbatim {
            return verbatim
        }
        guard let localizationKey else {
            return WatchStatusLocalizationKey.unavailable.localized
        }
        return localize(localizationKey, self.arguments)
    }

    private func localizedGatewayProblemWithRequestID(
        localize: (WatchStatusLocalizationKey) -> String,
        localizePresentation: (String, [String]) -> String) -> String
    {
        guard let requestID = self.arguments.last else {
            return self.localizedPresentation(localize: localizePresentation)
        }
        let title = if let verbatim {
            verbatim
        } else if let localizationKey {
            localizePresentation(localizationKey, Array(self.arguments.dropLast()))
        } else {
            localize(.unavailable)
        }
        return String(
            format: localize(.gatewayProblemRequestIDFormat),
            title,
            requestID)
    }
}
