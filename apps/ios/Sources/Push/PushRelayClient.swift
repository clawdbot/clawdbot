import CryptoKit
import DeviceCheck
import Foundation
import StoreKit

enum PushRelayError: LocalizedError {
    case relayBaseURLMissing
    case relayMisconfigured(String)
    case invalidResponse(String)
    case requestFailed(status: Int, message: String)
    case unsupportedAppAttest
    case missingReceipt

    var errorDescription: String? {
        switch self {
        case .relayBaseURLMissing:
            "Push relay base URL missing"
        case let .relayMisconfigured(message):
            message
        case let .invalidResponse(message):
            message
        case let .requestFailed(status, message):
            "Push relay request failed (\(status)): \(message)"
        case .unsupportedAppAttest:
            "App Attest unavailable on this device"
        case .missingReceipt:
            "App Store app transaction missing after refresh"
        }
    }
}

private struct PushRelayChallengeResponse: Decodable {
    var challengeId: String
    var challenge: String
    var expiresAtMs: Int64
}

private struct PushRelayRegisterSignedPayload: Encodable {
    var challengeId: String
    var installationId: String
    var bundleId: String
    var environment: String
    var distribution: String
    var gateway: PushRelayGatewayIdentity
    var appVersion: String
    var apnsToken: String
}

private struct PushRelayAppAttestPayload: Encodable {
    var keyId: String
    var attestationObject: String?
    var assertion: String
    var clientDataHash: String
    var signedPayloadBase64: String
}

private struct PushRelayReceiptPayload: Encodable {
    var base64: String
}

private struct PushRelayRegisterRequest: Encodable {
    var challengeId: String
    var installationId: String
    var bundleId: String
    var environment: String
    var distribution: String
    var gateway: PushRelayGatewayIdentity
    var appVersion: String
    var apnsToken: String
    var appAttest: PushRelayAppAttestPayload
    var receipt: PushRelayReceiptPayload
}

struct PushRelayRegisterResponse: Decodable {
    var relayHandle: String
    var sendGrant: String
    var expiresAtMs: Int64?
    var tokenSuffix: String?
    var status: String
}

private struct RelayErrorResponse: Decodable {
    var error: String?
    var message: String?
    var reason: String?
}

private struct PushRelayAppAttestProof {
    var keyId: String
    var attestationObject: String?
    var assertion: String
    var clientDataHash: String
    var signedPayloadBase64: String
}

private final class PushRelayAppAttestService {
    func createProof(challenge: String, signedPayload: Data) async throws -> PushRelayAppAttestProof {
        let service = DCAppAttestService.shared
        guard service.isSupported else {
            throw PushRelayError.unsupportedAppAttest
        }

        let keyID = try await self.loadOrCreateKeyID(using: service)
        let attestationObject = try await self.attestKeyIfNeeded(
            service: service,
            keyID: keyID,
            challenge: challenge)
        let signedPayloadHash = Data(SHA256.hash(data: signedPayload))
        let assertion = try await self.generateAssertion(
            service: service,
            keyID: keyID,
            signedPayloadHash: signedPayloadHash)

        return PushRelayAppAttestProof(
            keyId: keyID,
            attestationObject: attestationObject,
            assertion: assertion.base64EncodedString(),
            clientDataHash: Self.base64URL(signedPayloadHash),
            signedPayloadBase64: signedPayload.base64EncodedString())
    }

    private func loadOrCreateKeyID(using service: DCAppAttestService) async throws -> String {
        if let existing = PushRelayRegistrationStore.loadAppAttestKeyID(), !existing.isEmpty {
            return existing
        }
        let keyID = try await service.generateKey()
        _ = PushRelayRegistrationStore.saveAppAttestKeyID(keyID)
        return keyID
    }

    private func attestKeyIfNeeded(
        service: DCAppAttestService,
        keyID: String,
        challenge: String)
    async throws -> String? {
        if PushRelayRegistrationStore.loadAttestedKeyID() == keyID {
            return nil
        }
        let challengeData = Data(challenge.utf8)
        let clientDataHash = Data(SHA256.hash(data: challengeData))
        let attestation = try await service.attestKey(keyID, clientDataHash: clientDataHash)
        // Apple treats App Attest key attestation as a one-time operation. Save the
        // attested marker immediately so later receipt/network failures do not cause a
        // permanently broken re-attestation loop on the same key.
        _ = PushRelayRegistrationStore.saveAttestedKeyID(keyID)
        return attestation.base64EncodedString()
    }

    private func generateAssertion(
        service: DCAppAttestService,
        keyID: String,
        signedPayloadHash: Data)
    async throws -> Data {
        do {
            return try await service.generateAssertion(keyID, clientDataHash: signedPayloadHash)
        } catch {
            _ = PushRelayRegistrationStore.clearAppAttestKeyID()
            _ = PushRelayRegistrationStore.clearAttestedKeyID()
            throw error
        }
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private final class PushRelayReceiptProvider {
    func loadReceiptBase64() async throws -> String {
        do {
            let result = try await AppTransaction.shared
            return try Self.appTransactionBase64(result)
        } catch {
            let refreshed = try await AppTransaction.refresh()
            return try Self.appTransactionBase64(refreshed)
        }
    }

    private static func appTransactionBase64(
        _ result: StoreKit.VerificationResult<AppTransaction>) throws -> String
    {
        let jws = result.jwsRepresentation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !jws.isEmpty else {
            throw PushRelayError.missingReceipt
        }
        return Data(jws.utf8).base64EncodedString()
    }
}

/// The client is constructed once and used behind PushRegistrationManager actor isolation.
final class PushRelayClient: @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let jsonDecoder = JSONDecoder()
    private let jsonEncoder = JSONEncoder()
    private let appAttest = PushRelayAppAttestService()
    private let receiptProvider = PushRelayReceiptProvider()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    var normalizedBaseURLString: String {
        Self.normalizeBaseURLString(self.baseURL)
    }

    func register(
        installationId: String,
        bundleId: String,
        appVersion: String,
        environment: PushAPNsEnvironment,
        distribution: PushDistributionMode,
        apnsTokenHex: String,
        gatewayIdentity: PushRelayGatewayIdentity)
    async throws -> PushRelayRegisterResponse {
        let challenge = try await self.fetchChallenge()
        let signedPayload = PushRelayRegisterSignedPayload(
            challengeId: challenge.challengeId,
            installationId: installationId,
            bundleId: bundleId,
            environment: environment.rawValue,
            distribution: distribution.rawValue,
            gateway: gatewayIdentity,
            appVersion: appVersion,
            apnsToken: apnsTokenHex)
        let signedPayloadData = try self.jsonEncoder.encode(signedPayload)
        let appAttest = try await self.appAttest.createProof(
            challenge: challenge.challenge,
            signedPayload: signedPayloadData)
        let receiptBase64 = try await self.receiptProvider.loadReceiptBase64()
        let requestBody = PushRelayRegisterRequest(
            challengeId: signedPayload.challengeId,
            installationId: signedPayload.installationId,
            bundleId: signedPayload.bundleId,
            environment: signedPayload.environment,
            distribution: signedPayload.distribution,
            gateway: signedPayload.gateway,
            appVersion: signedPayload.appVersion,
            apnsToken: signedPayload.apnsToken,
            appAttest: PushRelayAppAttestPayload(
                keyId: appAttest.keyId,
                attestationObject: appAttest.attestationObject,
                assertion: appAttest.assertion,
                clientDataHash: appAttest.clientDataHash,
                signedPayloadBase64: appAttest.signedPayloadBase64),
            receipt: PushRelayReceiptPayload(base64: receiptBase64))

        let endpoint = self.baseURL.appending(path: "v1/push/register")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try self.jsonEncoder.encode(requestBody)

        let (data, response) = try await self.session.data(for: request)
        let status = Self.statusCode(from: response)
        guard (200..<300).contains(status) else {
            if status == 401 {
                // If the relay rejects registration, drop local App Attest state so the next
                // attempt re-attests instead of getting stuck without an attestation object.
                _ = PushRelayRegistrationStore.clearAppAttestKeyID()
                _ = PushRelayRegistrationStore.clearAttestedKeyID()
            }
            throw PushRelayError.requestFailed(
                status: status,
                message: Self.decodeErrorMessage(data: data))
        }
        return try self.decode(PushRelayRegisterResponse.self, from: data)
    }

    private func fetchChallenge() async throws -> PushRelayChallengeResponse {
        let endpoint = self.baseURL.appending(path: "v1/push/challenge")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await self.session.data(for: request)
        let status = Self.statusCode(from: response)
        guard (200..<300).contains(status) else {
            throw PushRelayError.requestFailed(
                status: status,
                message: Self.decodeErrorMessage(data: data))
        }
        return try self.decode(PushRelayChallengeResponse.self, from: data)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try self.jsonDecoder.decode(type, from: data)
        } catch {
            throw PushRelayError.invalidResponse(error.localizedDescription)
        }
    }

    private static func statusCode(from response: URLResponse) -> Int {
        (response as? HTTPURLResponse)?.statusCode ?? 0
    }

    private static func normalizeBaseURLString(_ url: URL) -> String {
        var absolute = url.absoluteString
        while absolute.hasSuffix("/") {
            absolute.removeLast()
        }
        return absolute
    }

    private static func decodeErrorMessage(data: Data) -> String {
        if let decoded = try? JSONDecoder().decode(RelayErrorResponse.self, from: data) {
            let message = decoded.message ?? decoded.reason ?? decoded.error ?? ""
            if !message.isEmpty {
                return message
            }
        }
        let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? "unknown relay error" : raw
    }
}
