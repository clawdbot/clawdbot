import ClawdisProtocol
import Foundation

/// Structured error surfaced when the gateway responds with `{ ok: false }`.
struct GatewayResponseError: LocalizedError, @unchecked Sendable {
    let method: String
    let code: String
    let message: String
    let details: [String: AnyCodable]

    init(method: String, code: String?, message: String?, details: [String: AnyCodable]?) {
        self.method = method
        self.code = (code?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? code!.trimmingCharacters(in: .whitespacesAndNewlines)
            : "GATEWAY_ERROR"
        self.message = (message?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? message!.trimmingCharacters(in: .whitespacesAndNewlines)
            : "gateway error"
        self.details = details ?? [:]
    }

    var errorDescription: String? {
        if self.code == "GATEWAY_ERROR" { return "\(self.method): \(self.message)" }
        return "\(self.method): [\(self.code)] \(self.message)"
    }
}

struct GatewayDecodingError: LocalizedError, Sendable {
    let method: String
    let message: String

    var errorDescription: String? { "\(self.method): \(self.message)" }
}
