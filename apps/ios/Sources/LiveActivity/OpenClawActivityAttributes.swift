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
            case toolRunning
            case voiceListening
            case voiceSpeaking
            case voiceActive
            case paused
            case idle
            case disconnected
        }

        var status: Status
        var verbatimDetail: String?
        var startedAt: Date
        var agentBadge: String?
        var toolName: String?
        /// Recent playback-envelope samples, oldest first, quantized from 0...1.
        /// Live Activity updates carry the real audible signal across the app/widget boundary.
        var voiceSamples: [UInt8]?

        private enum CodingKeys: String, CodingKey {
            case status
            case verbatimDetail
            case startedAt
            case agentBadge
            case toolName
            case voiceSamples
        }

        private enum LegacyCodingKeys: String, CodingKey {
            case statusText
            case isIdle
            case isDisconnected
            case isConnecting
        }

        init(
            status: Status,
            verbatimDetail: String?,
            startedAt: Date,
            agentBadge: String? = nil,
            toolName: String? = nil,
            voiceSamples: [UInt8]? = nil)
        {
            self.status = status
            self.verbatimDetail = verbatimDetail
            self.startedAt = startedAt
            self.agentBadge = agentBadge
            self.toolName = toolName
            self.voiceSamples = voiceSamples
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.startedAt = try container.decode(Date.self, forKey: .startedAt)

            if let status = try container.decodeIfPresent(Status.self, forKey: .status) {
                self.status = status
                self.verbatimDetail = try container.decodeIfPresent(String.self, forKey: .verbatimDetail)
                self.agentBadge = try container.decodeIfPresent(String.self, forKey: .agentBadge)
                self.toolName = try container.decodeIfPresent(String.self, forKey: .toolName)
                self.voiceSamples = try container.decodeIfPresent([UInt8].self, forKey: .voiceSamples)
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
            status = presentation.status
            self.verbatimDetail = presentation.verbatimDetail
            self.agentBadge = nil
            self.toolName = nil
            self.voiceSamples = nil
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(self.status, forKey: .status)
            try container.encodeIfPresent(self.verbatimDetail, forKey: .verbatimDetail)
            try container.encode(self.startedAt, forKey: .startedAt)
            try container.encodeIfPresent(self.agentBadge, forKey: .agentBadge)
            try container.encodeIfPresent(self.toolName, forKey: .toolName)
            try container.encodeIfPresent(self.voiceSamples, forKey: .voiceSamples)
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
