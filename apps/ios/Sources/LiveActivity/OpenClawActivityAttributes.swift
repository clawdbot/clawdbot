import ActivityKit
import Foundation

/// Shared schema used by iOS app + Live Activity widget extension.
struct OpenClawActivityAttributes: ActivityAttributes {
    var agentName: String
    var sessionKey: String

    struct ContentState: Codable, Hashable {
        enum Status: String, CaseIterable, Codable, Hashable {
            case connecting
            case reconnecting
            case approvalNeeded
            case actionRequired
            case attention
            case idle
            case disconnected
        }

        var status: Status
        var verbatimDetail: String?
        var startedAt: Date

        private enum CodingKeys: String, CodingKey {
            case status
            case verbatimDetail
            case startedAt
        }

        private enum LegacyCodingKeys: String, CodingKey {
            case statusText
            case isIdle
            case isDisconnected
            case isConnecting
        }

        init(status: Status, verbatimDetail: String?, startedAt: Date) {
            self.status = status
            self.verbatimDetail = verbatimDetail
            self.startedAt = startedAt
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.startedAt = try container.decode(Date.self, forKey: .startedAt)

            if let status = try container.decodeIfPresent(Status.self, forKey: .status) {
                self.status = status
                self.verbatimDetail = try container.decodeIfPresent(String.self, forKey: .verbatimDetail)
                return
            }

            // Live Activities can outlive an app update. Decode the shipped boolean
            // schema once, then all new writes use the semantic status shape.
            let legacy = try decoder.container(keyedBy: LegacyCodingKeys.self)
            let statusText = try legacy.decodeIfPresent(String.self, forKey: .statusText)
            let presentation = try Self.legacyPresentation(
                statusText: statusText,
                isIdle: legacy.decodeIfPresent(Bool.self, forKey: .isIdle) ?? false,
                isDisconnected: legacy.decodeIfPresent(Bool.self, forKey: .isDisconnected) ?? false,
                isConnecting: legacy.decodeIfPresent(Bool.self, forKey: .isConnecting) ?? false)
            self.status = presentation.status
            self.verbatimDetail = presentation.verbatimDetail
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(self.status, forKey: .status)
            try container.encodeIfPresent(self.verbatimDetail, forKey: .verbatimDetail)
            try container.encode(self.startedAt, forKey: .startedAt)
        }

        private static func legacyPresentation(
            statusText: String?,
            isIdle: Bool,
            isDisconnected: Bool,
            isConnecting: Bool) -> (status: Status, verbatimDetail: String?)
        {
            if isDisconnected {
                return (.disconnected, nil)
            }
            if isIdle {
                return (.idle, nil)
            }

            let trimmed = statusText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let detail = trimmed.isEmpty ? nil : trimmed
            if isConnecting {
                if let detail, Self.matchesShippedTranslation(detail, key: "Reconnecting...") {
                    return (.reconnecting, nil)
                }
                if let detail, Self.matchesShippedTranslation(detail, key: "Connecting...") {
                    return (.connecting, nil)
                }
                return (.connecting, detail)
            }
            if let detail, Self.matchesShippedTranslation(detail, key: "Approval needed") {
                return (.approvalNeeded, nil)
            }
            if let detail, Self.matchesShippedTranslation(detail, key: "Action required") {
                return (.actionRequired, nil)
            }
            return (.attention, detail)
        }

        private static func matchesShippedTranslation(_ value: String, key: String) -> Bool {
            if value == key {
                return true
            }
            return Bundle.main.localizations.contains { localization in
                guard let path = Bundle.main.path(forResource: localization, ofType: "lproj"),
                      let bundle = Bundle(path: path)
                else {
                    return false
                }
                return bundle.localizedString(forKey: key, value: key, table: nil) == value
            }
        }
    }
}
