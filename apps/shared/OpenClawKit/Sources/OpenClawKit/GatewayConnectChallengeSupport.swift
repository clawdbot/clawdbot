import Foundation
import OpenClawProtocol

public enum GatewayConnectChallengeSupport {
    public static func nonce(from payload: [String: OpenClawProtocol.AnyCodable]?) -> String? {
        guard let nonce = payload?["nonce"]?.value as? String else { return nil }
        let trimmed = nonce.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed
    }

    public static func waitForNonce(
        timeoutSeconds: Double,
        onTimeout: @escaping @Sendable () -> some Error,
        receiveNonce: @escaping @Sendable () async throws -> String?) async throws -> String
    {
        try await AsyncTimeout.withTimeout(
            seconds: timeoutSeconds,
            onTimeout: onTimeout,
            operation: {
                while true {
                    if let nonce = try await receiveNonce() {
                        return nonce
                    }
                }
            })
    }
}
