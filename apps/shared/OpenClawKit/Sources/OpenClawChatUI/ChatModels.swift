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

public enum OpenClawChatPlaybackMode: String, Codable, Hashable, Sendable {
    case native
    case transcode
}

public struct OpenClawChatMessageContent: Codable, Hashable, Sendable {
    public let type: String?
    public let text: String?
    public let thinking: String?
    public let thinkingSignature: String?
    public let mimeType: String?
    public let fileName: String?
    public let artifactId: String?
    public let url: String?
    public let openUrl: String?
    public let alt: String?
    public let width: Int?
    public let height: Int?
    public let sizeBytes: Int?
    public let durationSeconds: Double?
    public let playback: OpenClawChatPlaybackMode?
    public let content: AnyCodable?
    public let preview: OpenClawChatCanvasPreview?

    // Tool-call fields (when `type == "toolCall"` or similar)
    public let id: String?
    public let name: String?
    public let arguments: AnyCodable?
    public let details: AnyCodable?
    public let isError: Bool?

    /// Gateway media and historical file attachments must stay visible in both chat and exports.
    var isInlineAttachment: Bool {
        switch self.type?.lowercased() {
        case "file", "attachment", "image", "audio", "video":
            true
        default:
            false
        }
    }

    var mediaKind: OpenClawChatMediaKind? {
        let normalizedType = self.type?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalizedType {
        case "image": return .image
        case "audio": return .audio
        case "video": return .video
        default: break
        }
        let normalizedMIME = self.mimeType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalizedMIME?.hasPrefix("image/") == true { return .image }
        if normalizedMIME?.hasPrefix("audio/") == true { return .audio }
        if normalizedMIME?.hasPrefix("video/") == true { return .video }
        return nil
    }

    public init(
        type: String?,
        text: String?,
        thinking: String? = nil,
        thinkingSignature: String? = nil,
        mimeType: String?,
        fileName: String?,
        artifactId: String? = nil,
        url: String? = nil,
        openUrl: String? = nil,
        alt: String? = nil,
        width: Int? = nil,
        height: Int? = nil,
        sizeBytes: Int? = nil,
        durationSeconds: Double? = nil,
        playback: OpenClawChatPlaybackMode? = nil,
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
        self.artifactId = artifactId
        self.url = url
        self.openUrl = openUrl
        self.alt = alt
        self.width = width
        self.height = height
        self.sizeBytes = sizeBytes
        self.durationSeconds = durationSeconds
        self.playback = playback
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
        case artifactId
        case url
        case openUrl
        case alt
        case width
        case height
        case sizeBytes
        case durationSeconds
        case durationMs
        case playback
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
        let decodedURL = try container.decodeIfPresent(String.self, forKey: .url)
        self.url = decodedURL
        self.openUrl = try container.decodeIfPresent(String.self, forKey: .openUrl)
        self.artifactId = try container.decodeIfPresent(String.self, forKey: .artifactId)
            ?? Self.managedArtifactId(
                from: decodedURL,
                type: self.type,
                mimeType: self.mimeType)
        self.alt = try container.decodeIfPresent(String.self, forKey: .alt)
        self.width = try container.decodeIfPresent(Int.self, forKey: .width)
        self.height = try container.decodeIfPresent(Int.self, forKey: .height)
        self.sizeBytes = try container.decodeIfPresent(Int.self, forKey: .sizeBytes)
        self.durationSeconds = try container.decodeIfPresent(Double.self, forKey: .durationSeconds)
            ?? container.decodeIfPresent(Double.self, forKey: .durationMs).map { $0 / 1000 }
        self.playback = try container.decodeIfPresent(OpenClawChatPlaybackMode.self, forKey: .playback)
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
        try container.encodeIfPresent(self.artifactId, forKey: .artifactId)
        try container.encodeIfPresent(self.url, forKey: .url)
        try container.encodeIfPresent(self.openUrl, forKey: .openUrl)
        try container.encodeIfPresent(self.alt, forKey: .alt)
        try container.encodeIfPresent(self.width, forKey: .width)
        try container.encodeIfPresent(self.height, forKey: .height)
        try container.encodeIfPresent(self.sizeBytes, forKey: .sizeBytes)
        try container.encodeIfPresent(self.durationSeconds, forKey: .durationSeconds)
        try container.encodeIfPresent(self.playback, forKey: .playback)
        try container.encodeIfPresent(self.content, forKey: .content)
        try container.encodeIfPresent(self.preview, forKey: .preview)
        try container.encodeIfPresent(self.id, forKey: .id)
        try container.encodeIfPresent(self.name, forKey: .name)
        try container.encodeIfPresent(self.arguments, forKey: .arguments)
        try container.encodeIfPresent(self.details, forKey: .details)
        try container.encodeIfPresent(self.isError, forKey: .isError)
    }

    private static func managedArtifactId(
        from rawURL: String?,
        type: String?,
        mimeType: String?) -> String?
    {
        guard let rawURL,
              let components = URLComponents(string: rawURL),
              components.scheme == nil,
              components.host == nil
        else { return nil }
        let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true)
        guard segments.count == 7,
              segments[0...3] == ["api", "chat", "media", "outgoing"],
              segments[6] == "full",
              let attachmentId = UUID(uuidString: String(segments[5]))?.uuidString.lowercased()
        else { return nil }
        let normalizedType = type?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedMIME = mimeType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let prefix = if normalizedType == "audio" || normalizedType == "video" ||
            normalizedMIME?.hasPrefix("audio/") == true ||
            normalizedMIME?.hasPrefix("video/") == true
        {
            "artifact_managed_media_"
        } else {
            "artifact_managed_image_"
        }
        return prefix + attachmentId
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

public struct OpenClawChatInputProvenance: Codable, Hashable, Sendable {
    public let kind: String
    public let originSessionId: String?
    public let sourceSessionKey: String?
    public let sourceChannel: String?
    public let sourceTool: String?

    // periphery:ignore - package tests construct provenance fixtures; app consumers decode this payload.
    public init(
        kind: String,
        originSessionId: String? = nil,
        sourceSessionKey: String? = nil,
        sourceChannel: String? = nil,
        sourceTool: String? = nil)
    {
        self.kind = kind
        self.originSessionId = originSessionId
        self.sourceSessionKey = sourceSessionKey
        self.sourceChannel = sourceChannel
        self.sourceTool = sourceTool
    }
}

public struct OpenClawChatHistoryMarker: Codable, Hashable, Sendable {
    public let kind: String
    public let id: String?
    public let tokensBefore: Double?
    public let tokensAfter: Double?

    public init(kind: String, id: String? = nil, tokensBefore: Double? = nil, tokensAfter: Double? = nil) {
        self.kind = kind
        self.id = id
        self.tokensBefore = tokensBefore
        self.tokensAfter = tokensAfter
    }
}

public struct OpenClawChatMessage: Codable, Hashable, Identifiable, Sendable {
    private struct OpenClawMetadata: Codable {
        let kind: String?
        let id: String?
        let idempotencyKey: String?
        let truncated: Bool?
        let tokensBefore: Double?
        let tokensAfter: Double?
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
    public let provenance: OpenClawChatInputProvenance?
    public let historyMarker: OpenClawChatHistoryMarker?

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case timestamp
        case idempotencyKey
        case openClaw = "__openclaw"
        case provenance
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
        isError: Bool? = nil,
        provenance: OpenClawChatInputProvenance? = nil,
        historyMarker: OpenClawChatHistoryMarker? = nil)
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
        self.provenance = provenance
        self.historyMarker = historyMarker
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
        let decodedProvenance = try? container.decode(
            OpenClawChatInputProvenance.self,
            forKey: .provenance)

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
        self.provenance = decodedProvenance
        self.historyMarker = decodedOpenClaw?.kind.map {
            OpenClawChatHistoryMarker(
                kind: $0,
                id: decodedOpenClaw?.id,
                tokensBefore: decodedOpenClaw?.tokensBefore,
                tokensAfter: decodedOpenClaw?.tokensAfter)
        }

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
        if self.transcriptMessageID != nil || self.isTruncated || self.historyMarker != nil {
            try container.encode(
                OpenClawMetadata(
                    kind: self.historyMarker?.kind,
                    id: self.historyMarker?.id ?? self.transcriptMessageID,
                    idempotencyKey: nil,
                    truncated: self.isTruncated ? true : nil,
                    tokensBefore: self.historyMarker?.tokensBefore,
                    tokensAfter: self.historyMarker?.tokensAfter),
                forKey: .openClaw)
        }
        try container.encodeIfPresent(self.provenance, forKey: .provenance)
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

    // periphery:ignore - package tests construct history fixtures; app consumers decode this payload.
    public init(runId: String, text: String) {
        self.runId = runId
        self.text = text
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

public struct OpenClawChatEditorAttachment: Codable, Sendable {
    public let mimeType: String
    public let data: String
}

public struct OpenClawChatRewindResponse: Codable, Sendable {
    public let editorText: String?
    public let editorAttachments: [OpenClawChatEditorAttachment]?
}

public struct OpenClawChatForkAtMessageResponse: Codable, Sendable {
    public let sessionKey: String
    public let editorText: String?
    public let editorAttachments: [OpenClawChatEditorAttachment]?
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

public struct OpenClawChatPendingToolCall: Identifiable, Hashable, Sendable {
    public var id: String {
        self.toolCallId
    }

    public let toolCallId: String
    public let name: String
    public let args: AnyCodable?
    public let startedAt: Double?
    public let isError: Bool?
    let diffStat: ChatToolDiffStat?
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
