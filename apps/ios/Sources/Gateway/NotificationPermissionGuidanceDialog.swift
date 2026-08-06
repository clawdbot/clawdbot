import SwiftUI

private struct NotificationPermissionGuidanceDialogModifier: ViewModifier {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    let openNotifications: (String) -> Void

    func body(content: Content) -> some View {
        content
            .overlay {
                if let prompt = self.appModel.pendingNotificationPermissionGuidancePrompt {
                    ZStack {
                        Color.black.opacity(0.38)
                            .ignoresSafeArea()

                        NotificationPermissionGuidanceCard(
                            onOpenNotifications: {
                                let approvalId = prompt.approvalId
                                self.appModel.dismissNotificationPermissionGuidancePrompt(
                                    suppressFuture: false)
                                self.openNotifications(approvalId)
                            },
                            onDismiss: {
                                self.appModel.dismissNotificationPermissionGuidancePrompt(
                                    suppressFuture: false)
                            },
                            onSuppressFuture: {
                                self.appModel.dismissNotificationPermissionGuidancePrompt(
                                    suppressFuture: true)
                            })
                            .padding(.horizontal, 20)
                            .frame(maxWidth: 460)
                            .transition(.scale(scale: 0.98).combined(with: .opacity))
                    }
                    .zIndex(2)
                    .id(prompt.id)
                }
            }
            .animation(
                .easeInOut(duration: 0.18),
                value: self.appModel.pendingNotificationPermissionGuidancePrompt?.id)
    }
}

private struct NotificationPermissionGuidanceCard: View {
    let onOpenNotifications: () -> Void
    let onDismiss: () -> Void
    let onSuppressFuture: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Notifications are off")
                    .font(OpenClawType.headline)
                Text(
                    """
                    Exec approvals can only be reviewed while OpenClaw is open and connected.

                    Enable Notifications to receive approval notifications while OpenClaw is not open.
                    """)
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                Button {
                    self.onOpenNotifications()
                } label: {
                    Text("Open Notifications Settings")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                Button(role: .cancel) {
                    self.onDismiss()
                } label: {
                    Text("Not Now")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button {
                    self.onSuppressFuture()
                } label: {
                    Text("Don't show again")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.large)
            .frame(maxWidth: .infinity)
        }
        .padding(18)
        .proPanelSurface(tint: OpenClawBrand.warn, radius: 20, isProminent: true)
    }
}

extension View {
    func notificationPermissionGuidanceDialog(openNotifications: @escaping (String) -> Void) -> some View {
        modifier(NotificationPermissionGuidanceDialogModifier(openNotifications: openNotifications))
    }
}
