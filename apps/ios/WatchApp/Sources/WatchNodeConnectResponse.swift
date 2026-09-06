import Foundation

struct WatchNodeConnectResponse: Decodable {
    struct VoiceCredential: Decodable {
        let deviceToken: String
        let role: String
        let scopes: [String]
    }

    static let voiceScopes = ["operator.read", "operator.talk"]

    let sessionToken: String
    let deviceToken: String
    let voiceCredential: VoiceCredential?

    private enum CodingKeys: String, CodingKey {
        case sessionToken
        case deviceToken
        case deviceTokens
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.sessionToken = try container.decode(String.self, forKey: .sessionToken)
        self.deviceToken = try container.decode(String.self, forKey: .deviceToken)
        guard !self.sessionToken.isEmpty, !self.deviceToken.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .deviceToken,
                in: container,
                debugDescription: "Expected non-empty Watch credentials.")
        }
        let credentials = try container.decodeIfPresent([VoiceCredential].self, forKey: .deviceTokens)
        if let credentials {
            guard credentials.count == 1,
                  let credential = credentials.first,
                  credential.role == "operator",
                  !credential.deviceToken.isEmpty,
                  credential.scopes.sorted() == Self.voiceScopes
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .deviceTokens,
                    in: container,
                    debugDescription: "Watch voice requires exactly operator.read and operator.talk.")
            }
            self.voiceCredential = credential
        } else {
            self.voiceCredential = nil
        }
    }
}
