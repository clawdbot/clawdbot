import Foundation
import OpenClawProtocol

public enum GatewayDeviceAuthPayload {
    public struct Client: Sendable {
        public let id: String
        public let mode: String

        public init(id: String, mode: String) {
            self.id = id
            self.mode = mode
        }
    }

    public struct Fields: Sendable {
        public let deviceId: String
        public let client: Client
        public let role: String
        public let scopes: [String]
        public let signedAtMs: Int64
        public let token: String?
        public let nonce: String

        public init(
            deviceId: String,
            client: Client,
            role: String,
            scopes: [String],
            signedAtMs: Int64,
            token: String?,
            nonce: String)
        {
            self.deviceId = deviceId
            self.client = client
            self.role = role
            self.scopes = scopes
            self.signedAtMs = signedAtMs
            self.token = token
            self.nonce = nonce
        }
    }

    public static func buildConnectCompatibilityPayload(
        fields: Fields) -> String
    {
        // Managed gateways deployed before v3 metadata payload support still
        // verify v2 signatures. Swift connect signers temporarily omit signed
        // metadata until managed and supported self-managed gateways verify v3.
        let scopeString = fields.scopes.joined(separator: ",")
        let authToken = fields.token ?? ""
        return [
            "v2",
            fields.deviceId,
            fields.client.id,
            fields.client.mode,
            fields.role,
            scopeString,
            String(fields.signedAtMs),
            authToken,
            fields.nonce,
        ].joined(separator: "|")
    }

    /// Keeps the flat overload source-compatible while `Fields` owns canonical serialization.
    public static func buildConnectCompatibilityPayload(
        deviceId: String,
        clientId: String,
        clientMode: String,
        role: String,
        scopes: [String],
        signedAtMs: Int64,
        token: String? = nil,
        nonce: String) -> String
    {
        self.buildConnectCompatibilityPayload(fields: Fields(
            deviceId: deviceId,
            client: Client(id: clientId, mode: clientMode),
            role: role,
            scopes: scopes,
            signedAtMs: signedAtMs,
            token: token,
            nonce: nonce))
    }

    public static func buildV3(
        fields: Fields,
        platform: String?,
        deviceFamily: String?) -> String
    {
        let scopeString = fields.scopes.joined(separator: ",")
        let authToken = fields.token ?? ""
        let normalizedPlatform = self.normalizeMetadataField(platform)
        let normalizedDeviceFamily = self.normalizeMetadataField(deviceFamily)
        return [
            "v3",
            fields.deviceId,
            fields.client.id,
            fields.client.mode,
            fields.role,
            scopeString,
            String(fields.signedAtMs),
            authToken,
            fields.nonce,
            normalizedPlatform,
            normalizedDeviceFamily,
        ].joined(separator: "|")
    }

    /// Keeps the flat overload source-compatible while `Fields` owns canonical serialization.
    public static func buildV3(
        deviceId: String,
        clientId: String,
        clientMode: String,
        role: String,
        scopes: [String],
        signedAtMs: Int64,
        token: String? = nil,
        nonce: String,
        platform: String? = nil,
        deviceFamily: String? = nil) -> String
    {
        self.buildV3(
            fields: Fields(
                deviceId: deviceId,
                client: Client(id: clientId, mode: clientMode),
                role: role,
                scopes: scopes,
                signedAtMs: signedAtMs,
                token: token,
                nonce: nonce),
            platform: platform,
            deviceFamily: deviceFamily)
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
        signedAtMs: Int64,
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
