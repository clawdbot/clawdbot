import Foundation
import OpenClawKit

enum MacNodeScreenCommand: String, Codable {
    case snapshot = "screen.snapshot"
    case record = "screen.record"
}

struct MacNodeScreenSnapshotParams: Codable, Equatable {
    var screenIndex: Int?
    var maxWidth: Int?
    var quality: Double?
    var format: OpenClawScreenSnapshotFormat?
}

struct MacNodeScreenRecordParams: Codable, Equatable {
    var screenIndex: Int?
    var durationMs: Int?
    var fps: Double?
    var format: String?
    var includeAudio: Bool?
}
