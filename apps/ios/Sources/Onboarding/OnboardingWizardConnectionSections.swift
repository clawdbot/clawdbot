import OpenClawKit
import SwiftUI

struct OnboardingModeSelectionSections: View {
    let selectedMode: OnboardingConnectionMode?
    let developerModeEnabled: Binding<Bool>
    let isConnecting: Bool
    let onSelectMode: (OnboardingConnectionMode) -> Void
    let onContinue: () -> Void

    var body: some View {
        Section {
            OnboardingModeRow(
                title: "Home Network",
                subtitle: "LAN or Tailscale host",
                symbol: "house.and.flag",
                selected: self.selectedMode == .homeNetwork)
            {
                self.onSelectMode(.homeNetwork)
            }

            OnboardingModeRow(
                title: "Remote Domain",
                subtitle: "VPS with domain",
                symbol: "globe",
                selected: self.selectedMode == .remoteDomain)
            {
                self.onSelectMode(.remoteDomain)
            }

            if self.developerModeEnabled.wrappedValue {
                self.developerModeToggleRow

                OnboardingModeRow(
                    title: "Same Machine (Dev)",
                    subtitle: "For local iOS app development",
                    symbol: "wrench.and.screwdriver",
                    selected: self.selectedMode == .developerLocal)
                {
                    self.onSelectMode(.developerLocal)
                }
            }
        } header: {
            Text("Manual Connection")
                .font(OpenClawType.footnoteSemiBold)
                .padding(.top, 12)
        }
        .disabled(self.isConnecting)

        Section {
            Button(action: self.onContinue) {
                Text("Continue")
                    .font(OpenClawType.subheadSemiBold)
            }
            .disabled(self.selectedMode == nil || self.isConnecting)
            .buttonStyle(OpenClawPrimaryActionButtonStyle(height: 48))
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
    }

    private var developerModeToggleRow: some View {
        self.onboardingButtonToggle(
            "Developer mode",
            symbol: "wrench.and.screwdriver",
            isOn: self.developerModeEnabled)
    }

    private func onboardingButtonToggle(
        _ title: LocalizedStringKey,
        symbol: String? = nil,
        isOn: Binding<Bool>) -> some View
    {
        Toggle(isOn: isOn) {
            HStack(spacing: 12) {
                if let symbol {
                    OnboardingModeIcon(symbol: symbol, selected: false)
                }

                Text(title)
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(.primary)
            }
            .frame(minHeight: 52)
        }
        .tint(OpenClawBrand.activationPrimaryAction)
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
}

struct OnboardingConnectPhaseView: View {
    let phase: OnboardingConnectPhase
    let primaryActionTitle: (GatewayConnectionProblem) -> String?
    let onHandleProblem: (GatewayConnectionProblem) -> Void
    let onRetry: () -> Void
    let onShowDetails: () -> Void

    var body: some View {
        switch self.phase {
        case let .connecting(detail):
            HStack(spacing: 10) {
                ProgressView()
                    .progressViewStyle(.circular)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connecting…")
                        .font(OpenClawType.subheadSemiBold)
                    Text(verbatim: detail)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        case let .failed(problem):
            let actionTitle = self.primaryActionTitle(problem)
            GatewayProblemBanner(
                problem: problem,
                primaryActionTitle: actionTitle ?? (problem.retryable ? String(localized: "Retry") : nil),
                onPrimaryAction: {
                    if actionTitle != nil {
                        self.onHandleProblem(problem)
                    } else {
                        self.onRetry()
                    }
                },
                onShowDetails: self.onShowDetails)
        case let .failedStatus(message, allowsRetry):
            OpenClawNoticeBanner(
                icon: "exclamationmark.triangle.fill",
                title: "Connection Failed",
                message: .verbatim(message),
                ownerLabel: "Needs attention",
                tint: OpenClawBrand.danger,
                primaryActionTitle: allowsRetry ? OpenClawTextValue.localized("Retry") : nil,
                onPrimaryAction: allowsRetry ? self.onRetry : nil)
        case .ready:
            OpenClawStatusBadge(label: "Ready to Connect", tone: .muted)
        }
    }
}

struct OnboardingStagedGatewaySetupSection: View {
    let link: GatewayConnectDeepLink
    let isConnecting: Bool
    let isBusy: Bool
    let onConnect: () -> Void
    let onUseManualSetup: () -> Void

    var body: some View {
        Section {
            self.onboardingLabeledContent("Host", value: self.link.host)
            self.onboardingLabeledContent("Port", value: String(self.link.port))
            self.onboardingLabeledContent(
                "Security",
                value: self.link.tls ? "TLS" : "Plaintext (local network)")

            Button(action: self.onConnect) {
                if self.isConnecting {
                    HStack(spacing: 8) {
                        ProgressView()
                            .progressViewStyle(.circular)
                        Text("Connecting…")
                            .font(OpenClawType.subheadSemiBold)
                    }
                } else {
                    Text("Connect")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
            .font(OpenClawType.subheadSemiBold)
            .disabled(self.isBusy)

            Button(action: self.onUseManualSetup) {
                Text("Use Manual Setup")
                    .font(OpenClawType.subheadSemiBold)
            }
            .font(OpenClawType.subheadSemiBold)
            .disabled(self.isBusy)
        } header: {
            Text("Setup Link")
                .font(OpenClawType.footnoteSemiBold)
        } footer: {
            Text(self.link.tls
                ? "Review this endpoint. Credentials are applied only after you tap Connect."
                :
                "Plaintext may expose credentials. Continue only if you trust this local network and host.")
                .font(OpenClawType.footnote)
        }
    }

    private func onboardingLabeledContent(_ title: LocalizedStringKey, value: String) -> some View {
        LabeledContent {
            Text(verbatim: value)
                .font(OpenClawType.body)
        } label: {
            Text(title)
                .font(OpenClawType.body)
        }
    }
}

struct OnboardingDiscoveredGatewaysSection: View {
    let gateways: [GatewayDiscoveryModel.DiscoveredGateway]
    let gatewayController: GatewayConnectionController
    let connectingGateway: OnboardingGatewayConnectionAttempt?
    let onConnect: (GatewayDiscoveryModel.DiscoveredGateway) -> Void
    let onRestartDiscovery: () -> Void

    var body: some View {
        Section {
            if self.gateways.isEmpty {
                Text("No gateways found yet.")
                    .font(OpenClawType.body)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.gateways) { gateway in
                    let availability = self.gatewayController.discoveredGatewayConnectionAvailability(gateway)

                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(gateway.name)
                                    .font(OpenClawType.body)
                                if let host = gateway.lanHost ?? gateway.tailnetDns {
                                    Text(host)
                                        .font(OpenClawType.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if availability.canConnect {
                                Button {
                                    self.onConnect(gateway)
                                } label: {
                                    if self.connectingGateway == .gateway(gateway.id) {
                                        ProgressView()
                                            .progressViewStyle(.circular)
                                    } else {
                                        Text(availability.actionTitle)
                                            .font(OpenClawType.subheadSemiBold)
                                    }
                                }
                                .font(OpenClawType.subheadSemiBold)
                                .disabled(self.connectingGateway != nil)
                            } else {
                                Text(availability.actionTitle)
                                    .font(OpenClawType.subheadSemiBold)
                                    .foregroundStyle(OpenClawBrand.warn)
                            }
                        }

                        if let guidanceText = availability.guidanceText {
                            Text(guidanceText)
                                .font(OpenClawType.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }

            Button(action: self.onRestartDiscovery) {
                Text("Restart Discovery")
                    .font(OpenClawType.subheadSemiBold)
            }
            .font(OpenClawType.subheadSemiBold)
            .disabled(self.connectingGateway != nil)
        } header: {
            Text("Discovered Gateways")
                .font(OpenClawType.footnoteSemiBold)
        }
    }
}
