import Foundation
import OpenClawKit

extension GatewayConnectionController {
    static func migrateLegacyDeviceAuth() {
        guard
            let primaryIdentity = DeviceIdentityStore.loadOrCreatePersisted(),
            let shareIdentity = DeviceIdentityStore.loadOrCreatePersisted(profile: .shareExtension)
        else { return }
        let migrationGatewayID = self.legacyDeviceAuthMigrationGatewayID()
        let relay = ShareGatewayRelaySettings.loadConfig()
        let instanceID = GatewaySettingsStore.currentInstanceID()
        if let migrationGatewayID, let relay {
            _ = GatewaySettingsStore.migrateProvenRelayCredentials(
                instanceId: instanceID,
                gatewayStableID: migrationGatewayID,
                token: relay.token,
                password: relay.password)
        } else {
            GatewaySettingsStore.discardUnscopedGatewayCredentials(instanceId: instanceID)
        }
        // The extension connects independently, so the host's last route cannot prove who
        // issued its legacy token. Require one extension re-pair instead of guessing an owner.
        DeviceAuthStore.discardUnscopedTokens(
            deviceId: shareIdentity.deviceId,
            profile: .shareExtension)
        guard let migrationGatewayID else {
            // No cross-gateway fallback: ambiguous legacy tokens require one explicit re-pair.
            DeviceAuthStore.discardUnscopedTokens(deviceId: primaryIdentity.deviceId)
            return
        }

        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: migrationGatewayID)
        let hasProvenOperatorCredentials = credentials.token != nil || credentials.password != nil
        if hasProvenOperatorCredentials {
            // Shared credentials recover the independently authenticated operator session.
            // Without them, migrate neither role so reconnect enters the normal re-pair flow.
            DeviceAuthStore.migrateUnscopedToken(
                deviceId: primaryIdentity.deviceId,
                role: "node",
                toGatewayID: migrationGatewayID)
        }
        DeviceAuthStore.discardUnscopedTokens(deviceId: primaryIdentity.deviceId)
        guard let relay else { return }
        // Stable IDs are opaque byte-exact tokens; do not trim or normalize before comparing.
        guard GatewayStableIdentifier.exact(relay.gatewayStableID) == nil else { return }
        ShareGatewayRelaySettings.saveConfig(ShareGatewayRelayConfig(
            gatewayURLString: relay.gatewayURLString,
            gatewayStableID: migrationGatewayID,
            token: relay.token,
            password: relay.password,
            sessionKey: relay.sessionKey,
            deliveryChannel: relay.deliveryChannel,
            deliveryTo: relay.deliveryTo))
    }

    private static func legacyDeviceAuthMigrationGatewayID() -> String? {
        guard let relay = ShareGatewayRelaySettings.loadConfig() else { return nil }
        if let stableID = GatewayStableIdentifier.exact(relay.gatewayStableID) {
            return stableID
        }
        guard let active = GatewaySettingsStore.activeGatewayEntry(),
              active.kind == .manual,
              let host = active.host,
              let port = active.port,
              let relayURL = URL(string: relay.gatewayURLString),
              relayURL.host?.caseInsensitiveCompare(host) == .orderedSame
        else { return nil }
        let relayPort = relayURL.port ?? (relayURL.scheme?.lowercased() == "wss" ? 443 : 80)
        let relayUsesTLS = relayURL.scheme?.lowercased() == "wss"
        guard relayPort == port, relayUsesTLS == active.useTLS else { return nil }
        return active.stableID
    }

    struct ManualAuthOverride: Equatable {
        struct SetupAuth {
            let token: String
            let bootstrapToken: String
            let password: String
            let targetStableID: String

            var hasBootstrapToken: Bool {
                !self.bootstrapToken.isEmpty
            }

            var manualAuthOverride: ManualAuthOverride {
                // Setup-link credentials are endpoint-scoped. An explicit empty override prevents
                // a new host from falling back to credentials stored for the previous gateway.
                ManualAuthOverride.explicit(
                    token: self.token,
                    bootstrapToken: self.bootstrapToken,
                    password: self.password,
                    targetStableID: self.targetStableID,
                    suppressStoredDeviceAuth: true)
            }
        }

        let token: String?
        let bootstrapToken: String?
        let password: String?
        let targetStableID: String?
        let suppressStoredDeviceAuth: Bool

        static func explicit(
            token: String?,
            bootstrapToken: String?,
            password: String?,
            targetStableID: String? = nil,
            suppressStoredDeviceAuth: Bool) -> ManualAuthOverride
        {
            let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let trimmedBootstrapToken = bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let trimmedPassword = password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return ManualAuthOverride(
                token: trimmedToken.isEmpty ? nil : trimmedToken,
                bootstrapToken: trimmedBootstrapToken.isEmpty ? nil : trimmedBootstrapToken,
                password: trimmedPassword.isEmpty ? nil : trimmedPassword,
                targetStableID: targetStableID,
                suppressStoredDeviceAuth: suppressStoredDeviceAuth)
        }

        static func normalized(
            token: String?,
            bootstrapToken: String?,
            password: String?) -> ManualAuthOverride?
        {
            let override = ManualAuthOverride.explicit(
                token: token,
                bootstrapToken: bootstrapToken,
                password: password,
                suppressStoredDeviceAuth: false)
            guard override.token != nil || override.bootstrapToken != nil || override.password != nil
            else { return nil }
            return override
        }

        static func persisted(instanceId: String, targetStableID: String) -> ManualAuthOverride? {
            let authenticationOwnerID = GatewaySettingsStore.authenticationOwnerID(
                routeStableID: targetStableID)
            guard let metadata = GatewaySettingsStore.loadGatewayCredentialMetadata(
                instanceId: instanceId,
                gatewayStableID: authenticationOwnerID)
            else { return nil }
            let credentials = GatewaySettingsStore.loadGatewayCredentials(
                instanceId: instanceId,
                gatewayStableID: targetStableID)
            return ManualAuthOverride.explicit(
                token: credentials.token,
                bootstrapToken: credentials.bootstrapToken,
                password: credentials.password,
                targetStableID: targetStableID,
                suppressStoredDeviceAuth: metadata.suppressStoredDeviceAuth)
        }

        static func currentManualInput(
            token: String?,
            pendingOverride: ManualAuthOverride?,
            password: String?,
            targetStableID: String? = nil) -> ManualAuthOverride?
        {
            guard let pendingOverride else {
                return ManualAuthOverride.normalized(token: token, bootstrapToken: nil, password: password)
            }
            if let pendingTarget = pendingOverride.targetStableID,
               !GatewayStableIdentifier.matches(pendingTarget, targetStableID)
            {
                let normalizedInput = ManualAuthOverride.explicit(
                    token: token,
                    bootstrapToken: nil,
                    password: password,
                    targetStableID: targetStableID,
                    suppressStoredDeviceAuth: true)
                // Setup-link fields retain their source provenance. When the endpoint changes,
                // carry only values the user replaced instead of forwarding source credentials.
                return ManualAuthOverride.explicit(
                    token: normalizedInput.token == pendingOverride.token ? nil : normalizedInput.token,
                    bootstrapToken: nil,
                    password: normalizedInput.password == pendingOverride.password ? nil : normalizedInput.password,
                    targetStableID: targetStableID,
                    suppressStoredDeviceAuth: true)
            }
            return ManualAuthOverride.explicit(
                token: token,
                bootstrapToken: pendingOverride.bootstrapToken,
                password: password,
                targetStableID: pendingOverride.targetStableID,
                suppressStoredDeviceAuth: pendingOverride.suppressStoredDeviceAuth)
        }

        static func manualStableID(host: String, port: Int) -> String {
            "manual|\(host.lowercased())|\(port)"
        }

        static func setupAuth(from link: GatewayConnectDeepLink) -> SetupAuth {
            SetupAuth(
                token: link.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                bootstrapToken: link.bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                password: link.password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                targetStableID: self.manualStableID(host: link.host, port: link.port))
        }
    }
}
