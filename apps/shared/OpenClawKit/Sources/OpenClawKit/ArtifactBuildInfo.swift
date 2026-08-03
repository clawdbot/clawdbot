import Foundation

public struct ArtifactBuildInfo: Equatable, Sendable {
    public let version: String
    public let build: String
    public let gitCommit: String?
    public let buildTimestamp: String?
    public let builtAt: Date?

    public init(
        infoDictionary: [String: Any],
        versionKeys: [String] = ["CFBundleShortVersionString"])
    {
        self.version = versionKeys.lazy.compactMap { Self.nonEmptyString(infoDictionary[$0]) }.first ?? "dev"
        self.build = Self.nonEmptyString(infoDictionary["CFBundleVersion"]) ?? ""
        self.gitCommit = Self.validGitCommit(Self.nonEmptyString(infoDictionary["OpenClawGitCommit"]))
        let buildTimestamp = Self.nonEmptyString(infoDictionary["OpenClawBuildTimestamp"])
        self.builtAt = buildTimestamp.flatMap(Self.parseBuildTimestamp)
        self.buildTimestamp = self.builtAt == nil ? nil : buildTimestamp
    }

    public var versionDisplay: String {
        if self.build.isEmpty || self.build == self.version {
            return self.version
        }
        return "\(self.version) (\(self.build))"
    }

    public var shortCommit: String? {
        self.gitCommit.map { String($0.prefix(12)) }
    }

    public var spokenCommit: String? {
        self.gitCommit.map { $0.map(String.init).joined(separator: " ") }
    }

    public func localizedBuildDate(
        locale: Locale = .current,
        timeZone: TimeZone = TimeZone(secondsFromGMT: 0)!) -> String?
    {
        guard let builtAt else { return nil }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: builtAt)
    }

    public var copyText: String {
        [
            "Version \(self.versionDisplay)",
            "Commit \(self.gitCommit ?? "Unavailable")",
            "Built \(self.buildTimestamp ?? "Unavailable")",
        ].joined(separator: "\n")
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func validGitCommit(_ value: String?) -> String? {
        guard let value, value.utf8.count == 40 else { return nil }
        let isAsciiHex = value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...70).contains(byte) || (97...102).contains(byte)
        }
        guard isAsciiHex else { return nil }
        return value.lowercased()
    }

    private static func parseBuildTimestamp(_ value: String) -> Date? {
        let utcPattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$"#
        guard value.range(of: utcPattern, options: .regularExpression) != nil else { return nil }
        let withoutZulu = String(value.dropLast())
        let canonicalValue: String
        if let fractionSeparator = withoutZulu.lastIndex(of: ".") {
            let prefix = withoutZulu[...fractionSeparator]
            let fraction = withoutZulu[withoutZulu.index(after: fractionSeparator)...]
            let paddedFraction = String(fraction).padding(toLength: 3, withPad: "0", startingAt: 0)
            canonicalValue = "\(prefix)\(paddedFraction)Z"
        } else {
            canonicalValue = "\(withoutZulu).000Z"
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: canonicalValue) else { return nil }
        return formatter.string(from: date) == canonicalValue ? date : nil
    }
}
