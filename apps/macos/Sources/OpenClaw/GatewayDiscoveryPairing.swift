import Foundation
import OpenClawKit

enum GatewayDiscoveryPairingError: LocalizedError, Equatable {
    case invalidSetupCode
    case secureSetupRequired
    case deviceCredentialNotIssued
    case configSaveFailed

    var errorDescription: String? {
        switch self {
        case .invalidSetupCode:
            "That setup code is invalid or expired. Create a fresh code on the Gateway."
        case .secureSetupRequired:
            "Use a TLS setup code that includes a certificate fingerprint and bootstrap token."
        case .deviceCredentialNotIssued:
            "The Gateway authenticated, but did not issue both reusable device credentials. Create a fresh full-access setup code."
        case .configSaveFailed:
            "The Gateway authenticated, but OpenClaw could not save the new route. Your existing connection was preserved."
        }
    }
}

struct AuthenticatedGatewayRoute: Equatable, Sendable {
    let url: URL
    let tlsFingerprint: String
}

enum GatewayDiscoveryPairing {
    static func parseSetup(_ input: String) throws -> GatewayConnectDeepLink {
        guard let link = GatewayConnectDeepLink.fromSetupInput(input), link.isValidEndpoint else {
            throw GatewayDiscoveryPairingError.invalidSetupCode
        }
        guard link.tls,
              let fingerprint = link.tlsFingerprintSha256,
              link.bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
              link.websocketURL?.scheme?.lowercased() == "wss"
        else {
            throw GatewayDiscoveryPairingError.secureSetupRequired
        }
        return link
    }

    static func authenticate(setupInput: String) async throws -> AuthenticatedGatewayRoute {
        let link = try self.parseSetup(setupInput)
        guard let url = link.websocketURL,
              let fingerprint = link.tlsFingerprintSha256,
              let bootstrapToken = link.bootstrapToken,
              let deviceAuthGatewayID = GatewayDiscoveryPreferences.tlsDeviceAuthGatewayID(fingerprint)
        else {
            throw GatewayDiscoveryPairingError.secureSetupRequired
        }

        let tls = GatewayTLSParams(
            required: true,
            expectedFingerprint: fingerprint,
            allowTOFU: false,
            storeKey: nil)
        let channel = GatewayChannelActor(
            url: url,
            token: nil,
            bootstrapToken: bootstrapToken,
            session: WebSocketSessionBox(session: GatewayTLSPinningSession(params: tls)),
            connectOptions: GatewayConnectOptions(
                role: "operator",
                scopes: GatewayChannelActor.defaultOperatorConnectScopes,
                caps: GatewayConnection.operatorClientCaps,
                commands: [],
                permissions: [:],
                clientId: "openclaw-macos",
                clientMode: "ui",
                clientDisplayName: InstanceIdentity.displayName,
                includeDeviceIdentity: true,
                allowStoredDeviceAuth: false,
                deviceAuthGatewayID: deviceAuthGatewayID))
        do {
            try await channel.connect()
            let roles = await channel.currentDeviceAuthRoles()
            guard roles.persisted.isSuperset(of: ["node", "operator"]) else {
                throw GatewayDiscoveryPairingError.deviceCredentialNotIssued
            }
            await channel.shutdown()
            return AuthenticatedGatewayRoute(url: url, tlsFingerprint: fingerprint)
        } catch {
            await channel.shutdown()
            throw error
        }
    }
}
