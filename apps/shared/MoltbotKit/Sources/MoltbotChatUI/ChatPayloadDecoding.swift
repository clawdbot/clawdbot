import MoltbotKit
import Foundation

enum ChatPayloadDecoding {
    static func decode<T: Decodable>(_ payload: AnyCodable, as _: T.Type = T.self) throws -> T {
        let data = try JSONEncoder().encode(payload)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
