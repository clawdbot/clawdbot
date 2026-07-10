import CryptoKit
import Foundation
import Testing
@testable import OpenClawKit

@Suite("DeviceAuthPayload")
struct DeviceAuthPayloadTests {
    @Test
    func `builds Swift connect compatibility payload with v2 canonical fields`() {
        let signedAtMs: Int64 = 1_800_000_000_000
        let payload = GatewayDeviceAuthPayload.buildConnectCompatibilityPayload(
            fields: .init(
                deviceId: "dev-1",
                client: .init(id: "openclaw-macos", mode: "ui"),
                role: "operator",
                scopes: ["operator.admin", "operator.read"],
                signedAtMs: signedAtMs,
                token: "tok-123",
                nonce: "nonce-abc"))
        #expect(
            payload
                == "v2|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1800000000000|tok-123|nonce-abc")
    }

    @Test
    func `builds canonical v3 payload vector`() {
        let signedAtMs: Int64 = 1_800_000_000_000
        let payload = GatewayDeviceAuthPayload.buildV3(
            fields: .init(
                deviceId: "dev-1",
                client: .init(id: "openclaw-macos", mode: "ui"),
                role: "operator",
                scopes: ["operator.admin", "operator.read"],
                signedAtMs: signedAtMs,
                token: "tok-123",
                nonce: "nonce-abc"),
            platform: "  IOS  ",
            deviceFamily: "  iPhone  ")
        #expect(
            payload
                ==
                "v3|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1800000000000|tok-123|nonce-abc|ios|iphone")
    }

    @Test
    func `signed device dictionary preserves 64-bit timestamp`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let identityURL = tempDir.appendingPathComponent("device.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let identity = DeviceIdentityStore.loadOrCreate(fileURL: identityURL)
        let signedAtMs: Int64 = 1_800_000_000_000
        let payload = GatewayDeviceAuthPayload.buildV3(
            fields: .init(
                deviceId: identity.deviceId,
                client: .init(id: "openclaw-watchos", mode: "node"),
                role: "node",
                scopes: [],
                signedAtMs: signedAtMs,
                token: "device-token",
                nonce: "nonce-abc"),
            platform: "watchOS",
            deviceFamily: "Apple Watch")

        let device = try #require(GatewayDeviceAuthPayload.signedDeviceDictionary(
            payload: payload,
            identity: identity,
            signedAtMs: signedAtMs,
            nonce: "nonce-abc"))
        let signature = try #require(device["signature"]?.value as? String)
        let signatureBase64 = signature
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let signaturePadding = String(repeating: "=", count: (4 - signatureBase64.count % 4) % 4)
        let signatureData = try #require(Data(base64Encoded: signatureBase64 + signaturePadding))
        let publicKeyData = try #require(Data(base64Encoded: identity.publicKey))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
        let data = try JSONEncoder().encode(device)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(publicKey.isValidSignature(signatureData, for: Data(payload.utf8)))
        #expect((object["signedAt"] as? NSNumber)?.int64Value == signedAtMs)
    }

    @Test
    func `normalizes metadata with ASCII-only lowercase`() {
        #expect(GatewayDeviceAuthPayload.normalizeMetadataField("  İOS  ") == "İos")
        #expect(GatewayDeviceAuthPayload.normalizeMetadataField("  MAC  ") == "mac")
        #expect(GatewayDeviceAuthPayload.normalizeMetadataField(nil) == "")
    }
}
