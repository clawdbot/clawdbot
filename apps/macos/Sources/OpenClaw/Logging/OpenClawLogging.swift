import Foundation
@_exported import Logging
import os
import OSLog

typealias Logger = Logging.Logger

enum AppLogSettings {
    static let logLevelKey = appLogLevelKey

    static func logLevel() -> Logger.Level {
        if let raw = UserDefaults.standard.string(forKey: self.logLevelKey),
           let level = Logger.Level(rawValue: raw)
        {
            return level
        }
        return .info
    }

    static func setLogLevel(_ level: Logger.Level) {
        UserDefaults.standard.set(level.rawValue, forKey: self.logLevelKey)
    }

    static func fileLoggingEnabled() -> Bool {
        UserDefaults.standard.bool(forKey: debugFileLogEnabledKey)
    }
}

enum AppLogLevel: String, CaseIterable, Identifiable {
    case trace
    case debug
    case info
    case notice
    case warning
    case error
    case critical

    static let `default`: AppLogLevel = .info

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .trace: "Trace"
        case .debug: "Debug"
        case .info: "Info"
        case .notice: "Notice"
        case .warning: "Warning"
        case .error: "Error"
        case .critical: "Critical"
        }
    }
}

enum OpenClawLogging {
    private static let labelSeparator = "::"

    private static let didBootstrap: Void = {
        LoggingSystem.bootstrap { label in
            let (subsystem, category) = Self.parseLabel(label)
            let osHandler = OpenClawOSLogHandler(subsystem: subsystem, category: category)
            let fileHandler = OpenClawFileLogHandler(label: label)
            return MultiplexLogHandler([osHandler, fileHandler])
        }
    }()

    static func bootstrapIfNeeded() {
        _ = self.didBootstrap
    }

    static func makeLabel(subsystem: String, category: String) -> String {
        "\(subsystem)\(self.labelSeparator)\(category)"
    }

    static func parseLabel(_ label: String) -> (String, String) {
        guard let range = label.range(of: labelSeparator) else {
            return ("ai.openclaw", label)
        }
        let subsystem = String(label[..<range.lowerBound])
        let category = String(label[range.upperBound...])
        return (subsystem, category)
    }
}

extension Logging.Logger {
    init(subsystem: String, category: String) {
        OpenClawLogging.bootstrapIfNeeded()
        let label = OpenClawLogging.makeLabel(subsystem: subsystem, category: category)
        self.init(label: label)
    }
}

extension Logger.Message.StringInterpolation {
    mutating func appendInterpolation(_ value: some Any, privacy: OSLogPrivacy) {
        self.appendInterpolation(String(describing: value))
    }
}

private func stringifyLogMetadataValue(_ value: Logger.Metadata.Value) -> String {
    switch value {
    case let .string(text):
        text
    case let .stringConvertible(value):
        String(describing: value)
    case let .array(values):
        "[" + values.map { stringifyLogMetadataValue($0) }.joined(separator: ",") + "]"
    case let .dictionary(entries):
        "{" + entries.map { "\($0.key)=\(stringifyLogMetadataValue($0.value))" }.joined(separator: ",") + "}"
    }
}

private protocol AppLogLevelBackedHandler: LogHandler {
    var metadata: Logger.Metadata { get set }
}

extension AppLogLevelBackedHandler {
    var logLevel: Logger.Level {
        get { AppLogSettings.logLevel() }
        set { AppLogSettings.setLogLevel(newValue) }
    }

    subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { self.metadata[key] }
        set { self.metadata[key] = newValue }
    }
}

struct OpenClawOSLogHandler: AppLogLevelBackedHandler {
    private let osLogger: os.Logger
    var metadata: Logger.Metadata = [:]

    init(subsystem: String, category: String) {
        self.osLogger = os.Logger(subsystem: subsystem, category: category)
    }

    func log(event: LogEvent) {
        self.writeLog(level: event.level, message: event.message, metadata: event.metadata)
    }

    func log(
        level: Logger.Level,
        message: Logger.Message,
        metadata: Logger.Metadata?,
        source: String,
        file: String,
        function: String,
        line: UInt)
    {
        self.writeLog(level: level, message: message, metadata: metadata)
    }

    private func writeLog(
        level: Logger.Level,
        message: Logger.Message,
        metadata: Logger.Metadata?)
    {
        let merged = Self.mergeMetadata(self.metadata, metadata)
        let rendered = Self.renderMessage(message, metadata: merged)
        self.osLogger.log(level: Self.osLogType(for: level), "\(rendered, privacy: .public)")
    }

    private static func osLogType(for level: Logger.Level) -> OSLogType {
        switch level {
        case .trace, .debug:
            .debug
        case .info, .notice:
            .info
        case .warning:
            .default
        case .error:
            .error
        case .critical:
            .fault
        }
    }

    private static func mergeMetadata(
        _ base: Logger.Metadata,
        _ extra: Logger.Metadata?) -> Logger.Metadata
    {
        guard let extra else { return base }
        return base.merging(extra, uniquingKeysWith: { _, new in new })
    }

    private static func renderMessage(_ message: Logger.Message, metadata: Logger.Metadata) -> String {
        guard !metadata.isEmpty else { return message.description }
        let meta = metadata
            .sorted(by: { $0.key < $1.key })
            .map { "\($0.key)=\(stringifyLogMetadataValue($0.value))" }
            .joined(separator: " ")
        return "\(message.description) [\(meta)]"
    }
}

struct OpenClawFileLogHandler: AppLogLevelBackedHandler {
    let label: String
    var metadata: Logger.Metadata = [:]

    func log(event: LogEvent) {
        self.writeLog(
            level: event.level,
            message: event.message,
            metadata: event.metadata,
            source: event.source,
            file: event.file,
            function: event.function,
            line: event.line)
    }

    func log(
        level: Logger.Level,
        message: Logger.Message,
        metadata: Logger.Metadata?,
        source: String,
        file: String,
        function: String,
        line: UInt)
    {
        self.writeLog(
            level: level,
            message: message,
            metadata: metadata,
            source: source,
            file: file,
            function: function,
            line: line)
    }

    private func writeLog(
        level: Logger.Level,
        message: Logger.Message,
        metadata: Logger.Metadata?,
        source: String,
        file: String,
        function: String,
        line: UInt)
    {
        guard AppLogSettings.fileLoggingEnabled() else { return }
        let (subsystem, category) = OpenClawLogging.parseLabel(self.label)
        var fields: [String: String] = [
            "subsystem": subsystem,
            "category": category,
            "level": level.rawValue,
            "source": source,
            "file": file,
            "function": function,
            "line": "\(line)",
        ]
        let merged = self.metadata.merging(metadata ?? [:], uniquingKeysWith: { _, new in new })
        for (key, value) in merged {
            fields["meta.\(key)"] = stringifyLogMetadataValue(value)
        }
        DiagnosticsFileLog.shared.log(category: category, event: message.description, fields: fields)
    }
}
