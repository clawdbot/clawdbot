import MoltbotKit
import MoltbotProtocol
import Foundation

// Prefer the MoltbotKit wrapper to keep gateway request payloads consistent.
typealias AnyCodable = MoltbotKit.AnyCodable
typealias InstanceIdentity = MoltbotKit.InstanceIdentity

extension AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: AnyCodable]? { self.value as? [String: AnyCodable] }
    var arrayValue: [AnyCodable]? { self.value as? [AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}

extension MoltbotProtocol.AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: MoltbotProtocol.AnyCodable]? { self.value as? [String: MoltbotProtocol.AnyCodable] }
    var arrayValue: [MoltbotProtocol.AnyCodable]? { self.value as? [MoltbotProtocol.AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: MoltbotProtocol.AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [MoltbotProtocol.AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}
