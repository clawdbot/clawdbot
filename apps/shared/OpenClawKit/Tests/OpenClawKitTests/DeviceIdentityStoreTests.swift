import CryptoKit
import Foundation
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct DeviceIdentityStoreTests {
    @Test("loads TypeScript PEM identity schema without rewriting or regenerating")
    func loadsTypeScriptPEMIdentitySchema() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let identityURL = tempDir
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(
            at: identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stored = try Self.identityJSON(
            publicKeyPem: Self.pem(
                label: "PUBLIC KEY",
                body: "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="),
            privateKeyPem: Self.pem(
                label: "PRIVATE KEY",
                body: "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"))
        try stored.write(to: identityURL, atomically: true, encoding: .utf8)
        let before = try String(contentsOf: identityURL, encoding: .utf8)

        let identity = DeviceIdentityStore.loadOrCreate(fileURL: identityURL)

        #expect(identity.deviceId == "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c")
        #expect(identity.publicKey == "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=")
        #expect(identity.privateKey == "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
        #expect(DeviceIdentityStore.publicKeyBase64Url(identity) == "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg")
        let signature = try #require(DeviceIdentityStore.signPayload("hello", identity: identity))
        let publicKeyData = try #require(Data(base64Encoded: identity.publicKey))
        let signatureData = try #require(Self.base64UrlDecode(signature))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
        #expect(publicKey.isValidSignature(signatureData, for: Data("hello".utf8)))
        #expect(try String(contentsOf: identityURL, encoding: .utf8) == before)
    }

    @Test("does not overwrite a recognized invalid TypeScript identity schema")
    func preservesInvalidTypeScriptPEMIdentitySchema() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let identityURL = tempDir
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(
            at: identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stored = """
            {
              "version": 1,
              "deviceId": "stale-device-id",
              "publicKeyPem": "not-a-valid-public-key",
              "privateKeyPem": "not-a-valid-private-key",
              "createdAtMs": 1700000000000
            }
            """
        try stored.write(to: identityURL, atomically: true, encoding: .utf8)
        let before = try String(contentsOf: identityURL, encoding: .utf8)

        let identity = DeviceIdentityStore.loadOrCreate(fileURL: identityURL)

        #expect(identity.deviceId != "stale-device-id")
        #expect(try String(contentsOf: identityURL, encoding: .utf8) == before)
    }

    private static func base64UrlDecode(_ value: String) -> Data? {
        let normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = normalized + String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        return Data(base64Encoded: padded)
    }

    private static func identityJSON(publicKeyPem: String, privateKeyPem: String) throws -> String {
        let object: [String: Any] = [
            "version": 1,
            "deviceId": "stale-device-id",
            "publicKeyPem": publicKeyPem,
            "privateKeyPem": privateKeyPem,
            "createdAtMs": 1_700_000_000_000,
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        return String(decoding: data, as: UTF8.self) + "\n"
    }

    private static func pem(label: String, body: String) -> String {
        "-----BEGIN \(label)-----\n\(body)\n-----END \(label)-----\n"
    }
}
