import SwiftUI

/// First-run permissions page: one tap per grant, live status, always skippable.
/// System prompts fire only from the row actions; product opt-ins stay in Settings.
struct OnboardingPermissionsStep: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var permissions = DevicePermissionsModel()
    let onContinue: () -> Void

    var body: some View {
        OnboardingActivationCanvas {
            VStack(alignment: .leading, spacing: 0) {
                OnboardingHeroHeader(
                    title: "Allow access",
                    subtitle: "Choose what your agent can use on this iPhone. Nothing is on until you allow it.")
                    .padding(.top, 18)

                OnboardingIntroPanel {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(DevicePermissionKind.allCases) { kind in
                            self.row(for: kind)
                            if kind != DevicePermissionKind.allCases.last {
                                Divider()
                                    .padding(.leading, 48)
                            }
                        }
                    }
                }
                .padding(.top, 30)

                Text("You can change any of these later in Settings.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)

                Spacer(minLength: 32)

                Button {
                    self.onContinue()
                } label: {
                    Text("Continue")
                        .font(OpenClawType.subheadSemiBold)
                }
                .buttonStyle(OpenClawPrimaryActionButtonStyle())
                .padding(.top, 22)
            }
        }
        .task {
            await self.permissions.refresh()
        }
        .onChange(of: self.scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await self.permissions.refresh() }
        }
    }

    private func row(for kind: DevicePermissionKind) -> some View {
        let grant = self.permissions.grant(for: kind)
        return DevicePermissionRow(
            identifierPrefix: "onboarding-permission",
            identifier: kind.rawValue,
            symbol: kind.symbol,
            tint: kind.tint,
            title: kind.title,
            detail: kind.detail,
            grant: grant,
            isRequesting: self.permissions.requesting.contains(kind),
            statusLabel: grant == .limited ? LocalizedStringResource("Limited") : nil,
            actionTitle: Self.actionTitle(for: grant),
            action: self.action(for: kind, grant: grant))
    }

    private static func actionTitle(for grant: DevicePermissionGrant) -> LocalizedStringResource? {
        switch grant {
        case .notRequested:
            LocalizedStringResource("Allow")
        case .denied:
            LocalizedStringResource("Open Settings")
        case .limited:
            LocalizedStringResource("Manage")
        case .granted:
            nil
        }
    }

    private func action(for kind: DevicePermissionKind, grant: DevicePermissionGrant) -> (() -> Void)? {
        switch grant {
        case .notRequested:
            { Task { await self.permissions.request(kind) } }
        case .denied, .limited:
            { self.openSystemSettings() }
        case .granted:
            nil
        }
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
