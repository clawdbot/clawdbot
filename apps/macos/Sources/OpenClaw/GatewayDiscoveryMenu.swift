import OpenClawDiscovery
import SwiftUI

/// Discovery rows for the Connection form; the owning section supplies header and status footer.
struct GatewayDiscoveryInlineList: View {
    var discovery: GatewayDiscoveryModel
    var currentTarget: String?
    var currentUrl: String?
    var transport: AppState.RemoteTransport
    var onSelect: (GatewayDiscoveryModel.DiscoveredGateway) -> Void

    var body: some View {
        if self.discovery.gateways.isEmpty {
            Text("No gateways found yet.")
                .foregroundStyle(.secondary)
        } else {
            ForEach(self.discovery.gateways.prefix(6)) { gateway in
                let display = self.displayInfo(for: gateway)

                Button {
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                        self.onSelect(gateway)
                    }
                } label: {
                    HStack(alignment: .center, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(gateway.displayName)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Text(display.label)
                                .font(.callout.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: 0)
                        SelectionStateIndicator(selected: display.selected)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(self.transport == .direct
                    ? "Click a discovered gateway to fill the gateway URL."
                    : "Click a discovered gateway to fill the SSH target.")
            }
        }
    }

    private func displayInfo(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> (label: String, selected: Bool)
    {
        switch self.transport {
        case .direct:
            let url = GatewayDiscoveryHelpers.directUrl(for: gateway)
            let label = url ?? "Gateway pairing only"
            let selected = url != nil && self.trimmed(self.currentUrl) == url
            return (label, selected)
        case .ssh:
            let target = GatewayDiscoveryHelpers.sshTarget(for: gateway)
            let label = target ?? "Gateway pairing only"
            let selected = target != nil && self.trimmed(self.currentTarget) == target
            return (label, selected)
        }
    }

    private func trimmed(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}
