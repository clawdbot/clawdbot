import SwiftUI

private struct ExecApprovalPromptDialogModifier: ViewModifier {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    let suppressedApprovalID: String?

    func body(content: Content) -> some View {
        content
            .overlay {
                if let prompt = self.appModel.pendingExecApprovalPrompt,
                   prompt.id != self.suppressedApprovalID
                {
                    ZStack {
                        Color.black.opacity(0.38)
                            .ignoresSafeArea()

                        ExecApprovalPromptCard(
                            prompt: prompt,
                            isResolving: self.appModel.pendingExecApprovalPromptResolving,
                            errorText: self.appModel.pendingExecApprovalPromptErrorText,
                            onAllowOnce: {
                                Task {
                                    await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once")
                                }
                            },
                            onAllowAlways: {
                                Task {
                                    await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always")
                                }
                            },
                            onDeny: {
                                Task {
                                    await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny")
                                }
                            },
                            onCancel: {
                                self.appModel.dismissPendingExecApprovalPrompt()
                            })
                            .padding(.horizontal, 20)
                            .frame(maxWidth: 460)
                            .transition(.scale(scale: 0.98).combined(with: .opacity))
                    }
                    .zIndex(1)
                }
            }
            .animation(.easeInOut(duration: 0.18), value: self.appModel.pendingExecApprovalPrompt?.id)
    }
}

private struct ExecApprovalPromptCard: View {
    let prompt: NodeAppModel.ExecApprovalPrompt
    let isResolving: Bool
    let errorText: String?
    let onAllowOnce: () -> Void
    let onAllowAlways: () -> Void
    let onDeny: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Exec approval required")
                    .font(OpenClawType.headline)
                Text("Review this exec request before continuing. Your decision will be sent back to the gateway.")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
            }

            Text(self.prompt.commandText)
                .font(OpenClawType.mono)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(
                    .black.opacity(0.14),
                    in: RoundedRectangle(cornerRadius: OpenClawRadius.md, style: .continuous))

            VStack(alignment: .leading, spacing: 8) {
                if let host = self.normalized(self.prompt.host) {
                    ExecApprovalPromptMetadataRow(label: "Host", value: host)
                }
                if let nodeId = self.normalized(self.prompt.nodeId) {
                    ExecApprovalPromptMetadataRow(label: "Node", value: nodeId)
                }
                if let agentId = self.normalized(self.prompt.agentId) {
                    ExecApprovalPromptMetadataRow(label: "Agent", value: agentId)
                }
                if let expiresText = self.expiresText(self.prompt.expiresAtMs) {
                    ExecApprovalPromptMetadataRow(label: "Expires", value: expiresText)
                }
            }

            if let errorText = self.normalized(self.errorText) {
                Text(errorText)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(OpenClawBrand.danger)
            }

            if self.isResolving {
                HStack(spacing: 8) {
                    ProgressView()
                        .progressViewStyle(.circular)
                    Text("Resolving…")
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            VStack(spacing: 10) {
                Button {
                    self.onAllowOnce()
                } label: {
                    Text("Allow Once")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.isResolving)

                if self.prompt.allowsAllowAlways {
                    Button {
                        self.onAllowAlways()
                    } label: {
                        Text("Allow Always")
                            .font(OpenClawType.subheadSemiBold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.isResolving)
                }

                HStack(spacing: 10) {
                    Button(role: .destructive) {
                        self.onDeny()
                    } label: {
                        Text("Deny")
                            .font(OpenClawType.subheadSemiBold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.isResolving)

                    Button(role: .cancel) {
                        self.onCancel()
                    } label: {
                        Text("Cancel")
                            .font(OpenClawType.subheadSemiBold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.isResolving)
                }
            }
            .controlSize(.large)
            .frame(maxWidth: .infinity)
        }
        .padding(18)
        .proPanelSurface(tint: OpenClawBrand.accentHot, radius: 20, isProminent: true)
    }

    private func normalized(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func expiresText(_ expiresAtMs: Int64?) -> String? {
        guard let expiresAtMs else { return nil }
        let remainingSeconds = Int((Double(expiresAtMs) / 1000.0) - Date().timeIntervalSince1970)
        if remainingSeconds <= 0 {
            return "expired"
        }
        if remainingSeconds < 60 {
            return "under a minute"
        }
        if remainingSeconds < 3600 {
            let minutes = Int(ceil(Double(remainingSeconds) / 60.0))
            return minutes == 1 ? "about 1 minute" : "about \(minutes) minutes"
        }
        let hours = Int(ceil(Double(remainingSeconds) / 3600.0))
        return hours == 1 ? "about 1 hour" : "about \(hours) hours"
    }
}

private struct ExecApprovalPromptMetadataRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(self.label)
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
            Text(self.value)
                .font(OpenClawType.footnote)
                .textSelection(.enabled)
        }
    }
}

extension View {
    func execApprovalPromptDialog(suppressedApprovalID: String? = nil) -> some View {
        modifier(ExecApprovalPromptDialogModifier(suppressedApprovalID: suppressedApprovalID))
    }
}
