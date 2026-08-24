import SwiftUI

/// OpenClaw's product opt-in for requesting read-only summaries from Apple Health.
/// Apple Health permission remains owned by the system permission sheet and Settings.
struct AppleHealthAccessSectionView: View {
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.scenePhase) private var scenePhase
    @State private var healthEnabled = HealthAuthorization.isEnabled
    @State private var healthError: String?
    @State private var isRequesting = false

    var body: some View {
        DevicePermissionRow(
            identifierPrefix: "apple-health",
            identifier: "summaries",
            symbol: "heart.text.clipboard",
            tint: .red,
            title: LocalizedStringResource("Apple Health Summaries"),
            detail: self.healthDetail,
            grant: self.healthGrant,
            isRequesting: self.isRequesting,
            actionTitle: self.healthActionTitle,
            action: HealthAuthorization.isAvailable ? { self.handleHealthAction() } : nil)
            .onAppear { self.refresh() }
            .onChange(of: self.scenePhase) { _, phase in
                if phase == .active {
                    self.refresh()
                }
            }

        if let healthError {
            Text(healthError)
                .font(OpenClawType.footnote)
                .foregroundStyle(OpenClawBrand.danger)
        }
    }

    private var healthGrant: DevicePermissionGrant {
        guard HealthAuthorization.isAvailable else { return .denied }
        // HealthKit hides read authorization; this is only OpenClaw's sharing switch.
        return self.healthEnabled ? .granted : .notRequested
    }

    private var healthDetail: LocalizedStringResource {
        if !HealthAuthorization.isAvailable {
            return LocalizedStringResource("Apple Health data is unavailable on this device.")
        }
        if self.healthEnabled {
            return LocalizedStringResource(
                """
                Reads steps, sleep, resting heart rate, and workouts from Apple Health only when a summary is \
                requested. Only the aggregate leaves this device through your Gateway to your configured AI provider; \
                raw samples stay on this device and results may remain in chat history.
                """)
        }
        return LocalizedStringResource(
            """
            Creates read-only summaries from the Apple Health app for steps, sleep, resting heart rate, and workouts. \
            Only requested summaries leave this device through your Gateway to your configured AI provider; raw \
            samples stay on this device.
            """)
    }

    private var healthActionTitle: LocalizedStringResource? {
        guard HealthAuthorization.isAvailable else { return nil }
        return self.healthEnabled
            ? LocalizedStringResource("Turn Off Summaries")
            : LocalizedStringResource("Enable Apple Health Summaries")
    }

    private func handleHealthAction() {
        if self.healthEnabled {
            HealthAuthorization.disable()
            self.healthEnabled = false
            self.healthError = nil
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            return
        }

        guard !self.isRequesting else { return }
        Task { @MainActor in
            self.isRequesting = true
            defer { self.isRequesting = false }
            do {
                try await HealthAuthorization.enable()
                self.healthEnabled = true
                self.healthError = nil
                self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            } catch {
                self.healthError = error.localizedDescription
            }
        }
    }

    private func refresh() {
        self.healthEnabled = HealthAuthorization.isEnabled
    }
}
