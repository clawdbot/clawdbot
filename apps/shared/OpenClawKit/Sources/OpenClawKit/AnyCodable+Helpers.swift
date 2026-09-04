import Foundation

extension AnyCodable {
    public var stringValue: String? {
        self.value as? String
    }

    public var boolValue: Bool? {
        self.value as? Bool
    }

    public var intValue: Int? {
        if let value = self.value as? any BinaryInteger { return Int(exactly: value) }
        if let value = self.value as? any BinaryFloatingPoint { return Int(exactly: value) }
        return nil
    }

    public var doubleValue: Double? {
        if let value = self.value as? Double {
            return value
        }
        if let value = self.value as? Int {
            return Double(value)
        }
        if let number = self.value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return number.doubleValue
        }
        return nil
    }

    public var dictionaryValue: [String: AnyCodable]? {
        if let value = self.value as? [String: AnyCodable] {
            return value
        }
        if let value = self.value as? [String: Any] {
            return value.mapValues(AnyCodable.init)
        }
        if let value = self.value as? NSDictionary {
            var converted: [String: AnyCodable] = [:]
            for case let (key as String, raw) in value {
                converted[key] = AnyCodable(raw)
            }
            return converted
        }
        return nil
    }

    public var arrayValue: [AnyCodable]? {
        if let value = self.value as? [AnyCodable] {
            return value
        }
        if let value = self.value as? [Any] {
            return value.map(AnyCodable.init)
        }
        if let value = self.value as? NSArray {
            return value.map(AnyCodable.init)
        }
        return nil
    }

    public var foundationValue: Any {
        switch self.value {
        case let dict as [String: AnyCodable]:
            dict.mapValues(\.foundationValue)
        case let array as [AnyCodable]:
            array.map(\.foundationValue)
        case let dict as [String: Any]:
            dict.mapValues { AnyCodable($0).foundationValue }
        case let array as [Any]:
            array.map { AnyCodable($0).foundationValue }
        default:
            self.value
        }
    }
}
