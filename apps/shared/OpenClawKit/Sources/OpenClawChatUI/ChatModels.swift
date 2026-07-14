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

    // Tool-call fields (when `type == "toolCall"` or similar)
    public let id: String?
    public let name: String?
    public let arguments: AnyCodable?

    public init(
        type: String?,
        text: String?,
        thinking: String? = nil,
        thinkingSignature: String? = nil,
        mimeType: String?,
        fileName: String?,
        durationSeconds: Double? = nil,
        content: AnyCodable?,
        id: String? = nil,
        name: String? = nil,
        arguments: AnyCodable? = nil)
    {
        self.type = type
        self.text = text
        self.thinking = thinking
        self.thinkingSignature = thinkingSignature
        self.mimeType = mimeType
        self.fileName = fileName
        self.durationSeconds = durationSeconds
        self.content = content
        self.id = id
        self.name = name
        self.arguments = arguments
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
        case id
        case name
        case arguments
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

        if let any = try container.decodeIfPresent(AnyCodable.self, forKey: .content) {
            self.content = any
        } else if let str = try container.decodeIfPresent(String.self, forKey: .content) {
            self.content = AnyCodable(str)
        } else {
            self.content = nil
        }
    }
}

public struct OpenClawChatMessage: Codable, Hashable, Identifiable, Sendable {
    private struct OpenClawMetadata: Codable {
        let idempotencyKey: String?
    }

    public var id: UUID = .init()
    public let role: String
    public let content: [OpenClawChatMessageContent]
    public let timestamp: Double?
    public let idempotencyKey: String?
    public let toolCallId: String?
    public let toolName: String?
    public let usage: OpenClawChatUsage?
    public let stopReason: String?
    public let errorMessage: String?

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
        idempotencyKey: String? = nil,
        toolCallId: String? = nil,
        toolName: String? = nil,
        usage: OpenClawChatUsage? = nil,
        stopReason: String? = nil,
        errorMessage: String? = nil)
    {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.idempotencyKey = idempotencyKey
        self.toolCallId = toolCallId
        self.toolName = toolName
        self.usage = usage
        self.stopReason = stopReason
        self.errorMessage = errorMessage
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

        self.role = decodedRole
        self.timestamp = decodedTimestamp
        self.idempotencyKey = decodedIdempotencyKey
        self.toolCallId = decodedToolCallId
        self.toolName = decodedToolName
        self.usage = decodedUsage
        self.stopReason = decodedStopReason
        self.errorMessage = decodedErrorMessage

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

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.role, forKey: .role)
        try container.encodeIfPresent(self.timestamp, forKey: .timestamp)
        try container.encodeIfPresent(self.idempotencyKey, forKey: .idempotencyKey)
        try container.encodeIfPresent(self.toolCallId, forKey: .toolCallId)
        try container.encodeIfPresent(self.toolName, forKey: .toolName)
        try container.encodeIfPresent(self.usage, forKey: .usage)
        try container.encodeIfPresent(self.stopReason, forKey: .stopReason)
        try container.encodeIfPresent(self.errorMessage, forKey: .errorMessage)
        try container.encode(self.content, forKey: .content)
    }
}

public struct OpenClawChatInFlightRun: Codable, Sendable {
    public let runId: String
    public let text: String

    // periphery:ignore - package tests construct history fixtures; app consumers decode this payload.
    public init(runId: String, text: String) {
        self.runId = runId
        self.text = text
    }
}

public struct OpenClawChatSessionInfo: Codable, Sendable {
    public let hasActiveRun: Bool?

    // periphery:ignore - package tests construct history fixtures; app consumers decode this payload.
    public init(hasActiveRun: Bool?) {
        self.hasActiveRun = hasActiveRun
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
