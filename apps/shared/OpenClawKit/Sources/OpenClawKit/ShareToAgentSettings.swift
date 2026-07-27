import Foundation

public enum ShareToAgentSettings {
    private static var suiteName: String {
        OpenClawAppGroup.identifier
    }

    private static let defaultInstructionKey = "share.defaultInstruction"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    public static func loadDefaultInstruction() -> String {
        let raw = self.defaults.string(forKey: self.defaultInstructionKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let raw, !raw.isEmpty {
            return raw
        }
        return ""
    }

    public static func saveDefaultInstruction(_ value: String?) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            self.defaults.removeObject(forKey: self.defaultInstructionKey)
            return
        }
        self.defaults.set(trimmed, forKey: self.defaultInstructionKey)
    }
}
