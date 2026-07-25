import Foundation
import OpenClawKit

// NOTE: keep this file lightweight; decode must be resilient to varying transcript formats.

#if canImport(AppKit)
import AppKit

public typealias OpenClawPlatformImage = NSImage
#elseif canImport(UIKit)
import UIKit

public typealias OpenClawPlatformImage = UIImage
#endif

public enum OpenClawChatCommandFilter: String, CaseIterable, Sendable {
    case all = "All"
    case commands = "Commands"
    case skills = "Skills"
}

public struct OpenClawChatCommandChoice: Identifiable, Hashable, Sendable {
    public enum Source: String, Sendable {
        case command
        case skill
        case plugin
        case unknown
    }

    public let id: String
    public let name: String
    public let textAliases: [String]
    public let description: String
    public let source: Source
    public let acceptsArgs: Bool

    public init(
        id: String,
        name: String,
        textAliases: [String],
        description: String,
        source: Source,
        acceptsArgs: Bool)
    {
        self.id = id
        self.name = name
        self.textAliases = textAliases
        self.description = description
        self.source = source
        self.acceptsArgs = acceptsArgs
    }

    public var preferredInvocation: String {
        self.textAliases.first { $0.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") }
            ?? "/\(self.name)"
    }

    public var displayInvocation: String {
        self.preferredInvocation.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public struct OpenClawChatUsageCost: Codable, Hashable, Sendable {
    public let input: Double?
    public let output: Double?
    public let cacheRead: Double?
    public let cacheWrite: Double?
    public let total: Double?
}

public struct OpenClawChatUsage: Codable, Hashable, Sendable {
    public let input: Int?
    public let output: Int?
    public let cacheRead: Int?
    public let cacheWrite: Int?
    public let cost: OpenClawChatUsageCost?
    public let total: Int?

    enum CodingKeys: String, CodingKey {
        case input
        case output
        case cacheRead
        case cacheWrite
        case cost
        case total
        case totalTokens
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.input = try container.decodeIfPresent(Int.self, forKey: .input)
        self.output = try container.decodeIfPresent(Int.self, forKey: .output)
        self.cacheRead = try container.decodeIfPresent(Int.self, forKey: .cacheRead)
        self.cacheWrite = try container.decodeIfPresent(Int.self, forKey: .cacheWrite)
        self.cost = try container.decodeIfPresent(OpenClawChatUsageCost.self, forKey: .cost)
        self.total =
            try container.decodeIfPresent(Int.self, forKey: .total) ??
            container.decodeIfPresent(Int.self, forKey: .totalTokens)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(self.input, forKey: .input)
        try container.encodeIfPresent(self.output, forKey: .output)
        try container.encodeIfPresent(self.cacheRead, forKey: .cacheRead)
        try container.encodeIfPresent(self.cacheWrite, forKey: .cacheWrite)
        try container.encodeIfPresent(self.cost, forKey: .cost)
        try container.encodeIfPresent(self.total, forKey: .total)
    }
}

public struct OpenClawChatMessageContent: Codable, Hashable, Sendable {
    public let type: String?
    public let text: String?
    public let thinking: String?
    public let thinkingSignature: String?
    public let mimeType: String?
    public let fileName: String?
    public let durationSeconds: Double?
    public let content: AnyCodable?
    public let preview: OpenClawChatCanvasPreview?

    // Tool-call fields (when `type == "toolCall"` or similar)
    public let id: String?
    public let name: String?
    public let arguments: AnyCodable?
    public let details: AnyCodable?
    public let isError: Bool?

    public init(
        type: String?,
        text: String?,
        thinking: String? = nil,
        thinkingSignature: String? = nil,
        mimeType: String?,
        fileName: String?,
        durationSeconds: Double? = nil,
        content: AnyCodable?,
        preview: OpenClawChatCanvasPreview? = nil,
        id: String? = nil,
        name: String? = nil,
        arguments: AnyCodable? = nil,
        details: AnyCodable? = nil,
        isError: Bool? = nil)
    {
        self.type = type
        self.text = text
        self.thinking = thinking
        self.thinkingSignature = thinkingSignature
        self.mimeType = mimeType
        self.fileName = fileName
        self.durationSeconds = durationSeconds
        self.content = content
        self.preview = preview
        self.id = id
        self.name = name
        self.arguments = arguments
        self.details = details
        self.isError = isError
    }

    enum CodingKeys: String, CodingKey {
        case type
        case text
        case thinking
        case thinkingSignature
        case mimeType
        case fileName
        case durationSeconds
        case content
        case preview
        case id
        case name
        case arguments
        case details
        case isError
        case is_error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.type = try container.decodeIfPresent(String.self, forKey: .type)
        self.text = try container.decodeIfPresent(String.self, forKey: .text)
        self.thinking = try container.decodeIfPresent(String.self, forKey: .thinking)
        self.thinkingSignature = try container.decodeIfPresent(String.self, forKey: .thinkingSignature)
        self.mimeType = try container.decodeIfPresent(String.self, forKey: .mimeType)
        self.fileName = try container.decodeIfPresent(String.self, forKey: .fileName)
        self.durationSeconds = try container.decodeIfPresent(Double.self, forKey: .durationSeconds)
        self.id = try container.decodeIfPresent(String.self, forKey: .id)
        self.name = try container.decodeIfPresent(String.self, forKey: .name)
        self.arguments = try container.decodeIfPresent(AnyCodable.self, forKey: .arguments)
        self.details = try container.decodeIfPresent(AnyCodable.self, forKey: .details)
        self.isError = try container.decodeIfPresent(Bool.self, forKey: .isError) ??
            container.decodeIfPresent(Bool.self, forKey: .is_error)
        self.preview = try container.decodeIfPresent(OpenClawChatCanvasPreview.self, forKey: .preview)

        if let any = try container.decodeIfPresent(AnyCodable.self, forKey: .content) {
            self.content = any
        } else if let str = try container.decodeIfPresent(String.self, forKey: .content) {
            self.content = AnyCodable(str)
        } else {
            self.content = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(self.type, forKey: .type)
        try container.encodeIfPresent(self.text, forKey: .text)
        try container.encodeIfPresent(self.thinking, forKey: .thinking)
        try container.encodeIfPresent(self.thinkingSignature, forKey: .thinkingSignature)
        try container.encodeIfPresent(self.mimeType, forKey: .mimeType)
        try container.encodeIfPresent(self.fileName, forKey: .fileName)
        try container.encodeIfPresent(self.durationSeconds, forKey: .durationSeconds)
        try container.encodeIfPresent(self.content, forKey: .content)
        try container.encodeIfPresent(self.preview, forKey: .preview)
        try container.encodeIfPresent(self.id, forKey: .id)
        try container.encodeIfPresent(self.name, forKey: .name)
        try container.encodeIfPresent(self.arguments, forKey: .arguments)
        try container.encodeIfPresent(self.details, forKey: .details)
        try container.encodeIfPresent(self.isError, forKey: .isError)
    }
}

public struct OpenClawChatCanvasPreview: Codable, Hashable, Sendable {
    public let kind: String?
    public let surface: String?
    public let render: String?
    public let title: String?
    public let preferredHeight: Double?
    public let url: String?
    public let viewId: String?
    public let sandbox: String?

    public var inlineWidgetPath: String? {
        guard self.kind == "canvas",
              self.surface == "assistant_message",
              self.render == "url",
              self.sandbox == "scripts" || self.sandbox == "strict",
              let url = self.url?.trimmingCharacters(in: .whitespacesAndNewlines),
              OpenClawChatWidgetURLResolver.supportsTarget(url)
        else { return nil }
        return url
    }

    public var inlineWidgetHeight: Double {
        min(max(self.preferredHeight ?? 320, 160), 1200)
    }
}

public struct OpenClawChatMessage: Codable, Hashable, Identifiable, Sendable {
    private struct OpenClawMetadata: Codable {
        let id: String?
        let idempotencyKey: String?
        let truncated: Bool?
    }

    public var id: UUID = .init()
    public var transcriptMessageID: String?
    public var isTruncated = false
    public let role: String
    public let content: [OpenClawChatMessageContent]
    public let timestamp: Double?
    public let idempotencyKey: String?
    public let toolCallId: String?
    public let toolName: String?
    public let usage: OpenClawChatUsage?
    public let stopReason: String?
    public let errorMessage: String?
    public let details: AnyCodable?
    public let isError: Bool?

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case timestamp
        case idempotencyKey
        case openClaw = "__openclaw"
        case toolCallId
        case tool_call_id
        case toolName
        case tool_name
        case usage
        case stopReason
        case errorMessage
        case details
        case isError
        case is_error
        case mediaPath = "MediaPath"
        case mediaPaths = "MediaPaths"
        case mediaType = "MediaType"
        case mediaTypes = "MediaTypes"
    }

    public init(
        id: UUID = .init(),
        role: String,
        content: [OpenClawChatMessageContent],
        timestamp: Double?,
        transcriptMessageID: String? = nil,
        isTruncated: Bool = false,
        idempotencyKey: String? = nil,
        toolCallId: String? = nil,
        toolName: String? = nil,
        usage: OpenClawChatUsage? = nil,
        stopReason: String? = nil,
        errorMessage: String? = nil,
        details: AnyCodable? = nil,
        isError: Bool? = nil)
    {
        self.id = id
        self.transcriptMessageID = transcriptMessageID
        self.isTruncated = isTruncated
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.idempotencyKey = idempotencyKey
        self.toolCallId = toolCallId
        self.toolName = toolName
        self.usage = usage
        self.stopReason = stopReason
        self.errorMessage = errorMessage
        self.details = details
        self.isError = isError
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedRole = try container.decode(String.self, forKey: .role)
        let decodedTimestamp = try container.decodeIfPresent(Double.self, forKey: .timestamp)
        let decodedOpenClaw = try container.decodeIfPresent(OpenClawMetadata.self, forKey: .openClaw)
        let decodedIdempotencyKey = try decodedOpenClaw?.idempotencyKey ??
            container.decodeIfPresent(String.self, forKey: .idempotencyKey)
        let decodedToolCallId =
            try container.decodeIfPresent(String.self, forKey: .toolCallId) ??
            container.decodeIfPresent(String.self, forKey: .tool_call_id)
        let decodedToolName =
            try container.decodeIfPresent(String.self, forKey: .toolName) ??
            container.decodeIfPresent(String.self, forKey: .tool_name)
        let decodedUsage = try container.decodeIfPresent(OpenClawChatUsage.self, forKey: .usage)
        let decodedStopReason = try container.decodeIfPresent(String.self, forKey: .stopReason)
        let decodedErrorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
        let decodedDetails = try container.decodeIfPresent(AnyCodable.self, forKey: .details)
        let decodedIsError = try container.decodeIfPresent(Bool.self, forKey: .isError) ??
            container.decodeIfPresent(Bool.self, forKey: .is_error)

        self.role = decodedRole
        self.transcriptMessageID = decodedOpenClaw?.id
        self.timestamp = decodedTimestamp
        self.idempotencyKey = decodedIdempotencyKey
        self.toolCallId = decodedToolCallId
        self.toolName = decodedToolName
        self.usage = decodedUsage
        self.stopReason = decodedStopReason
        self.errorMessage = decodedErrorMessage
        self.details = decodedDetails
        self.isError = decodedIsError

        let decodedContent: [OpenClawChatMessageContent] = if let decoded = try? container.decode(
            [OpenClawChatMessageContent].self,
            forKey: .content)
        {
            decoded
        } else if let text = try? container.decode(String.self, forKey: .content) {
            // Some session log formats store `content` as a plain string.
            [
                OpenClawChatMessageContent(
                    type: "text",
                    text: text,
                    thinking: nil,
                    thinkingSignature: nil,
                    mimeType: nil,
                    fileName: nil,
                    content: nil,
                    id: nil,
                    name: nil,
                    arguments: nil),
            ]
        } else {
            []
        }

        let mediaPaths =
            (try? container.decode([String].self, forKey: .mediaPaths))
            ?? (try? container.decode(String.self, forKey: .mediaPath)).map { [$0] }
            ?? []
        let mediaTypes =
            (try? container.decode([String].self, forKey: .mediaTypes))
            ?? (try? container.decode(String.self, forKey: .mediaType)).map { [$0] }
            ?? []
        let alreadyContainsAudio = decodedContent.contains { content in
            content.mimeType?.lowercased().hasPrefix("audio/") == true
        }
        let audioAttachments: [OpenClawChatMessageContent] = alreadyContainsAudio ? [] : mediaPaths
            .enumerated()
            .compactMap { index, mediaPath in
                guard mediaTypes.indices.contains(index) else { return nil }
                let mimeType = mediaTypes[index].trimmingCharacters(in: .whitespacesAndNewlines)
                guard mimeType.lowercased().hasPrefix("audio/") else { return nil }
                return OpenClawChatMessageContent(
                    type: "file",
                    text: nil,
                    mimeType: mimeType,
                    fileName: (mediaPath as NSString).lastPathComponent,
                    content: nil)
            }
        self.content = decodedContent + audioAttachments
        self.isTruncated = decodedOpenClaw?.truncated == true || decodedContent.contains { content in
            content.text?.contains(Self.transcriptTruncationMarker) == true
        }
    }

    static func displayText(
        contentText: String,
        role: String,
        stopReason: String?,
        errorMessage: String?) -> String
    {
        let text = contentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let errorText = Self.errorDisplayText(
            role: role,
            stopReason: stopReason,
            errorMessage: errorMessage)
        else {
            return text
        }
        if text.isEmpty || text == Self.streamErrorFallbackText {
            return errorText
        }
        return text
    }

    static func errorDisplayText(role: String, stopReason: String?, errorMessage: String?) -> String? {
        let normalizedRole = role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedStopReason = stopReason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalizedRole == "assistant",
              normalizedStopReason == "error",
              let text = errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else {
            return nil
        }
        return text
    }

    private static let streamErrorFallbackText = "[assistant turn failed before producing content]"
    private static let transcriptTruncationMarker = "\n...(truncated)..."

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.role, forKey: .role)
        try container.encodeIfPresent(self.timestamp, forKey: .timestamp)
        if self.transcriptMessageID != nil || self.isTruncated {
            try container.encode(
                OpenClawMetadata(
                    id: self.transcriptMessageID,
                    idempotencyKey: nil,
                    truncated: self.isTruncated ? true : nil),
                forKey: .openClaw)
        }
        try container.encodeIfPresent(self.idempotencyKey, forKey: .idempotencyKey)
        try container.encodeIfPresent(self.toolCallId, forKey: .toolCallId)
        try container.encodeIfPresent(self.toolName, forKey: .toolName)
        try container.encodeIfPresent(self.usage, forKey: .usage)
        try container.encodeIfPresent(self.stopReason, forKey: .stopReason)
        try container.encodeIfPresent(self.errorMessage, forKey: .errorMessage)
        try container.encodeIfPresent(self.details, forKey: .details)
        try container.encodeIfPresent(self.isError, forKey: .isError)
        try container.encode(self.content, forKey: .content)
    }
}

public struct OpenClawChatInFlightRun: Codable, Sendable {
    public let runId: String
    public let text: String
    public let plan: OpenClawChatPlanSnapshot?

    // periphery:ignore - package tests construct history fixtures; app consumers decode this payload.
    public init(runId: String, text: String, plan: OpenClawChatPlanSnapshot? = nil) {
        self.runId = runId
        self.text = text
        self.plan = plan
    }
}

public struct OpenClawChatPlanSnapshot: Codable, Sendable {
    public let steps: [OpenClawChatPlanStep]
    public let explanation: String?

    // periphery:ignore - package tests construct history fixtures; app consumers decode this payload.
    public init(steps: [OpenClawChatPlanStep], explanation: String? = nil) {
        self.steps = steps
        self.explanation = explanation
    }
}

public struct OpenClawChatSessionInfo: Codable, Sendable {
    public let hasActiveRun: Bool?
    public let activeRunIds: [String]?

    // periphery:ignore - package tests construct history fixtures; app consumers decode this payload.
    public init(hasActiveRun: Bool?, activeRunIds: [String]? = nil) {
        self.hasActiveRun = hasActiveRun
        self.activeRunIds = activeRunIds
    }
}

public struct OpenClawChatHistoryPayload: Codable, Sendable {
    public let sessionKey: String
    public let sessionId: String?
    public let messages: [AnyCodable]?
    public let thinkingLevel: String?
    public let sessionInfo: OpenClawChatSessionInfo?
    public let inFlightRun: OpenClawChatInFlightRun?

    public init(
        sessionKey: String,
        sessionId: String?,
        messages: [AnyCodable]?,
        thinkingLevel: String?,
        sessionInfo: OpenClawChatSessionInfo? = nil,
        inFlightRun: OpenClawChatInFlightRun? = nil)
    {
        self.sessionKey = sessionKey
        self.sessionId = sessionId
        self.messages = messages
        self.thinkingLevel = thinkingLevel
        self.sessionInfo = sessionInfo
        self.inFlightRun = inFlightRun
    }
}

public struct OpenClawSessionPreviewItem: Codable, Hashable, Sendable {
    public let role: String
    public let text: String
}

public struct OpenClawSessionPreviewEntry: Codable, Sendable {
    public let key: String
    public let status: String
    public let items: [OpenClawSessionPreviewItem]
}

public struct OpenClawSessionsPreviewPayload: Codable, Sendable {
    public let ts: Int
    public let previews: [OpenClawSessionPreviewEntry]

    public init(ts: Int, previews: [OpenClawSessionPreviewEntry]) {
        self.ts = ts
        self.previews = previews
    }
}

public struct OpenClawChatSendResponse: Codable, Sendable {
    public let runId: String
    public let status: String
}

public struct OpenClawChatCreateSessionResponse: Codable, Sendable {
    public let ok: Bool?
    public let key: String
    public let sessionId: String?
}

public struct OpenClawChatRewindResponse: Codable, Sendable {
    public let editorText: String?
}

public struct OpenClawChatForkAtMessageResponse: Codable, Sendable {
    public let sessionKey: String
    public let editorText: String?
}

public struct OpenClawChatSessionBranch: Codable, Sendable, Equatable, Identifiable {
    public let leafEntryId: String
    public let headline: String
    public let messageCount: Int
    public let updatedAt: String?
    public let active: Bool

    public var id: String {
        self.leafEntryId
    }

    // periphery:ignore - package tests construct branch fixtures; app consumers decode them.
    public init(
        leafEntryId: String,
        headline: String,
        messageCount: Int,
        updatedAt: String?,
        active: Bool)
    {
        self.leafEntryId = leafEntryId
        self.headline = headline
        self.messageCount = messageCount
        self.updatedAt = updatedAt
        self.active = active
    }
}

public struct OpenClawChatSessionBranchesResponse: Codable, Sendable {
    public let branches: [OpenClawChatSessionBranch]

    // periphery:ignore - package tests construct branch fixtures; app consumers decode them.
    public init(branches: [OpenClawChatSessionBranch]) {
        self.branches = branches
    }
}

public struct OpenClawChatEventPayload: Codable, Sendable {
    public let runId: String?
    public let sessionKey: String?
    public let agentId: String?
    public let state: String?
    public let message: AnyCodable?
    public let errorMessage: String?

    // periphery:ignore - package tests construct transport events; app consumers decode them.
    public init(
        runId: String?,
        sessionKey: String?,
        agentId: String? = nil,
        state: String?,
        message: AnyCodable?,
        errorMessage: String?)
    {
        self.runId = runId
        self.sessionKey = sessionKey
        self.agentId = agentId
        self.state = state
        self.message = message
        self.errorMessage = errorMessage
    }
}

public struct OpenClawSessionMessageEventPayload: Codable, Sendable {
    public let sessionKey: String?
    public let agentId: String?
    public let message: OpenClawChatMessage?
    public let messageId: String?
    public let messageSeq: Int?

    // periphery:ignore - package tests construct transport events; app consumers decode them.
    public init(
        sessionKey: String?,
        agentId: String? = nil,
        message: OpenClawChatMessage?,
        messageId: String?,
        messageSeq: Int?)
    {
        self.sessionKey = sessionKey
        self.agentId = agentId
        self.message = message
        self.messageId = messageId
        self.messageSeq = messageSeq
    }
}

public struct OpenClawAgentEventPayload: Codable, Sendable, Identifiable {
    public var id: String {
        "\(self.runId)-\(self.seq ?? -1)"
    }

    public let runId: String
    public let seq: Int?
    public let stream: String
    public let ts: Int?
    public let data: [String: AnyCodable]
}

public struct OpenClawChatPlanStep: Codable, Hashable, Sendable {
    public enum Status: String, Codable, Hashable, Sendable {
        case pending
        case inProgress = "in_progress"
        case completed
    }

    public let step: String
    public let status: Status

    public init(step: String, status: Status) {
        self.step = step
        self.status = status
    }

    static func parseSteps(_ value: AnyCodable?) -> [Self] {
        guard let value else { return [] }
        let rawItems: [Any]
        switch value.value {
        case let items as [AnyCodable]:
            rawItems = items.map(\.value)
        case let items as [Any]:
            rawItems = items
        case let items as NSArray:
            rawItems = items.map(\.self)
        default:
            return []
        }
        var hasInProgressStep = false
        return rawItems.compactMap { rawItem in
            guard let step = Self.parseStep(rawItem) else { return nil }
            if step.status == .inProgress {
                guard !hasInProgressStep else { return nil }
                hasInProgressStep = true
            }
            return step
        }
    }

    private static func parseStep(_ rawValue: Any) -> Self? {
        let value = (rawValue as? AnyCodable)?.value ?? rawValue
        if let legacyStep = value as? String {
            return self.makeStep(text: legacyStep, status: .pending)
        }

        let fields: [String: Any]
        switch value {
        case let dictionary as [String: AnyCodable]:
            fields = dictionary.mapValues(\.value)
        case let dictionary as [String: String]:
            fields = dictionary
        case let dictionary as [String: Any]:
            fields = dictionary
        case let dictionary as NSDictionary:
            fields = dictionary.reduce(into: [:]) { result, entry in
                guard let key = entry.key as? String else { return }
                result[key] = (entry.value as? AnyCodable)?.value ?? entry.value
            }
        default:
            return nil
        }

        guard let text = fields["step"] as? String,
              let rawStatus = fields["status"] as? String,
              let status = Status(rawValue: rawStatus)
        else {
            return nil
        }
        return self.makeStep(text: text, status: status)
    }

    private static func makeStep(text: String, status: Status) -> Self? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return Self(step: trimmed, status: status)
    }
}

public struct OpenClawChatPendingToolCall: Identifiable, Hashable, Sendable {
    public var id: String {
        self.toolCallId
    }

    public let toolCallId: String
    public let name: String
    public let args: AnyCodable?
    public let startedAt: Double?
    public let isError: Bool?
}

public struct OpenClawGatewayHealthOK: Codable, Sendable {
    public let ok: Bool?
}

public struct OpenClawPendingAttachment: Identifiable {
    public let id = UUID()
    public let url: URL?
    public let data: Data
    public let fileName: String
    public let mimeType: String
    public let type: String
    public let preview: OpenClawPlatformImage?
    public let durationSeconds: Double?

    public init(
        url: URL?,
        data: Data,
        fileName: String,
        mimeType: String,
        type: String = "file",
        preview: OpenClawPlatformImage?,
        durationSeconds: Double? = nil)
    {
        self.url = url
        self.data = data
        self.fileName = fileName
        self.mimeType = mimeType
        self.type = type
        self.preview = preview
        self.durationSeconds = durationSeconds
    }
}

public struct OpenClawChatAttachmentPayload: Codable, Sendable, Hashable {
    public let type: String
    public let mimeType: String
    public let fileName: String
    public let content: String

    public init(type: String, mimeType: String, fileName: String, content: String) {
        self.type = type
        self.mimeType = mimeType
        self.fileName = fileName
        self.content = content
    }
}
