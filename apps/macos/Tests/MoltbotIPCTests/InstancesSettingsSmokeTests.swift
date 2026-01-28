import Testing
@testable import Moltbot

@Suite(.serialized)
@MainActor
struct InstancesSettingsSmokeTests {
    @Test func instancesSettingsBuildsBodyWithMultipleInstances() {
        let store = InstancesStore(isPreview: true)
        store.statusMessage = "Loaded"
        store.instances = [
            InstanceInfo(
                id: "macbook",
                host: "macbook-pro",
                ip: "10.0.0.2",
                version: "1.2.3",
                platform: "macOS 15.1",
                deviceFamily: "Mac",
                modelIdentifier: "MacBookPro18,1",
                lastInputSeconds: 15,
                mode: "local",
                reason: "heartbeat",
                text: "MacBook Pro local",
                ts: 1_700_000_000_000),
            InstanceInfo(
                id: "android",
                host: "pixel",
                ip: "10.0.0.3",
                version: "2.0.0",
                platform: "Android 14",
                deviceFamily: "Android",
                modelIdentifier: nil,
                lastInputSeconds: 120,
                mode: "node",
                reason: "presence",
                text: "Android node",
                ts: 1_700_000_100_000),
            InstanceInfo(
                id: "gateway",
                host: "gateway",
                ip: "10.0.0.4",
                version: "3.0.0",
                platform: "iOS 18",
                deviceFamily: nil,
                modelIdentifier: nil,
                lastInputSeconds: nil,
                mode: "gateway",
                reason: "gateway",
                text: "Gateway",
                ts: 1_700_000_200_000),
        ]

        let view = InstancesSettings(store: store)
        _ = view.body
    }

    @Test func instancesSettingsExercisesHelpers() {
        InstancesSettings.exerciseForTesting()
    }
}
