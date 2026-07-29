import Foundation
import OpenClawProtocol

#if DEBUG
@MainActor
extension QuickChatController {
    struct TestingSnapshot: Equatable {
        let isVisible: Bool
        let hasGlobalMonitor: Bool
        let hasLocalMonitor: Bool
        let hotkeyRegistered: Bool
        let isEnabled: Bool
    }

    static func exerciseForTesting() -> [TestingSnapshot] {
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main",
                    mainkey: "main",
                    scope: AnyCodable("per-agent"),
                    agents: [])
            },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _, _, _, _ in "started" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available })
        let controller = QuickChatController(
            enableUI: false,
            model: model,
            monitoringEnabled: true,
            globalMonitorInstaller: { _, _ in NSObject() },
            localMonitorInstaller: { _, _ in NSObject() },
            monitorClearer: { $0 = nil },
            hotkeyRegistrar: { _ in },
            hotkeyRemover: {},
            allowsHotkeyRegistrationInTests: true)
        controller.start()
        controller.setEnabled(true)
        let started = controller.testingSnapshot
        controller.present()
        let presented = controller.testingSnapshot
        controller.setEnabled(false)
        let disabled = controller.testingSnapshot
        controller.stop()
        return [started, presented, disabled, controller.testingSnapshot]
    }

    var testingSnapshot: TestingSnapshot {
        TestingSnapshot(
            isVisible: self.isVisible,
            hasGlobalMonitor: self.hasGlobalMonitorForTesting,
            hasLocalMonitor: self.hasLocalMonitorForTesting,
            hotkeyRegistered: self.hotkeyRegisteredForTesting,
            isEnabled: self.isEnabled)
    }
}
#endif
