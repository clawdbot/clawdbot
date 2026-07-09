import Darwin
import OpenClawKit
import SwiftUI
import UserNotifications

enum SettingsRoute: Hashable {
    case gateway
    case approvals
    case permissions
    case channels
    case voice
    case diagnostics
    case privacy
    case notifications
    case licenses
    case about
}

enum SettingsLayout {
    static let cardRadius: CGFloat = OpenClawProMetric.cardRadius
    static let rowHeight: CGFloat = 58
}

/// Canonical label/value list row for Settings and Talk surfaces. Keep every
/// detail row on this view so row typography cannot drift between sections;
/// plain `LabeledContent(String, value:)` renders unbranded system fonts.
struct SettingsDetailRow: View {
    let label: String
    let value: String

    init(_ label: String, value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        LabeledContent {
            Text(self.value)
                .font(OpenClawType.subhead)
                .lineLimit(1)
                .truncationMode(.middle)
        } label: {
            Text(self.label)
                .font(OpenClawType.body)
        }
    }
}

struct SettingsApprovalItem: Identifiable {
    let id: String
    let icon: String
    let title: String
    let detail: String
    let priority: String
    let color: Color
}

struct SettingsApprovalRow: View {
    let item: SettingsApprovalItem

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: self.item.icon)
                .font(OpenClawType.captionBold)
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(self.item.color)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(self.item.title)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Text(self.item.detail)
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(self.item.priority)
                .font(OpenClawType.captionBold)
                .foregroundStyle(self.item.color)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background {
                    Capsule()
                        .fill(self.item.color.opacity(0.10))
                }
        }
        .padding(.vertical, 7)
    }
}

enum SettingsNotificationStatus: Equatable {
    case checking
    case allowed
    case notAllowed
    case notSet
    case unknown

    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional, .ephemeral:
            self = .allowed
        case .denied:
            self = .notAllowed
        case .notDetermined:
            self = .notSet
        @unknown default:
            self = .unknown
        }
    }

    var allowsNotifications: Bool {
        self == .allowed
    }
}

enum SettingsNotificationPresentation: Equatable {
    case checking
    case enabled
    case off
    case setup
    case denied
    case notSet
    case unknown

    var text: String {
        switch self {
        case .checking: "Checking"
        case .enabled: "Enabled"
        case .off: "Off"
        case .setup: "Setup"
        case .denied: "Denied"
        case .notSet: "Not Enabled"
        case .unknown: "Unknown"
        }
    }

    var detail: String {
        switch self {
        case .checking:
            "Checking iOS notification permission."
        case .enabled:
            "OpenClaw can show approval prompts and event alerts when the app is not active."
        case .off:
            "OpenClaw notifications are off."
        case .setup:
            "Finish notification setup to receive alerts when the app is not active."
        case .denied:
            "Notifications have been denied. Enable them in iOS Settings."
        case .notSet:
            "Enable notifications to receive approval prompts and event alerts outside the app."
        case .unknown:
            "OpenClaw cannot determine the current notification permission state."
        }
    }

    var color: Color {
        switch self {
        case .enabled:
            OpenClawBrand.ok
        case .denied, .setup, .unknown:
            OpenClawBrand.warn
        case .checking, .notSet, .off:
            .secondary
        }
    }

    var isActive: Bool {
        self == .enabled
    }

    var needsAttention: Bool {
        self != .checking && self != .enabled
    }
}

enum SettingsDiagnosticIssue: String, Equatable, CaseIterable {
    case gatewayOffline
    case discoveryUnavailable
    case talkConfigMissing
    case notificationsUnavailable
}

enum SettingsDiagnostics {
    static func issues(
        gatewayConnected: Bool,
        discoveredGatewayCount: Int,
        talkConfigLoaded: Bool,
        notificationsAllowed: Bool) -> [SettingsDiagnosticIssue]
    {
        var issues: [SettingsDiagnosticIssue] = []
        if !gatewayConnected { issues.append(.gatewayOffline) }
        if discoveredGatewayCount == 0 { issues.append(.discoveryUnavailable) }
        if gatewayConnected, !talkConfigLoaded { issues.append(.talkConfigMissing) }
        if !notificationsAllowed { issues.append(.notificationsUnavailable) }
        return issues
    }

    static func issueCount(
        gatewayConnected: Bool,
        discoveredGatewayCount: Int,
        talkConfigLoaded: Bool,
        notificationsAllowed: Bool) -> Int
    {
        self.issues(
            gatewayConnected: gatewayConnected,
            discoveredGatewayCount: discoveredGatewayCount,
            talkConfigLoaded: talkConfigLoaded,
            notificationsAllowed: notificationsAllowed).count
    }

    static func timestamp(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }
}

extension SettingsProTab {
    static func hasTailnetIPv4() -> Bool {
        var addrList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrList) == 0, let first = addrList else { return false }
        defer { freeifaddrs(addrList) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            let isUp = (flags & IFF_UP) != 0
            let isLoopback = (flags & IFF_LOOPBACK) != 0
            guard let addrPtr = ptr.pointee.ifa_addr else { continue }
            let family = addrPtr.pointee.sa_family
            if !isUp || isLoopback || family != UInt8(AF_INET) { continue }
            var addr = addrPtr.pointee
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                &addr,
                socklen_t(addrPtr.pointee.sa_len),
                &buffer,
                socklen_t(buffer.count),
                nil,
                0,
                NI_NUMERICHOST)
            guard result == 0 else { continue }
            let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
            guard let ip = String(bytes: bytes, encoding: .utf8) else { continue }
            if self.isTailnetIPv4(ip) { return true }
        }
        return false
    }

    static func isTailnetHostOrIP(_ host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.hasSuffix(".ts.net") || trimmed.hasSuffix(".ts.net.") { return true }
        return self.isTailnetIPv4(trimmed)
    }

    static func isTailnetIPv4(_ ip: String) -> Bool {
        let parts = ip.split(separator: ".")
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        let a = octets[0]
        let b = octets[1]
        guard (0...255).contains(a), (0...255).contains(b) else { return false }
        return a == 100 && b >= 64 && b <= 127
    }
}

#if DEBUG
#Preview("Gateway settings states") {
    SettingsGatewayStatesPreview()
}

private struct SettingsGatewayStatesPreview: View {
    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.stateSection("Connected") {
                        self.gatewayStatusCard(
                            title: "Gateway online",
                            detail: "Connected to openclaw-gateway.tailnet.ts.net.",
                            value: "online",
                            color: OpenClawBrand.ok)
                        self.gatewayFactsCard(
                            address: "100.88.41.20:18789",
                            server: "openclaw-gateway",
                            discovered: "3",
                            agent: "Aiden")
                    }

                    self.stateSection("Loading") {
                        self.gatewayStatusCard(
                            title: "Checking gateway",
                            detail: "Refreshing connection, discovery, and device trust state.",
                            value: "loading",
                            color: OpenClawBrand.accent)
                        self.gatewayActionsCard(isBusy: true)
                    }

                    self.stateSection("Empty") {
                        self.gatewayStatusCard(
                            title: "No gateway configured",
                            detail: "Scan a setup QR code, paste a setup code, or choose a discovered gateway.",
                            value: "setup",
                            color: .secondary)
                        self.setupActionsCard
                    }

                    self.stateSection("Error") {
                        self.gatewayStatusCard(
                            title: "Tailscale warning",
                            detail: "Tailscale is off on this device. Turn it on, then try again.",
                            value: "network",
                            color: OpenClawBrand.warn)
                    }
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.vertical, 18)
            }
        }
    }

    private func stateSection(
        _ title: String,
        @ViewBuilder content: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(.secondary)
            content()
        }
    }

    private func gatewayStatusCard(
        title: String,
        detail: String,
        value: String,
        color: Color) -> some View
    {
        ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
            ProStatusRow(
                icon: value == "online" ? "antenna.radiowaves.left.and.right" : "wifi.slash",
                title: title,
                detail: detail,
                value: value,
                color: color,
                actionTitle: value == "setup" ? "Scan QR" : nil,
                action: value == "setup" ? {} : nil)
        }
    }

    private func gatewayFactsCard(
        address: String,
        server: String,
        discovered: String,
        agent: String) -> some View
    {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(spacing: 0) {
                self.factRow("Address", value: address)
                Divider()
                self.factRow("Server", value: server)
                Divider()
                self.factRow("Discovered", value: discovered)
                Divider()
                self.factRow("Default Agent", value: agent)
            }
        }
    }

    private func factRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value)
                .font(OpenClawType.captionMedium)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(height: SettingsLayout.rowHeight)
    }

    private func gatewayActionsCard(isBusy: Bool) -> some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            HStack(spacing: 10) {
                self.previewButton("Reconnect", systemImage: "arrow.triangle.2.circlepath", isBusy: isBusy)
                self.previewButton("Diagnose", systemImage: "cross.case", isBusy: isBusy)
            }
        }
    }

    private var setupActionsCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    self.previewButton("Scan QR", systemImage: "qrcode.viewfinder", isBusy: false)
                    self.previewButton("Connect", systemImage: "link", isBusy: false)
                }
                Text("Discovered gateways and manual setup live here when the gateway has not connected yet.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func previewButton(
        _ title: String,
        systemImage: String,
        isBusy: Bool) -> some View
    {
        Button {} label: {
            Label(title, systemImage: systemImage)
                .font(OpenClawType.captionSemiBold)
                .frame(maxWidth: .infinity)
        }
        .font(OpenClawType.captionSemiBold)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(isBusy)
    }
}
#endif
