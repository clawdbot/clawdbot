import Foundation
import OpenClawKit

enum GatewayOnboardingReset {
    @MainActor
    static func prepareForBootstrapPairing(
        appModel: NodeAppModel,
        instanceId: String,
        defaults: UserDefaults = .standard)
    {
        appModel.disconnectGateway()

        let trimmedInstanceId = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedInstanceId.isEmpty {
            GatewaySettingsStore.deleteGatewayCredentials(instanceId: trimmedInstanceId)
        }

        let deviceId = DeviceIdentityStore.loadOrCreate().deviceId
        DeviceAuthStore.clearToken(deviceId: deviceId, role: "node")
        DeviceAuthStore.clearToken(deviceId: deviceId, role: "operator")

        GatewaySettingsStore.clearLastGatewayConnection(defaults: defaults)
        GatewaySettingsStore.clearPreferredGatewayStableID(defaults: defaults)
        GatewaySettingsStore.clearLastDiscoveredGatewayStableID(defaults: defaults)
        GatewayTLSStore.clearAllFingerprints()
        defaults.set(false, forKey: "gateway.autoconnect")
    }

    @MainActor
    static func reset(
        appModel: NodeAppModel,
        instanceId: String,
        defaults: UserDefaults = .standard)
    {
        self.prepareForBootstrapPairing(appModel: appModel, instanceId: instanceId, defaults: defaults)
        OnboardingStateStore.reset(defaults: defaults)

        defaults.set(false, forKey: "gateway.onboardingComplete")
        defaults.set(false, forKey: "gateway.hasConnectedOnce")
        defaults.set(false, forKey: "gateway.manual.enabled")
        defaults.set("", forKey: "gateway.manual.host")
        defaults.set("", forKey: "gateway.setupCode")
        defaults.set(defaults.integer(forKey: "onboarding.requestID") + 1, forKey: "onboarding.requestID")
    }
}
