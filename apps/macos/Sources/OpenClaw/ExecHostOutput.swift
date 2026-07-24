import Foundation

struct ExecHostRunResult: Codable {
    var exitCode: Int?
    var timedOut: Bool
    var success: Bool
    var stdout: String
    var stderr: String
    var error: String?
}

enum ExecHostOutputLimiter {
    static let maxJsonlResponseBytes = 16 * 1024 * 1024
    static let maxOutputFieldBytes = 1024 * 1024
    private static let truncationMarker = "... (truncated) "

    static func truncate(_ value: String) -> String {
        let bytes = value.utf8
        guard bytes.count > self.maxOutputFieldBytes else { return value }

        let tailBudget = self.maxOutputFieldBytes - self.truncationMarker.utf8.count
        var start = bytes.index(bytes.endIndex, offsetBy: -tailBudget)
        while start < bytes.endIndex, (bytes[start] & 0xC0) == 0x80 {
            start = bytes.index(after: start)
        }
        let tail = String(bytes: bytes[start...], encoding: .utf8) ?? ""
        return self.truncationMarker + tail
    }
}
