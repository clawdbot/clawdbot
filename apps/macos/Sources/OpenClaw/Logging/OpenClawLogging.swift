import CryptoKit
import Foundation
@_exported import Logging
import os
import OSLog

typealias Logger = Logging.Logger

enum AppLogSettings {
    static let logLevelKey = appLogLevelKey

    static func logLevel() -> Logger.Level {
        if let raw = AppDefaults.standard.string(forKey: self.logLevelKey),
           let level = Logger.Level(rawValue: raw)
        {
            return level
        }
        return .info
    }

    static func setLogLevel(_ level: Logger.Level) {
        AppDefaults.standard.set(level.rawValue, forKey: self.logLevelKey)
    }

    static func fileLoggingEnabled() -> Bool {
        AppDefaults.standard.bool(forKey: debugFileLogEnabledKey)
    }
}

extension Logger.Level {
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

enum AppLogPrivacy {
    enum Mask {
        case none, hash
    }

    case `public`
    case `private`(mask: Mask)

    static var `private`: Self {
        .private(mask: .none)
    }

    /// Correlate within this process without persisting a key or exposing guessable identifiers.
    fileprivate static let hashKey = SymmetricKey(size: .bits256)
}

/// swift-log uses DefaultStringInterpolation, including for concatenated String messages.
/// Redact here: its Message stores only text, so neither sink can recover privacy afterward.
extension DefaultStringInterpolation {
    mutating func appendInterpolation(
        _ value: @autoclosure () -> some Any,
        privacy: AppLogPrivacy)
    {
        switch privacy {
        case .public:
            self.appendInterpolation(String(describing: value()))
        case .private(mask: .none):
            self.appendLiteral("<private>")
        case .private(mask: .hash):
            let bytes = Data(String(describing: value()).utf8)
            let hash = HMAC<SHA256>.authenticationCode(for: bytes, using: AppLogPrivacy.hashKey)
            self.appendLiteral("<private:\(Data(hash).base64EncodedString())>")
        }
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
        let merged = self.metadata.merging(event.metadata ?? [:], uniquingKeysWith: { _, new in new })
        let rendered = Self.renderMessage(event.message, metadata: merged)
        self.osLogger.log(level: Self.osLogType(for: event.level), "\(rendered, privacy: .public)")
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
        guard AppLogSettings.fileLoggingEnabled() else { return }
        let (subsystem, category) = OpenClawLogging.parseLabel(self.label)
        var fields: [String: String] = [
            "subsystem": subsystem,
            "category": category,
            "level": event.level.rawValue,
            "source": event.source,
            "file": event.file,
            "function": event.function,
            "line": "\(event.line)",
        ]
        let merged = self.metadata.merging(event.metadata ?? [:], uniquingKeysWith: { _, new in new })
        for (key, value) in merged {
            fields["meta.\(key)"] = stringifyLogMetadataValue(value)
        }
        DiagnosticsFileLog.shared.log(category: category, event: event.message.description, fields: fields)
    }
}
