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
