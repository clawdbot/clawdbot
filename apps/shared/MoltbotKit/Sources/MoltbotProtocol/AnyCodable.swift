import Foundation

/// Lightweight `Codable` wrapper that round-trips heterogeneous JSON payloads.
/// Marked `@unchecked Sendable` because it can hold reference types.
public struct AnyCodable: Codable, @unchecked Sendable {
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
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Unsupported type")
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
            let context = EncodingError.Context(
                codingPath: encoder.codingPath,
                debugDescription: "Unsupported type")
            throw EncodingError.invalidValue(self.value, context)
        }
    }
}
