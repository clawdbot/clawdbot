import CryptoKit
import Foundation

public struct DeviceIdentity: Codable, Sendable {
    public var deviceId: String
    public var publicKey: String
    public var privateKey: String
    public var createdAtMs: Int

    public init(deviceId: String, publicKey: String, privateKey: String, createdAtMs: Int) {
        self.deviceId = deviceId
        self.publicKey = publicKey
        self.privateKey = privateKey
        self.createdAtMs = createdAtMs
    }
}

enum DeviceIdentityPaths {
    private static let stateDirEnv = "CLAWDBOT_STATE_DIR"

    static func stateDirURL() -> URL {
        if let raw = getenv(self.stateDirEnv) {
            let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty {
                return URL(fileURLWithPath: value, isDirectory: true)
            }
        }

        if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            return appSupport.appendingPathComponent("moltbot", isDirectory: true)
        }

        return FileManager.default.temporaryDirectory.appendingPathComponent("moltbot", isDirectory: true)
    }
}

public enum DeviceIdentityStore {
    private static let fileName = "device.json"

    public static func loadOrCreate() -> DeviceIdentity {
        let url = self.fileURL()
        if let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode(DeviceIdentity.self, from: data),
           !decoded.deviceId.isEmpty,
           !decoded.publicKey.isEmpty,
           !decoded.privateKey.isEmpty {
            return decoded
        }
        let identity = self.generate()
        self.save(identity)
        return identity
    }

    public static func signPayload(_ payload: String, identity: DeviceIdentity) -> String? {
        guard let privateKeyData = Data(base64Encoded: identity.privateKey) else { return nil }
        do {
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyData)
            let signature = try privateKey.signature(for: Data(payload.utf8))
            return self.base64UrlEncode(signature)
        } catch {
            return nil
        }
    }

    private static func generate() -> DeviceIdentity {
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey
        let publicKeyData = publicKey.rawRepresentation
        let privateKeyData = privateKey.rawRepresentation
        let deviceId = SHA256.hash(data: publicKeyData).compactMap { String(format: "%02x", $0) }.joined()
        return DeviceIdentity(
            deviceId: deviceId,
            publicKey: publicKeyData.base64EncodedString(),
            privateKey: privateKeyData.base64EncodedString(),
            createdAtMs: Int(Date().timeIntervalSince1970 * 1000))
    }

    private static func base64UrlEncode(_ data: Data) -> String {
        let base64 = data.base64EncodedString()
        return base64
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func publicKeyBase64Url(_ identity: DeviceIdentity) -> String? {
        guard let data = Data(base64Encoded: identity.publicKey) else { return nil }
        return self.base64UrlEncode(data)
    }

    private static func save(_ identity: DeviceIdentity) {
        let url = self.fileURL()
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(identity)
            try data.write(to: url, options: [.atomic])
        } catch {
            // best-effort only
        }
    }

    private static func fileURL() -> URL {
        let base = DeviceIdentityPaths.stateDirURL()
        return base
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(fileName, isDirectory: false)
    }
}
