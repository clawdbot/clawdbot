import OpenClawKit
import SwiftUI

struct GatewayQuickSetupSheet: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.dismiss) private var dismiss

    @AppStorage("onboarding.quickSetupDismissed") private var quickSetupDismissed: Bool = false
    @State private var connecting: Bool = false
    @State private var connectError: String?
    @State private var showGatewayProblemDetails: Bool = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Connect to a Gateway?")
                    .font(.title2.bold())

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
                    VStack(alignment: .leading, spacing: 6) {
                        Text(verbatim: candidate.name)
                            .font(.headline)
                        Text(verbatim: candidate.debugID)
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        VStack(alignment: .leading, spacing: 2) {
                            // Use verbatim strings so Bonjour-provided values can't be interpreted as
                            // localized format strings (which can crash with Objective-C exceptions).
                            Text(verbatim: "Discovery: \(self.gatewayController.discoveryStatusText)")
                            Text(verbatim: "Status: \(self.appModel.gatewayDisplayStatusText)")
                            Text(verbatim: "Node: \(self.appModel.nodeStatusText)")
                            Text(verbatim: "Operator: \(self.appModel.operatorStatusText)")
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 14))

                    Button {
                        self.connectError = nil
                        self.connecting = true
                        Task {
                            let err = await self.gatewayController.connectWithDiagnostics(candidate)
                            await MainActor.run {
                                self.connecting = false
                                self.connectError = err
                                // If we kicked off a connect, leave the sheet up so the user can see status evolve.
                            }
                        }
                    } label: {
                        Group {
                            if self.connecting {
                                HStack(spacing: 8) {
                                    ProgressView().progressViewStyle(.circular)
                                    Text("Connecting…")
                                }
                            } else {
                                Text("Connect")
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.connecting)

                    if let connectError {
                        Text(connectError)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }

                    Button {
                        self.dismiss()
                    } label: {
                        Text("Not now")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.connecting)

                    Toggle("Don’t show this again", isOn: self.$quickSetupDismissed)
                        .padding(.top, 4)
                } else {
                    Text("No gateways found yet. Make sure your gateway is running and Bonjour discovery is enabled.")
                        .foregroundStyle(.secondary)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Quick Setup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.quickSetupDismissed = true
                        self.dismiss()
                    } label: {
                        Text("Close")
                    }
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
        // Prefer whatever discovery says is first; the list is already name-sorted.
        self.gatewayController.gateways.first
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String {
        problem.canTrustRotatedCertificate ? "Trust certificate" : "Connect"
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) async {
        if problem.canTrustRotatedCertificate {
            _ = await self.gatewayController.trustRotatedGatewayCertificate(from: problem)
            return
        }
        guard let candidate = self.bestCandidate else { return }
        self.connectError = nil
        self.connecting = true
        let err = await self.gatewayController.connectWithDiagnostics(candidate)
        self.connecting = false
        self.connectError = err
    }
}
