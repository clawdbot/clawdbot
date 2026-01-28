import Foundation

/// Lightweight `Codable` wrapper that round-trips heterogeneous JSON payloads.
///
/// Marked `@unchecked Sendable` because it can hold reference types.
public struct AnyCodable: Codable, @unchecked Sendable, Hashable {
    public let value: Any

    public init(_ value: Any) { self.value = value }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let intVal = try? container.decode(Int.self) { self.value = intVal; return }
        if let doubleVal = try? container.decode(Double.self) { self.value = doubleVal; return }
        if let boolVal = try? container.decode(Bool.self) { self.value = boolVal; return }
        if let stringVal = try? container.decode(String.self) { self.value = stringVal; return }
        if container.decodeNil() { self.value = NSNull(); return }
        if let dict = try? container.decode([String: AnyCodable].self) { self.value = dict; return }
        if let array = try? container.decode([AnyCodable].self) { self.value = array; return }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self.value {
        case let intVal as Int: try container.encode(intVal)
        case let doubleVal as Double: try container.encode(doubleVal)
        case let boolVal as Bool: try container.encode(boolVal)
        case let stringVal as String: try container.encode(stringVal)
        case is NSNull: try container.encodeNil()
        case let dict as [String: AnyCodable]: try container.encode(dict)
        case let array as [AnyCodable]: try container.encode(array)
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as NSDictionary:
            var converted: [String: AnyCodable] = [:]
            for (k, v) in dict {
                guard let key = k as? String else { continue }
                converted[key] = AnyCodable(v)
            }
            try container.encode(converted)
        case let array as NSArray:
            try container.encode(array.map { AnyCodable($0) })
        default:
            let context = EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "Unsupported type")
            throw EncodingError.invalidValue(self.value, context)
        }
    }

    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        switch (lhs.value, rhs.value) {
        case let (l as Int, r as Int): l == r
        case let (l as Double, r as Double): l == r
        case let (l as Bool, r as Bool): l == r
        case let (l as String, r as String): l == r
        case (_ as NSNull, _ as NSNull): true
        case let (l as [String: AnyCodable], r as [String: AnyCodable]): l == r
        case let (l as [AnyCodable], r as [AnyCodable]): l == r
        default:
            false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self.value {
        case let v as Int:
            hasher.combine(0); hasher.combine(v)
        case let v as Double:
            hasher.combine(1); hasher.combine(v)
        case let v as Bool:
            hasher.combine(2); hasher.combine(v)
        case let v as String:
            hasher.combine(3); hasher.combine(v)
        case _ as NSNull:
            hasher.combine(4)
        case let v as [String: AnyCodable]:
            hasher.combine(5)
            for (k, val) in v.sorted(by: { $0.key < $1.key }) {
                hasher.combine(k)
                hasher.combine(val)
            }
        case let v as [AnyCodable]:
            hasher.combine(6)
            for item in v {
                hasher.combine(item)
            }
        default:
            hasher.combine(999)
        }
    }
}
