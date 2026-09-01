import CoreFoundation
import Foundation

/// Lightweight `Codable` wrapper that round-trips heterogeneous JSON payloads.
///
/// Marked `@unchecked Sendable` because it can hold reference types.
public struct AnyCodable: Codable, @unchecked Sendable, Hashable {
    public let value: Any

    public init(_ value: Any) {
        self.value = Self.normalize(value)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let boolVal = try? container.decode(Bool.self) {
            self.value = boolVal
            return
        }
        if let intVal = try? container.decode(Int.self) {
            self.value = intVal
            return
        }
        if let int64Val = try? container.decode(Int64.self) {
            self.value = int64Val
            return
        }
        if let uint64Val = try? container.decode(UInt64.self) {
            self.value = uint64Val
            return
        }
        if let doubleVal = try? container.decode(Double.self) {
            self.value = doubleVal
            return
        }
        if let stringVal = try? container.decode(String.self) {
            self.value = stringVal
            return
        }
        if container.decodeNil() {
            self.value = NSNull()
            return
        }
        if let dict = try? container.decode([String: AnyCodable].self) {
            self.value = dict
            return
        }
        if let array = try? container.decode([AnyCodable].self) {
            self.value = array
            return
        }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self.canonicalValue {
        case let boolVal as Bool: try container.encode(boolVal)
        case let int64Val as Int64: try container.encode(int64Val)
        case let uint64Val as UInt64: try container.encode(uint64Val)
        case let doubleVal as Double: try container.encode(doubleVal)
        case let stringVal as String: try container.encode(stringVal)
        case is NSNull: try container.encodeNil()
        case let dict as [String: AnyCodable]: try container.encode(dict)
        case let array as [AnyCodable]: try container.encode(array)
        default:
            let context = EncodingError.Context(
                codingPath: encoder.codingPath,
                debugDescription: "Unsupported type")
            throw EncodingError.invalidValue(self.value, context)
        }
    }

    private static func normalize(_ value: Any) -> Any {
        // Preserve native scalar types; NSNumber bridging can erase their original numeric kind.
        guard type(of: value) is NSNumber.Type, let number = value as? NSNumber else { return value }
        // Numeric 0/1 also cast to Bool; only CFBoolean represents a JSON boolean.
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
        // NSNumber's integer casts can saturate binary floats. Use native exact conversion
        // before encoding integral floats; decimal boxes retain their original integer precision.
        if !(number is NSDecimalNumber), ["f", "d"].contains(String(cString: number.objCType)) {
            let double = number.doubleValue
            if let int = Int(exactly: double) { return int }
            if let int64 = Int64(exactly: double) { return int64 }
            if let uint64 = UInt64(exactly: double) { return uint64 }
            return double
        }
        if let int = Int(exactly: number) { return int }
        if let int64 = Int64(exactly: number) { return int64 }
        if let uint64 = UInt64(exactly: number) { return uint64 }
        if let double = Double(exactly: number) { return double }
        return value
    }

    /// Preserve constructed raw collections and decoded wrapped collections on .value.
    /// All operations share this projection, so both shapes have identical structural semantics.
    private var canonicalValue: Any {
        switch self.value {
        // Equal integer magnitudes share one hash domain, including Int on 32-bit watchOS.
        case let int as Int:
            return Int64(int)
        case let uint as UInt64:
            if let int64 = Int64(exactly: uint) { return int64 }
            return uint
        case is [String: AnyCodable], is [AnyCodable]:
            return self.value
        case let dict as [String: Any]:
            return dict.mapValues(AnyCodable.init)
        case let array as [Any]:
            return array.map(AnyCodable.init)
        case let dict as NSDictionary:
            var converted: [String: AnyCodable] = [:]
            for case let (key as String, raw) in dict {
                converted[key] = AnyCodable(raw)
            }
            return converted
        default:
            return self.value
        }
    }

    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        switch (lhs.canonicalValue, rhs.canonicalValue) {
        case let (l as Bool, r as Bool): l == r
        case let (l as Int64, r as Int64): l == r
        case let (l as UInt64, r as UInt64): l == r
        case let (l as Double, r as Double): l == r
        case let (l as String, r as String): l == r
        case (_ as NSNull, _ as NSNull): true
        case let (l as [String: AnyCodable], r as [String: AnyCodable]): l == r
        case let (l as [AnyCodable], r as [AnyCodable]): l == r
        default:
            false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self.canonicalValue {
        case let v as Bool:
            hasher.combine(2)
            hasher.combine(v)
        case let v as Int64:
            hasher.combine(0)
            hasher.combine(v)
        case let v as UInt64:
            hasher.combine(7)
            hasher.combine(v)
        case let v as Double:
            hasher.combine(1)
            hasher.combine(v)
        case let v as String:
            hasher.combine(3)
            hasher.combine(v)
        case _ as NSNull:
            hasher.combine(4)
        case let v as [String: AnyCodable]:
            hasher.combine(5)
            hasher.combine(v)
        case let v as [AnyCodable]:
            hasher.combine(6)
            hasher.combine(v)
        default:
            hasher.combine(999)
        }
    }
}
