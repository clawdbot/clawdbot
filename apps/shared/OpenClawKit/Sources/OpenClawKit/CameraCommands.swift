import Foundation

public enum OpenClawCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum OpenClawCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum OpenClawCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum OpenClawCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct OpenClawCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: OpenClawCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: OpenClawCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: OpenClawCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: OpenClawCameraImageFormat? = nil,
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

public struct OpenClawCameraClipParams: Codable, Sendable, Equatable {
    public var facing: OpenClawCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: OpenClawCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: OpenClawCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: OpenClawCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
