import Foundation

public enum MLXTTSRequest: Codable, Equatable, Sendable {
    case synthesize(MLXTTSSynthesizeRequest)
    case cancel(id: String)
    case shutdown

    private enum CodingKeys: String, CodingKey {
        case type
        case synthesize
        case id
    }

    private enum RequestType: String, Codable {
        case synthesize
        case cancel
        case shutdown
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(RequestType.self, forKey: .type) {
        case .synthesize:
            self = try .synthesize(container.decode(MLXTTSSynthesizeRequest.self, forKey: .synthesize))
        case .cancel:
            self = try .cancel(id: container.decode(String.self, forKey: .id))
        case .shutdown:
            self = .shutdown
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .synthesize(request):
            try container.encode(RequestType.synthesize, forKey: .type)
            try container.encode(request, forKey: .synthesize)
        case let .cancel(id):
            try container.encode(RequestType.cancel, forKey: .type)
            try container.encode(id, forKey: .id)
        case .shutdown:
            try container.encode(RequestType.shutdown, forKey: .type)
        }
    }
}

public struct MLXTTSSynthesizeRequest: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let modelRepo: String
    public let language: String?
    public let voice: String?
    public let referenceAudioPath: String?
    public let referenceText: String?
    public let stream: Bool

    private enum CodingKeys: String, CodingKey {
        case id
        case text
        case modelRepo
        case language
        case voice
        case referenceAudioPath
        case referenceText
        case stream
    }

    public init(
        id: String,
        text: String,
        modelRepo: String,
        language: String?,
        voice: String?,
        referenceAudioPath: String? = nil,
        referenceText: String? = nil,
        stream: Bool = false)
    {
        self.id = id
        self.text = text
        self.modelRepo = modelRepo
        self.language = language
        self.voice = voice
        self.referenceAudioPath = referenceAudioPath
        self.referenceText = referenceText
        self.stream = stream
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.text = try container.decode(String.self, forKey: .text)
        self.modelRepo = try container.decode(String.self, forKey: .modelRepo)
        self.language = try container.decodeIfPresent(String.self, forKey: .language)
        self.voice = try container.decodeIfPresent(String.self, forKey: .voice)
        self.referenceAudioPath = try container.decodeIfPresent(String.self, forKey: .referenceAudioPath)
        self.referenceText = try container.decodeIfPresent(String.self, forKey: .referenceText)
        self.stream = try container.decodeIfPresent(Bool.self, forKey: .stream) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.id, forKey: .id)
        try container.encode(self.text, forKey: .text)
        try container.encode(self.modelRepo, forKey: .modelRepo)
        try container.encodeIfPresent(self.language, forKey: .language)
        try container.encodeIfPresent(self.voice, forKey: .voice)
        try container.encodeIfPresent(self.referenceAudioPath, forKey: .referenceAudioPath)
        try container.encodeIfPresent(self.referenceText, forKey: .referenceText)
        try container.encode(self.stream, forKey: .stream)
    }
}

public enum MLXTTSAudioFormat: String, Codable, Equatable, Sendable {
    case pcmS16LE = "pcm_s16le"
}

public struct MLXTTSAudio: Codable, Equatable, Sendable {
    public let id: String
    public let format: MLXTTSAudioFormat
    public let sampleRate: Int
    public let channels: Int
    public let pcm: Data

    public init(
        id: String,
        format: MLXTTSAudioFormat = .pcmS16LE,
        sampleRate: Int,
        channels: Int = 1,
        pcm: Data)
    {
        self.id = id
        self.format = format
        self.sampleRate = sampleRate
        self.channels = channels
        self.pcm = pcm
    }
}

public struct MLXTTSStreamStart: Codable, Equatable, Sendable {
    public let id: String
    public let format: MLXTTSAudioFormat
    public let sampleRate: Int
    public let channels: Int

    public init(
        id: String,
        format: MLXTTSAudioFormat = .pcmS16LE,
        sampleRate: Int,
        channels: Int = 1)
    {
        self.id = id
        self.format = format
        self.sampleRate = sampleRate
        self.channels = channels
    }
}

public struct MLXTTSAudioChunk: Codable, Equatable, Sendable {
    public let id: String
    public let pcm: Data

    public init(id: String, pcm: Data) {
        self.id = id
        self.pcm = pcm
    }
}

public enum MLXTTSErrorCode: String, Codable, Equatable, Sendable {
    case busy
    case canceled
    case generationFailed = "generation_failed"
    case invalidRequest = "invalid_request"
    case modelLoadFailed = "model_load_failed"
    case protocolError = "protocol_error"
}

public struct MLXTTSErrorEvent: Codable, Equatable, Sendable {
    public let id: String?
    public let code: MLXTTSErrorCode
    public let message: String

    public init(id: String?, code: MLXTTSErrorCode, message: String) {
        self.id = id
        self.code = code
        self.message = message
    }
}

public enum MLXTTSEvent: Codable, Equatable, Sendable {
    case ready
    case audio(MLXTTSAudio)
    case streamStarted(MLXTTSStreamStart)
    case audioChunk(MLXTTSAudioChunk)
    case completed(id: String)
    case error(MLXTTSErrorEvent)
    case canceled(id: String)

    private enum CodingKeys: String, CodingKey {
        case type
        case audio
        case streamStarted = "stream_started"
        case audioChunk = "audio_chunk"
        case error
        case id
    }

    private enum EventType: String, Codable {
        case ready
        case audio
        case streamStarted = "stream_started"
        case audioChunk = "audio_chunk"
        case completed
        case error
        case canceled
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(EventType.self, forKey: .type) {
        case .ready:
            self = .ready
        case .audio:
            self = try .audio(container.decode(MLXTTSAudio.self, forKey: .audio))
        case .streamStarted:
            self = try .streamStarted(container.decode(MLXTTSStreamStart.self, forKey: .streamStarted))
        case .audioChunk:
            self = try .audioChunk(container.decode(MLXTTSAudioChunk.self, forKey: .audioChunk))
        case .completed:
            self = try .completed(id: container.decode(String.self, forKey: .id))
        case .error:
            self = try .error(container.decode(MLXTTSErrorEvent.self, forKey: .error))
        case .canceled:
            self = try .canceled(id: container.decode(String.self, forKey: .id))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ready:
            try container.encode(EventType.ready, forKey: .type)
        case let .audio(audio):
            try container.encode(EventType.audio, forKey: .type)
            try container.encode(audio, forKey: .audio)
        case let .streamStarted(start):
            try container.encode(EventType.streamStarted, forKey: .type)
            try container.encode(start, forKey: .streamStarted)
        case let .audioChunk(chunk):
            try container.encode(EventType.audioChunk, forKey: .type)
            try container.encode(chunk, forKey: .audioChunk)
        case let .completed(id):
            try container.encode(EventType.completed, forKey: .type)
            try container.encode(id, forKey: .id)
        case let .error(error):
            try container.encode(EventType.error, forKey: .type)
            try container.encode(error, forKey: .error)
        case let .canceled(id):
            try container.encode(EventType.canceled, forKey: .type)
            try container.encode(id, forKey: .id)
        }
    }
}

public enum MLXTTSFrameError: Error, Equatable, Sendable {
    case emptyFrame
    case frameTooLarge(Int)
}

public enum MLXTTSFrameCodec {
    public static let maximumPayloadSize = 64 * 1024 * 1024

    public static func encode(_ value: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let payload = try encoder.encode(value)
        guard !payload.isEmpty else {
            throw MLXTTSFrameError.emptyFrame
        }
        guard payload.count <= self.maximumPayloadSize else {
            throw MLXTTSFrameError.frameTooLarge(payload.count)
        }

        var length = UInt32(payload.count).bigEndian
        var frame = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        frame.append(payload)
        return frame
    }

    public static func decode<T: Decodable>(_ type: T.Type, payload: Data) throws -> T {
        try JSONDecoder().decode(type, from: payload)
    }
}

public struct MLXTTSFrameDecoder: Sendable {
    private var buffer = Data()

    public init() {}

    public mutating func append(_ data: Data) throws -> [Data] {
        self.buffer.append(data)
        var payloads: [Data] = []

        while self.buffer.count >= MemoryLayout<UInt32>.size {
            let length = self.buffer.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
            guard length > 0 else {
                throw MLXTTSFrameError.emptyFrame
            }
            guard length <= MLXTTSFrameCodec.maximumPayloadSize else {
                throw MLXTTSFrameError.frameTooLarge(length)
            }
            guard self.buffer.count >= 4 + length else {
                break
            }

            payloads.append(self.buffer.subdata(in: 4..<(4 + length)))
            self.buffer.removeSubrange(0..<(4 + length))
        }

        return payloads
    }
}
