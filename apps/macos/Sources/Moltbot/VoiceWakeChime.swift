import AppKit
import Foundation
import OSLog

enum VoiceWakeChime: Codable, Equatable, Sendable {
    case none
    case system(name: String)
    case custom(displayName: String, bookmark: Data)

    var systemName: String? {
        if case let .system(name) = self {
            return name
        }
        return nil
    }

    var displayLabel: String {
        switch self {
        case .none:
            "No Sound"
        case let .system(name):
            VoiceWakeChimeCatalog.displayName(for: name)
        case let .custom(displayName, _):
            displayName
        }
    }
}

enum VoiceWakeChimeCatalog {
    /// Options shown in the picker.
    static var systemOptions: [String] { SoundEffectCatalog.systemOptions }

    static func displayName(for raw: String) -> String {
        SoundEffectCatalog.displayName(for: raw)
    }

    static func url(for name: String) -> URL? {
        SoundEffectCatalog.url(for: name)
    }
}

@MainActor
enum VoiceWakeChimePlayer {
    private static let logger = Logger(subsystem: "bot.molt", category: "voicewake.chime")
    private static var lastSound: NSSound?

    static func play(_ chime: VoiceWakeChime, reason: String? = nil) {
        guard let sound = self.sound(for: chime) else { return }
        if let reason {
            self.logger.log(level: .info, "chime play reason=\(reason, privacy: .public)")
        } else {
            self.logger.log(level: .info, "chime play")
        }
        DiagnosticsFileLog.shared.log(category: "voicewake.chime", event: "play", fields: [
            "reason": reason ?? "",
            "chime": chime.displayLabel,
            "systemName": chime.systemName ?? "",
        ])
        SoundEffectPlayer.play(sound)
    }

    private static func sound(for chime: VoiceWakeChime) -> NSSound? {
        switch chime {
        case .none:
            nil

        case let .system(name):
            SoundEffectPlayer.sound(named: name)

        case let .custom(_, bookmark):
            SoundEffectPlayer.sound(from: bookmark)
        }
    }
}
