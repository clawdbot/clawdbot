import Foundation

public enum MoltbotCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum MoltbotCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum MoltbotCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum MoltbotCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct MoltbotCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: MoltbotCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: MoltbotCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: MoltbotCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: MoltbotCameraImageFormat? = nil,
        deviceId: String? = nil,
        delayMs: Int? = nil)
    {
        self.facing = facing
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
        self.deviceId = deviceId
        self.delayMs = delayMs
    }
}

public struct MoltbotCameraClipParams: Codable, Sendable, Equatable {
    public var facing: MoltbotCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: MoltbotCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: MoltbotCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: MoltbotCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
