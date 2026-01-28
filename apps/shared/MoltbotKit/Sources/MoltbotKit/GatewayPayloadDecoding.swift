import MoltbotProtocol
import Foundation

public enum GatewayPayloadDecoding {
    public static func decode<T: Decodable>(
        _ payload: MoltbotProtocol.AnyCodable,
        as _: T.Type = T.self) throws -> T
    {
        let data = try JSONEncoder().encode(payload)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public static func decode<T: Decodable>(
        _ payload: AnyCodable,
        as _: T.Type = T.self) throws -> T
    {
        let data = try JSONEncoder().encode(payload)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public static func decodeIfPresent<T: Decodable>(
        _ payload: MoltbotProtocol.AnyCodable?,
        as _: T.Type = T.self) throws -> T?
    {
        guard let payload else { return nil }
        return try self.decode(payload, as: T.self)
    }

    public static func decodeIfPresent<T: Decodable>(
        _ payload: AnyCodable?,
        as _: T.Type = T.self) throws -> T?
    {
        guard let payload else { return nil }
        return try self.decode(payload, as: T.self)
    }
}
