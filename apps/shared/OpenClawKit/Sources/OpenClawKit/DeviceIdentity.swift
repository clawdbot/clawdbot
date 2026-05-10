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
    private static let stateDirEnv = ["OPENCLAW_STATE_DIR"]

    static func stateDirURL() -> URL {
        for key in self.stateDirEnv {
            if let raw = getenv(key) {
                let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty {
                    return URL(fileURLWithPath: value, isDirectory: true)
                }
            }
        }

        if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            return appSupport.appendingPathComponent("OpenClaw", isDirectory: true)
        }

        return FileManager.default.temporaryDirectory.appendingPathComponent("openclaw", isDirectory: true)
    }
}

public enum DeviceIdentityStore {
    private static let fileName = "device.json"
    private static let ed25519SPKIPrefix = Data([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
        0x70, 0x03, 0x21, 0x00,
    ])
    private static let ed25519PKCS8PrivatePrefix = Data([
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
        0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ])

    public static func loadOrCreate() -> DeviceIdentity {
        self.loadOrCreate(fileURL: self.fileURL())
    }

    static func loadOrCreate(fileURL url: URL) -> DeviceIdentity {
        if let data = try? Data(contentsOf: url) {
            switch self.decodeStoredIdentity(data) {
            case .identity(let decoded):
                return decoded
            case .recognizedInvalid:
                return self.generate()
            case .unknown:
                break
            }
        }
        let identity = self.generate()
        self.save(identity, to: url)
        return identity
    }

    private enum DecodeResult {
        case identity(DeviceIdentity)
        case recognizedInvalid
        case unknown
    }

    private static func decodeStoredIdentity(_ data: Data) -> DecodeResult {
        let decoder = JSONDecoder()
        if let decoded = try? decoder.decode(DeviceIdentity.self, from: data) {
            guard let identity = self.normalizedRawIdentity(decoded) else {
                return .recognizedInvalid
            }
            return .identity(identity)
        }

        if let decoded = try? decoder.decode(PemDeviceIdentity.self, from: data) {
            guard decoded.version == 1,
                  let publicKeyData = self.rawPublicKey(fromPEM: decoded.publicKeyPem),
                  let privateKeyData = self.rawPrivateKey(fromPEM: decoded.privateKeyPem),
                  self.keyPairMatches(publicKeyData: publicKeyData, privateKeyData: privateKeyData)
            else {
                return .recognizedInvalid
            }
            return .identity(DeviceIdentity(
                deviceId: self.deviceId(publicKeyData: publicKeyData),
                publicKey: publicKeyData.base64EncodedString(),
                privateKey: privateKeyData.base64EncodedString(),
                createdAtMs: decoded.createdAtMs))
        }

        return self.hasRecognizedIdentityShape(data) ? .recognizedInvalid : .unknown
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
        let deviceId = self.deviceId(publicKeyData: publicKeyData)
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

    private static func normalizedRawIdentity(_ identity: DeviceIdentity) -> DeviceIdentity? {
        guard !identity.deviceId.isEmpty,
              let publicKeyData = Data(base64Encoded: identity.publicKey),
              let privateKeyData = Data(base64Encoded: identity.privateKey)
        else { return nil }

        guard publicKeyData.count == 32 && privateKeyData.count == 32,
              self.keyPairMatches(publicKeyData: publicKeyData, privateKeyData: privateKeyData)
        else { return nil }
        return DeviceIdentity(
            deviceId: self.deviceId(publicKeyData: publicKeyData),
            publicKey: identity.publicKey,
            privateKey: identity.privateKey,
            createdAtMs: identity.createdAtMs)
    }

    private static func rawPublicKey(fromPEM pem: String) -> Data? {
        guard let der = self.derData(fromPEM: pem),
              der.count == self.ed25519SPKIPrefix.count + 32,
              der.prefix(self.ed25519SPKIPrefix.count) == self.ed25519SPKIPrefix
        else { return nil }
        return der.suffix(32)
    }

    private static func rawPrivateKey(fromPEM pem: String) -> Data? {
        guard let der = self.derData(fromPEM: pem),
              der.count == self.ed25519PKCS8PrivatePrefix.count + 32,
              der.prefix(self.ed25519PKCS8PrivatePrefix.count) == self.ed25519PKCS8PrivatePrefix
        else { return nil }
        return der.suffix(32)
    }

    private static func keyPairMatches(publicKeyData: Data, privateKeyData: Data) -> Bool {
        guard let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyData)
        else {
            return false
        }
        return privateKey.publicKey.rawRepresentation == publicKeyData
    }

    private static func derData(fromPEM pem: String) -> Data? {
        let body = pem
            .split(whereSeparator: \.isNewline)
            .filter { !$0.hasPrefix("-----") }
            .joined()
        return Data(base64Encoded: body)
    }

    private static func hasRecognizedIdentityShape(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        return object.keys.contains("publicKeyPem")
            || object.keys.contains("privateKeyPem")
            || object.keys.contains("publicKey")
            || object.keys.contains("privateKey")
    }

    private static func deviceId(publicKeyData: Data) -> String {
        SHA256.hash(data: publicKeyData).compactMap { String(format: "%02x", $0) }.joined()
    }

    private static func save(_ identity: DeviceIdentity, to url: URL) {
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
            .appendingPathComponent(self.fileName, isDirectory: false)
    }
}

private struct PemDeviceIdentity: Codable {
    var version: Int
    var deviceId: String
    var publicKeyPem: String
    var privateKeyPem: String
    var createdAtMs: Int
}
