import CryptoKit
import Foundation

private struct DirectGatewayPushRegistrationPayload: Encodable {
    var transport: String = PushTransportMode.direct.rawValue
    var token: String
    var topic: String
    var environment: String
}

private struct RelayGatewayPushRegistrationPayload: Encodable {
    var transport: String = PushTransportMode.relay.rawValue
    var relayHandle: String
    var sendGrant: String
    var gatewayDeviceId: String
    var installationId: String
    var topic: String
    var environment: String
    var distribution: String
    var tokenDebugSuffix: String?
}

struct PushRelayGatewayIdentity: Codable {
    var deviceId: String
    var publicKey: String
}

actor PushRegistrationManager {
    private let buildConfig: PushBuildConfig
    private let relayClient: PushRelayClient?

    var usesRelayTransport: Bool {
        self.buildConfig.transport == .relay
    }

    init(buildConfig: PushBuildConfig = .current) {
        self.buildConfig = buildConfig
        self.relayClient = buildConfig.relayBaseURL.map { PushRelayClient(baseURL: $0) }
    }

    func makeGatewayRegistrationPayload(
        apnsTokenHex: String,
        topic: String,
        gatewayIdentity: PushRelayGatewayIdentity?)
    async throws -> String {
        switch self.buildConfig.transport {
        case .direct:
            return try Self.encodePayload(
                DirectGatewayPushRegistrationPayload(
                    token: apnsTokenHex,
                    topic: topic,
                    environment: self.buildConfig.apnsEnvironment.rawValue))
        case .relay:
            guard let gatewayIdentity else {
                throw PushRelayError.relayMisconfigured("Missing gateway identity for relay registration")
            }
            return try await self.makeRelayPayload(
                apnsTokenHex: apnsTokenHex,
                topic: topic,
                gatewayIdentity: gatewayIdentity)
        }
    }

    private func makeRelayPayload(
        apnsTokenHex: String,
        topic: String,
        gatewayIdentity: PushRelayGatewayIdentity)
    async throws -> String {
        guard self.buildConfig.distribution == .official else {
            throw PushRelayError.relayMisconfigured(
                "Relay transport requires OpenClawPushDistribution=official")
        }
        guard self.buildConfig.apnsEnvironment == .production else {
            throw PushRelayError.relayMisconfigured(
                "Relay transport requires OpenClawPushAPNsEnvironment=production")
        }
        guard let relayClient = self.relayClient else {
            throw PushRelayError.relayBaseURLMissing
        }
        guard let bundleId = Bundle.main.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
              !bundleId.isEmpty
        else {
            throw PushRelayError.relayMisconfigured("Missing bundle identifier for relay registration")
        }
        guard let installationId = GatewaySettingsStore.loadStableInstanceID()?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !installationId.isEmpty
        else {
            throw PushRelayError.relayMisconfigured("Missing stable installation ID for relay registration")
        }

        let tokenHashHex = Self.sha256Hex(apnsTokenHex)
        let relayOrigin = relayClient.normalizedBaseURLString
        if let stored = PushRelayRegistrationStore.loadRegistrationState(),
           stored.installationId == installationId,
           stored.gatewayDeviceId == gatewayIdentity.deviceId,
           stored.relayOrigin == relayOrigin,
           stored.lastAPNsTokenHashHex == tokenHashHex,
           !Self.isExpired(stored.relayHandleExpiresAtMs)
        {
            return try Self.encodePayload(
                RelayGatewayPushRegistrationPayload(
                    relayHandle: stored.relayHandle,
                    sendGrant: stored.sendGrant,
                    gatewayDeviceId: gatewayIdentity.deviceId,
                    installationId: installationId,
                    topic: topic,
                    environment: self.buildConfig.apnsEnvironment.rawValue,
                    distribution: self.buildConfig.distribution.rawValue,
                    tokenDebugSuffix: stored.tokenDebugSuffix))
        }

        let response = try await relayClient.register(
            installationId: installationId,
            bundleId: bundleId,
            appVersion: DeviceInfoHelper.appVersion(),
            environment: self.buildConfig.apnsEnvironment,
            distribution: self.buildConfig.distribution,
            apnsTokenHex: apnsTokenHex,
            gatewayIdentity: gatewayIdentity)
        let registrationState = PushRelayRegistrationStore.RegistrationState(
            relayHandle: response.relayHandle,
            sendGrant: response.sendGrant,
            relayOrigin: relayOrigin,
            gatewayDeviceId: gatewayIdentity.deviceId,
            relayHandleExpiresAtMs: response.expiresAtMs,
            tokenDebugSuffix: Self.normalizeTokenSuffix(response.tokenSuffix),
            lastAPNsTokenHashHex: tokenHashHex,
            installationId: installationId,
            lastTransport: self.buildConfig.transport.rawValue)
        _ = PushRelayRegistrationStore.saveRegistrationState(registrationState)
        return try Self.encodePayload(
            RelayGatewayPushRegistrationPayload(
                relayHandle: response.relayHandle,
                sendGrant: response.sendGrant,
                gatewayDeviceId: gatewayIdentity.deviceId,
                installationId: installationId,
                topic: topic,
                environment: self.buildConfig.apnsEnvironment.rawValue,
                distribution: self.buildConfig.distribution.rawValue,
                tokenDebugSuffix: registrationState.tokenDebugSuffix))
    }

    private static func isExpired(_ expiresAtMs: Int64?) -> Bool {
        guard let expiresAtMs else { return true }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        // Refresh shortly before expiry so reconnect-path republishes a live handle.
        return expiresAtMs <= nowMs + 60000
    }

    private static func sha256Hex(_ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func normalizeTokenSuffix(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func encodePayload(_ payload: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(payload)
        guard let json = String(data: data, encoding: .utf8) else {
            throw PushRelayError.relayMisconfigured("Failed to encode push registration payload as UTF-8")
        }
        return json
    }
}
