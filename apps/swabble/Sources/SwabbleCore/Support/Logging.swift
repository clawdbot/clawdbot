import Foundation

public enum LogLevel: String, Comparable, CaseIterable, Sendable {
    case trace, debug, info, warn, error

    var rank: Int {
        switch self {
        case .trace: 0
        case .debug: 1
        case .info: 2
        case .warn: 3
        case .error: 4
        }
    }

    public static func < (lhs: LogLevel, rhs: LogLevel) -> Bool { lhs.rank < rhs.rank }
}

public struct Logger: Sendable {
    public let level: LogLevel

    public init(level: LogLevel) { self.level = level }

    public func log(_ level: LogLevel, _ message: String) {
        guard level >= self.level else { return }
        let ts = ISO8601DateFormatter().string(from: Date())
        print("[\(level.rawValue.uppercased())] \(ts) | \(message)")
    }

    public func trace(_ msg: String) { log(.trace, msg) }
    public func debug(_ msg: String) { log(.debug, msg) }
    public func info(_ msg: String) { log(.info, msg) }
    public func warn(_ msg: String) { log(.warn, msg) }
    public func error(_ msg: String) { log(.error, msg) }
}

extension LogLevel {
    public init?(configValue: String) {
        self.init(rawValue: configValue.lowercased())
    }
}
