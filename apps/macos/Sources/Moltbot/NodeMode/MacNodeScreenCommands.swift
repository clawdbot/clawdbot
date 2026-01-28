import Foundation

enum MacNodeScreenCommand: String, Codable, Sendable {
    case record = "screen.record"
}

struct MacNodeScreenRecordParams: Codable, Sendable, Equatable {
    var screenIndex: Int?
    var durationMs: Int?
    var fps: Double?
    var format: String?
    var includeAudio: Bool?
}
