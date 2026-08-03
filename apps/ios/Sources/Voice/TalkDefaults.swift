import AVFoundation
import Foundation

enum TalkDefaults {
    static let silenceTimeoutMs = 900
    static let speakerphoneEnabledKey = "talk.speakerphone.enabled"
    static let speakerphoneEnabledByDefault = true

    static func speakerphoneEnabled(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: self.speakerphoneEnabledKey) != nil else {
            return self.speakerphoneEnabledByDefault
        }
        return defaults.bool(forKey: self.speakerphoneEnabledKey)
    }
}

enum TalkAudioRoute {
    static func categoryOptions(speakerphoneEnabled: Bool) -> AVAudioSession.CategoryOptions {
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP, .allowAirPlay]
        if speakerphoneEnabled {
            options.insert(.defaultToSpeaker)
        }
        return options
    }

    static func shouldForceSpeaker(
        preferenceEnabled: Bool,
        outputPortTypes: [AVAudioSession.Port]) -> Bool
    {
        guard preferenceEnabled else { return false }
        guard !outputPortTypes.isEmpty else { return false }
        return outputPortTypes.allSatisfy { $0 == .builtInReceiver || $0 == .builtInSpeaker }
    }
}
