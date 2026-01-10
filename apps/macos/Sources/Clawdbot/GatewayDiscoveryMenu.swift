import ClawdbotDiscovery
import SwiftUI

struct GatewayDiscoveryInlineList: View {
    var discovery: GatewayDiscoveryModel
    var currentTarget: String?
    var onSelect: (GatewayDiscoveryModel.DiscoveredGateway) -> Void
    @State private var hoveredGatewayID: GatewayDiscoveryModel.DiscoveredGateway.ID?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(self.discovery.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if self.discovery.gateways.isEmpty {
                Text("No bridges found yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(self.discovery.gateways.prefix(6)) { gateway in
                        let target = self.suggestedSSHTarget(gateway)
                        let selected = (target != nil && self.currentTarget?
                            .trimmingCharacters(in: .whitespacesAndNewlines) == target)

                        Button {
                            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                                self.onSelect(gateway)
                            }
                        } label: {
                            HStack(alignment: .center, spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(gateway.displayName)
                                        .font(.callout.weight(.semibold))
                                        .lineLimit(1)
                                        .truncationMode(.tail)
                                    Text(target ?? "Bridge pairing only")
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer(minLength: 0)
                                if selected {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(Color.accentColor)
                                } else {
                                    Image(systemName: "arrow.right.circle")
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(self.rowBackground(
                                        selected: selected,
                                        hovered: self.hoveredGatewayID == gateway.id)))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(
                                        selected ? Color.accentColor.opacity(0.45) : Color.clear,
                                        lineWidth: 1))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .onHover { hovering in
                            self.hoveredGatewayID = hovering ? gateway
                                .id : (self.hoveredGatewayID == gateway.id ? nil : self.hoveredGatewayID)
                        }
                    }
                }
                .padding(10)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color(NSColor.controlBackgroundColor)))
            }
        }
        .help("Click a discovered bridge to fill the SSH target.")
    }

    private func suggestedSSHTarget(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        let host = self.sanitizedTailnetHost(gateway.tailnetDns) ?? gateway.lanHost
        guard let host else { return nil }
        let user = NSUserName()
        return GatewayDiscoveryModel.buildSSHTarget(
            user: user,
            host: host,
            port: gateway.sshPort)
    }

    private func sanitizedTailnetHost(_ host: String?) -> String? {
        guard let host else { return nil }
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if trimmed.hasSuffix(".internal.") || trimmed.hasSuffix(".internal") {
            return nil
        }
        return trimmed
    }

    private func rowBackground(selected: Bool, hovered: Bool) -> Color {
        if selected { return Color.accentColor.opacity(0.12) }
        if hovered { return Color.secondary.opacity(0.08) }
        return Color.clear
    }
}

struct GatewayDiscoveryMenu: View {
    var discovery: GatewayDiscoveryModel
    var onSelect: (GatewayDiscoveryModel.DiscoveredGateway) -> Void

    var body: some View {
        Menu {
            if self.discovery.gateways.isEmpty {
                Button(self.discovery.statusText) {}
                    .disabled(true)
            } else {
                ForEach(self.discovery.gateways) { gateway in
                    Button(gateway.displayName) { self.onSelect(gateway) }
                }
            }
        } label: {
            Image(systemName: "dot.radiowaves.left.and.right")
        }
        .help("Discover Clawdbot bridges on your LAN")
    }
}
