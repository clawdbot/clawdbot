import Foundation
import OpenClawProtocol

public enum GatewayDeviceAuthPayload {
    public static func buildV3(
        deviceId: String,
        clientId: String,
        clientMode: String,
        role: String,
        scopes: [String],
        signedAtMs: Int,
        token: String?,
        nonce: String,
        platform: String?,
        deviceFamily: String?) -> String
    {
        let scopeString = scopes.joined(separator: ",")
        let authToken = token ?? ""
        let normalizedPlatform = self.normalizeMetadataField(platform)
        let normalizedDeviceFamily = self.normalizeMetadataField(deviceFamily)
        return [
            "v3",
            deviceId,
            clientId,
            clientMode,
            role,
            scopeString,
            String(signedAtMs),
            authToken,
            nonce,
            normalizedPlatform,
            normalizedDeviceFamily,
        ].joined(separator: "|")
    }

    static func normalizeMetadataField(_ value: String?) -> String {
        guard let value else { return "" }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return ""
        }
        // Keep cross-runtime normalization deterministic (TS/Swift/Kotlin):
        // lowercase ASCII A-Z only for auth payload metadata fields.
        var output = String()
        output.reserveCapacity(trimmed.count)
        for scalar in trimmed.unicodeScalars {
            let codePoint = scalar.value
            if codePoint >= 65, codePoint <= 90, let lowered = UnicodeScalar(codePoint + 32) {
                output.unicodeScalars.append(lowered)
            } else {
                output.unicodeScalars.append(scalar)
            }
        }
        return output
    }

    public static func signedDeviceDictionary(
        payload: String,
        identity: DeviceIdentity,
        signedAtMs: Int,
        nonce: String) -> [String: OpenClawProtocol.AnyCodable]?
    {
        guard let signature = DeviceIdentityStore.signPayload(payload, identity: identity),
              let publicKey = DeviceIdentityStore.publicKeyBase64Url(identity)
        else {
            return nil
        }
        return [
            "id": OpenClawProtocol.AnyCodable(identity.deviceId),
            "publicKey": OpenClawProtocol.AnyCodable(publicKey),
            "signature": OpenClawProtocol.AnyCodable(signature),
            "signedAt": OpenClawProtocol.AnyCodable(signedAtMs),
            "nonce": OpenClawProtocol.AnyCodable(nonce),
        ]
    }
}
