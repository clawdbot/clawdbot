import Foundation

public enum OpenClawScreenCommand: String, Codable, Sendable {
    case snapshot = "screen.snapshot"
    case record = "screen.record"
}

public enum OpenClawScreenSnapshotFormat: String, Codable, Sendable {
    case jpeg
    case png
}

public struct OpenClawScreenRecordParams: Codable, Sendable, Equatable {
    public var screenIndex: Int?
    public var durationMs: Int?
    public var fps: Double?
    public var format: String?
    public var includeAudio: Bool?

    public init(
        screenIndex: Int? = nil,
        durationMs: Int? = nil,
        fps: Double? = nil,
        format: String? = nil,
        includeAudio: Bool? = nil)
    {
        self.screenIndex = screenIndex
        self.durationMs = durationMs
        self.fps = fps
        self.format = format
        self.includeAudio = includeAudio
    }
}
