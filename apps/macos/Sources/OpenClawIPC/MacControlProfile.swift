import Foundation

public struct MacControlProfile: Equatable, Sendable {
    public let name: String?

    public init(rawValue: String?) throws {
        let value = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if value.isEmpty || value.lowercased() == "default" {
            self.name = nil
            return
        }
        if let reason = Self.validationReason(value) {
            throw MacControlError(code: "invalid_profile", message: "Invalid profile: \(reason)")
        }
        self.name = value
    }

    public static func validationReason(_ value: String) -> String? {
        guard value.utf8.count <= 64,
              value.utf8.first.map(self.isASCIIAlphanumeric) == true,
              value.utf8.allSatisfy({ self.isASCIIAlphanumeric($0) || $0 == 45 || $0 == 95 })
        else {
            return "use 1-64 letters, numbers, underscores, or hyphens, starting with a letter or number"
        }
        guard value == value.lowercased() else {
            return "macOS profile names must be lowercase so state and LaunchAgent identities cannot collide"
        }
        guard !["gateway", "mac", "node"].contains(value) else {
            return "\"\(value)\" is reserved by an existing OpenClaw LaunchAgent"
        }
        return nil
    }

    public func stateDirectoryURL(homeDirectory: URL) -> URL {
        Self.stateDirectoryURL(name: self.name, homeDirectory: homeDirectory)
    }

    public static func stateDirectoryURL(name: String?, homeDirectory: URL) -> URL {
        homeDirectory.appendingPathComponent(name.map { ".openclaw-\($0)" } ?? ".openclaw", isDirectory: true)
    }

    private static func isASCIIAlphanumeric(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
    }
}
