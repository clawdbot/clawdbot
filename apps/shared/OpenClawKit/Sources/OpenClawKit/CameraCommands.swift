import Foundation

public enum OpenClawCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
    case ptzStatus = "camera.ptz.status"
    case ptzControl = "camera.ptz.control"
}

public enum OpenClawCameraPTZOperation: String, Codable, Sendable {
    case set
    case move
    case home
}

public struct OpenClawCameraPTZAxisValues: Codable, Sendable, Equatable {
    public var panDegrees: Double?
    public var tiltDegrees: Double?
    public var zoomPercent: Double?

    public init(
        panDegrees: Double? = nil,
        tiltDegrees: Double? = nil,
        zoomPercent: Double? = nil)
    {
        self.panDegrees = panDegrees
        self.tiltDegrees = tiltDegrees
        self.zoomPercent = zoomPercent
    }
}

public struct OpenClawCameraPTZStatusParams: Codable, Sendable, Equatable {
    public var deviceId: String

    public init(deviceId: String) {
        self.deviceId = deviceId
    }
}

public struct OpenClawCameraPTZControlParams: Codable, Sendable, Equatable {
    public var deviceId: String
    public var operation: OpenClawCameraPTZOperation
    public var target: OpenClawCameraPTZAxisValues?
    public var delta: OpenClawCameraPTZAxisValues?

    public init(
        deviceId: String,
        operation: OpenClawCameraPTZOperation,
        target: OpenClawCameraPTZAxisValues? = nil,
        delta: OpenClawCameraPTZAxisValues? = nil)
    {
        self.deviceId = deviceId
        self.operation = operation
        self.target = target
        self.delta = delta
    }
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
