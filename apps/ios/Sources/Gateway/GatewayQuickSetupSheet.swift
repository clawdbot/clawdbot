import OpenClawKit
import SwiftUI

#if DEBUG
import Network
#endif

struct GatewayQuickSetupSheet: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.dismiss) private var dismiss

    let onUseManualSetup: () -> Void

    @AppStorage("onboarding.quickSetupDismissed") private var quickSetupDismissed: Bool = false
    @State private var connecting: Bool = false
    @State private var connectError: String?
    @State private var showGatewayProblemDetails: Bool = false

    init(onUseManualSetup: @escaping () -> Void = {}) {
        self.onUseManualSetup = onUseManualSetup
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    GatewayQuickSetupHeader(hasCandidate: self.bestCandidate != nil)

                    if let gatewayProblem = self.appModel.lastGatewayProblem {
                        GatewayProblemBanner(
                            problem: gatewayProblem,
                            primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                            onPrimaryAction: {
                                Task { await self.handleGatewayProblemPrimaryAction(gatewayProblem) }
                            },
                            onShowDetails: {
                                self.showGatewayProblemDetails = true
                            })
                    }

                    if let candidate = self.bestCandidate {
                        let availability = self.gatewayController.discoveredGatewayConnectionAvailability(candidate)
                        GatewayQuickSetupCandidatePanel(
                            name: candidate.name,
                            debugID: candidate.debugID,
                            tlsEnabled: candidate.tlsEnabled,
                            gatewayPort: candidate.gatewayPort,
                            discoveryStatusText: self.gatewayController.discoveryStatusText,
                            gatewayDisplayStatusText: self.appModel.gatewayDisplayStatusText,
                            nodeStatusText: self.appModel.nodeStatusText,
                            operatorStatusText: self.appModel.operatorStatusText)

                        if availability.canConnect {
                            Button {
                                self.connectError = nil
                                self.connecting = true
                                Task {
                                    let err = await self.gatewayController.connectWithDiagnostics(candidate)
                                    await MainActor.run {
                                        self.connecting = false
                                        self.connectError = err
                                    }
                                }
                            } label: {
                                Group {
                                    if self.connecting {
                                        HStack(spacing: 8) {
                                            ProgressView().progressViewStyle(.circular)
                                            Text("Connecting…")
                                                .font(OpenClawType.subheadSemiBold)
                                        }
                                    } else {
                                        Text("Connect to this Gateway")
                                            .font(OpenClawType.subheadSemiBold)
                                    }
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(OpenClawPrimaryActionButtonStyle())
                            .disabled(self.connecting)
                        } else if let guidanceText = availability.guidanceText {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "lock.shield.fill")
                                    .foregroundStyle(OpenClawBrand.warn)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(availability.actionTitle)
                                        .font(OpenClawType.subheadSemiBold)
                                    Text(guidanceText)
                                        .font(OpenClawType.caption)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .accessibilityElement(children: .combine)

                            Button {
                                self.onUseManualSetup()
                            } label: {
                                Text("Use Manual Setup")
                                    .font(OpenClawType.subheadSemiBold)
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(OpenClawSecondaryActionButtonStyle())
                        }

                        if let connectError {
                            GatewayQuickSetupErrorView(message: connectError)
                        }

                        Button {
                            self.dismiss()
                        } label: {
                            Text("Not now")
                                .font(OpenClawType.subheadSemiBold)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(OpenClawSecondaryActionButtonStyle())
                        .disabled(self.connecting)

                        self.fullRowToggle("Don't show this again", isOn: self.$quickSetupDismissed)
                            .padding(.top, 2)
                    } else {
                        GatewayQuickSetupEmptyState(
                            discoveryStatusText: self.gatewayController.discoveryStatusText)
                    }
                }
                .padding(20)
            }
            .background(OpenClawBrand.activationCanvasGradient)
            .navigationTitle("Quick Setup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.quickSetupDismissed = true
                        self.dismiss()
                    } label: {
                        Text("Close")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .buttonStyle(OpenClawCloseButtonStyle())
                }
            }
        }
        .sheet(isPresented: self.$showGatewayProblemDetails) {
            if let gatewayProblem = self.appModel.lastGatewayProblem {
                GatewayProblemDetailsSheet(
                    problem: gatewayProblem,
                    primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                    onPrimaryAction: {
                        Task { await self.handleGatewayProblemPrimaryAction(gatewayProblem) }
                    })
            }
        }
    }

    private var bestCandidate: GatewayDiscoveryModel.DiscoveredGateway? {
        self.gatewayController.preferredDiscoveredGateway()
    }

    private func fullRowToggle(_ title: LocalizedStringKey, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(title)
                .font(OpenClawType.subhead)
        }
        .contentShape(Rectangle())
        .overlay {
            Button {
                isOn.wrappedValue.toggle()
            } label: {
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        }
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String? {
        GatewayProblemPrimaryAction.title(for: problem, retryTitle: "Connect")
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) async {
        if problem.canTrustRotatedCertificate {
            _ = await self.gatewayController.trustRotatedGatewayCertificate(from: problem)
            return
        }
        if GatewayProblemPrimaryAction.handleProtocolMismatchIfNeeded(problem) {
            return
        }
        guard problem.retryable else { return }
        guard let candidate = self.bestCandidate else { return }
        let availability = self.gatewayController.discoveredGatewayConnectionAvailability(candidate)
        guard availability.canConnect else {
            self.connectError = availability.guidanceText
            return
        }
        self.connectError = nil
        self.connecting = true
        let err = await self.gatewayController.connectWithDiagnostics(candidate)
        self.connecting = false
        self.connectError = err
    }
}

private struct GatewayQuickSetupHeader: View {
    let hasCandidate: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                OpenClawActivationGlyph(size: 70, interactive: true)
                    .shadow(color: OpenClawBrand.activationGlow.opacity(0.18), radius: 10, x: 0, y: 5)

                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(OpenClawType.caption2SemiBold)
                    .foregroundStyle(OpenClawBrand.activationPrimaryActionText)
                    .frame(width: 28, height: 28)
                    .background {
                        Circle()
                            .fill(OpenClawBrand.activationPrimaryGradient)
                    }
                    .overlay {
                        Circle()
                            .stroke(OpenClawBrand.activationCanvas, lineWidth: 3)
                    }
                    .offset(x: 4, y: 4)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Connect a nearby Gateway")
                    .font(OpenClawType.title2SemiBold)
                Text(self.subtitle)
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var subtitle: LocalizedStringKey {
        if self.hasCandidate {
            return "OpenClaw found a gateway on this network. Review it, then pair this iPhone as a secure node."
        }
        return "OpenClaw is searching the local network and tailnet for a Gateway you can trust."
    }
}

private struct GatewayQuickSetupCandidatePanel: View {
    let name: String
    let debugID: String
    let tlsEnabled: Bool
    let gatewayPort: Int?
    let discoveryStatusText: String
    let gatewayDisplayStatusText: String
    let nodeStatusText: String
    let operatorStatusText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "network")
                    .font(OpenClawType.headline)
                    .foregroundStyle(OpenClawBrand.activationPrimaryActionText)
                    .frame(width: 36, height: 36)
                    .background {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(OpenClawBrand.activationPrimaryGradient)
                    }
                    .shadow(color: OpenClawBrand.activationGlow.opacity(0.18), radius: 6, x: 0, y: 3)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: self.name)
                            .font(OpenClawType.headline)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.middle)

                        GatewayQuickSetupChip(text: self.tlsEnabled ? "Secure" : "Local")
                    }

                    Text(verbatim: self.endpointSummary)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            GatewayQuickSetupHairlineDivider()

            VStack(spacing: 8) {
                GatewayQuickSetupStatusRow(title: "Discovery", value: self.discoveryStatusText)
                GatewayQuickSetupStatusRow(title: "Gateway", value: self.gatewayDisplayStatusText)
                GatewayQuickSetupStatusRow(title: "Node", value: self.nodeStatusText)
                GatewayQuickSetupStatusRow(title: "Operator", value: self.operatorStatusText)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .openClawCraftSurface(cornerRadius: 22)
        .accessibilityElement(children: .combine)
    }

    private var endpointSummary: String {
        let port = self.gatewayPort.map { ":\($0)" } ?? ""
        return "\(self.debugID)\(port)"
    }
}

private struct GatewayQuickSetupHairlineDivider: View {
    var body: some View {
        Rectangle()
            .fill(OpenClawBrand.activationNeutralDivider)
            .frame(height: 0.5)
            .frame(maxWidth: .infinity)
    }
}

private struct GatewayQuickSetupChip: View {
    let text: LocalizedStringKey

    var body: some View {
        Text(self.text)
            .font(OpenClawType.caption2SemiBold)
            .foregroundStyle(OpenClawBrand.activationPrimaryAction)
            .padding(.vertical, 4)
            .padding(.horizontal, 8)
            .background {
                Capsule(style: .continuous)
                    .fill(OpenClawBrand.activationGlow.opacity(0.10))
            }
            .overlay {
                Capsule(style: .continuous)
                    .stroke(OpenClawBrand.activationHairline, lineWidth: 0.6)
            }
    }
}

private struct GatewayQuickSetupStatusRow: View {
    let title: LocalizedStringKey
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(self.title)
                .font(OpenClawType.captionMedium)
                .foregroundStyle(.secondary)
                .frame(width: 70, alignment: .leading)
            Text(verbatim: self.value)
                .font(OpenClawType.footnote)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct GatewayQuickSetupErrorView: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(OpenClawBrand.warn)
                .padding(.top, 1)
            Text(self.message)
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(OpenClawBrand.activationInsetGradient)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(OpenClawBrand.activationHairline, lineWidth: 0.7)
        }
    }
}

private struct GatewayQuickSetupEmptyState: View {
    let discoveryStatusText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "magnifyingglass")
                .font(OpenClawType.title2SemiBold)
                .foregroundStyle(OpenClawBrand.activationPrimaryAction)
                .frame(width: 42, height: 42)
                .background {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(OpenClawBrand.activationInsetGradient)
                }

            VStack(alignment: .leading, spacing: 6) {
                Text("Looking for a Gateway")
                    .font(OpenClawType.headline)
                Text("Keep your iPhone on the same LAN or tailnet, then start the Gateway on your host machine.")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 6) {
                GatewayQuickSetupInstructionRow(text: "Run openclaw gateway --port 18789.")
                GatewayQuickSetupInstructionRow(text: "Check that Bonjour discovery is enabled.")
                GatewayQuickSetupInstructionRow(text: "Open Settings if you need a manual host.")
            }
            .padding(.top, 2)

            Text(verbatim: "Discovery: \(self.discoveryStatusText)")
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .openClawCraftSurface(cornerRadius: 22)
    }
}

private struct GatewayQuickSetupInstructionRow: View {
    let text: LocalizedStringKey

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "arrow.right.circle.fill")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
            Text(self.text)
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

#if DEBUG
#Preview("Quick setup gateway", traits: .fixedLayout(width: 393, height: 520)) {
    GatewayQuickSetupPreviewHost(hasGateway: true)
}

#Preview("Quick setup searching", traits: .fixedLayout(width: 393, height: 520)) {
    GatewayQuickSetupPreviewHost(hasGateway: false)
}

private struct GatewayQuickSetupPreviewHost: View {
    @State private var appModel: NodeAppModel
    @State private var gatewayController: GatewayConnectionController

    init(hasGateway: Bool) {
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        if hasGateway {
            controller._test_setGateways([.previewGateway])
            appModel.gatewayStatusText = "Ready to pair"
        }
        _appModel = State(initialValue: appModel)
        _gatewayController = State(initialValue: controller)
    }

    var body: some View {
        GatewayQuickSetupSheet()
            .environment(self.appModel)
            .environment(self.gatewayController)
            .openClawSheetChrome()
    }
}

extension GatewayDiscoveryModel.DiscoveredGateway {
    fileprivate static let previewGateway = GatewayDiscoveryModel.DiscoveredGateway(
        name: "Studio Gateway",
        endpoint: .hostPort(
            host: .name("openclaw.local", nil),
            port: 18789),
        stableID: "preview-gateway",
        debugID: "openclaw.local",
        lanHost: "openclaw.local",
        tailnetDns: nil,
        gatewayPort: 18789,
        canvasPort: 18789,
        tlsEnabled: true,
        tlsFingerprintSha256: "preview",
        cliPath: "/opt/homebrew/bin/openclaw")
}
#endif
