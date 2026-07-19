import Foundation
import OpenClawKit

enum GatewayOnboardingReset {
    @MainActor
    static func prepareForBootstrapPairing(
        appModel: NodeAppModel,
        instanceId: String,
        gatewayStableID: String,
        disconnectGateway: Bool = true,
        defaults: UserDefaults = .standard) async
    {
        _ = await self.prepare(
            appModel: appModel,
            instanceId: instanceId,
            gatewayStableID: gatewayStableID,
            disconnectGateway: disconnectGateway,
            defaults: defaults)
    }

    @MainActor
    static func reset(
        appModel: NodeAppModel,
        instanceId: String,
        defaults: UserDefaults = .standard) async
    {
        guard await self.prepare(
            appModel: appModel,
            instanceId: instanceId,
            gatewayStableID: nil,
            disconnectGateway: true,
            defaults: defaults)
        else { return }
        self.clearOnboardingState(defaults: defaults)
    }

    /// Debug launch reset runs before cache actors exist, so file deletion can
    /// finish synchronously before startup reads pairing defaults.
    @MainActor
    static func resetBeforeStartup(
        appModel: NodeAppModel,
        instanceId: String,
        defaults: UserDefaults = .standard)
    {
        appModel.purgeChatTranscriptCacheBeforeStartup()
        guard self.preparePairingState(
            appModel: appModel,
            instanceId: instanceId,
            gatewayStableID: nil,
            disconnectGateway: true,
            defaults: defaults)
        else { return }
        self.clearOnboardingState(defaults: defaults)
    }

    @MainActor
    private static func prepare(
        appModel: NodeAppModel,
        instanceId: String,
        gatewayStableID: String?,
        disconnectGateway: Bool,
        defaults: UserDefaults) async -> Bool
    {
        await appModel.purgeChatTranscriptCache(gatewayID: gatewayStableID)
        return self.preparePairingState(
            appModel: appModel,
            instanceId: instanceId,
            gatewayStableID: gatewayStableID,
            disconnectGateway: disconnectGateway,
            defaults: defaults)
    }

    @MainActor
    private static func preparePairingState(
        appModel: NodeAppModel,
        instanceId: String,
        gatewayStableID: String?,
        disconnectGateway: Bool,
        defaults: UserDefaults) -> Bool
    {
        guard let deviceId = DeviceIdentityStore.loadOrCreatePersisted()?.deviceId else {
            appModel.gatewayStatusText = "Could not access device identity"
            return false
        }
        let shareDeviceId: String?
        if gatewayStableID != nil {
            guard let resolvedShareDeviceId = DeviceIdentityStore
                .loadOrCreatePersisted(profile: .shareExtension)?
                .deviceId
            else {
                appModel.gatewayStatusText = "Could not access share device identity"
                return false
            }
            shareDeviceId = resolvedShareDeviceId
        } else {
            shareDeviceId = nil
        }

        if disconnectGateway {
            appModel.disconnectGateway()
        }

        let trimmedInstanceId = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedInstanceId.isEmpty {
            if let gatewayStableID {
                GatewaySettingsStore.deleteGatewayCredentials(
                    instanceId: trimmedInstanceId,
                    stableID: gatewayStableID)
            } else {
                GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: trimmedInstanceId)
            }
        }

        if let gatewayStableID {
            let authenticationOwnerID = GatewaySettingsStore.authenticationOwnerID(
                routeStableID: gatewayStableID)
            // Bootstrap replacement invalidates only the target. Other paired gateways remain
            // usable when the user switches back after reviewing or completing this setup.
            DeviceAuthStore.clearToken(deviceId: deviceId, role: "node", gatewayID: authenticationOwnerID)
            DeviceAuthStore.clearToken(deviceId: deviceId, role: "operator", gatewayID: authenticationOwnerID)
            if let shareDeviceId {
                DeviceAuthStore.clearToken(
                    deviceId: shareDeviceId,
                    role: "node",
                    gatewayID: authenticationOwnerID,
                    profile: .shareExtension)
                DeviceAuthStore.clearToken(
                    deviceId: shareDeviceId,
                    role: "operator",
                    gatewayID: authenticationOwnerID,
                    profile: .shareExtension)
            }
            GatewayTLSStore.clearFingerprint(stableID: gatewayStableID)
        } else {
            // Full onboarding reset is the only path that intentionally forgets every gateway.
            DeviceAuthStore.clearToken(deviceId: deviceId, role: "node")
            DeviceAuthStore.clearToken(deviceId: deviceId, role: "operator")
            DeviceAuthStore.clearAll(profile: .shareExtension)
            GatewayTLSStore.clearAllFingerprints()
            GatewaySettingsStore.clearGatewayCustomHeaders()
        }

        if gatewayStableID == nil {
            GatewaySettingsStore.clearGatewayRegistry(defaults: defaults)
        }
        GatewaySettingsStore.clearPreferredGatewayStableID(defaults: defaults)
        GatewaySettingsStore.clearLastDiscoveredGatewayStableID(defaults: defaults)
        defaults.set(false, forKey: "gateway.autoconnect")
        return true
    }

    private static func clearOnboardingState(defaults: UserDefaults) {
        OnboardingStateStore.reset(defaults: defaults)

        defaults.set(false, forKey: "gateway.onboardingComplete")
        defaults.set(false, forKey: "gateway.hasConnectedOnce")
        defaults.set(false, forKey: "gateway.manual.enabled")
        defaults.set("", forKey: "gateway.manual.host")
        defaults.set("", forKey: "gateway.setupCode")
        defaults.set(defaults.integer(forKey: "onboarding.requestID") + 1, forKey: "onboarding.requestID")
    }
}
