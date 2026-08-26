import Foundation
import Observation
import OpenClawKit
import SwiftUI

@MainActor
struct StatusMenuHeaderView: View {
    @Bindable private var state: AppState
    @Bindable private var pairingPrompter = NodePairingApprovalPrompter.shared
    @Bindable private var devicePairingPrompter = DevicePairingApprovalPrompter.shared
    @AppStorage(cameraEnabledKey, store: AppDefaults.standard) private var cameraEnabled = false
    @State private var browserEnabled = true

    private let isSleeping: Bool
    private let controlChannel = ControlChannel.shared
    private let healthStore = HealthStore.shared
    private let activityStore = WorkActivityStore.shared
    private let nodesStore = NodesStore.shared
    private let nodeChannelStatus = MacNodeChannelStatusStore.shared
    private let dashboardManager = DashboardManager.shared

    init(state: AppState, isSleeping: Bool = false) {
        self._state = Bindable(wrappedValue: state)
        self.isSleeping = isSleeping
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            self.statusHeading
            self.statusSummary
            self.pairingRows
            self.capabilityStrip
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .transaction { $0.animation = nil }
        .task(id: self.state.connectionMode) {
            await self.loadBrowserEnabled()
        }
        .task {
            await self.nodesStore.prepareLocalNodeIdentity()
        }
    }

    private var statusHeading: some View {
        HStack(alignment: .center, spacing: 8) {
            Circle()
                .fill(self.statusColor)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(self.statusTitle)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)

                if let connectionModeLabel = self.connectionModeLabel {
                    Text(connectionModeLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 4)

            Toggle(String(localized: "OpenClaw active"), isOn: Binding(
                get: { !self.state.isPaused },
                set: { self.state.isPaused = !$0 }))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .disabled(self.state.connectionMode == .unconfigured)
                .accessibilityLabel(String(localized: "OpenClaw active"))
        }
    }

    @ViewBuilder
    private var statusSummary: some View {
        // Unconfigured installs already carry the sessions-section explainer;
        // a red "Gateway error" line here would shout at a fresh install.
        if self.state.connectionMode != .unconfigured {
            self.configuredStatusSummary
        }
    }

    private var configuredStatusSummary: some View {
        VStack(alignment: .leading, spacing: 4) {
            let health = self.healthStatus
            let endpoint = self.endpointHost
            let summary = endpoint.map { "\($0) · \(health.label)" } ?? health.label
            self.statusLine(label: summary, color: health.color)

            if let macNodeStatus = self.macNodeStatus {
                self.statusLine(label: macNodeStatus.label, color: macNodeStatus.color)
            }
        }
    }

    @ViewBuilder
    private var pairingRows: some View {
        if self.pairingPrompter.pendingCount > 0 {
            self.pairingRow(
                String(localized: "Pairing approval pending") + " (\(self.pairingPrompter.pendingCount))")
        }
        if self.devicePairingPrompter.pendingCount > 0 {
            let repairCount = self.devicePairingPrompter.pendingRepairCount
            let repairs = repairCount > 0
                ? " · \(repairCount) " + String(localized: "repair")
                : ""
            self.pairingRow(
                String(localized: "Device pairing pending")
                    + " (\(self.devicePairingPrompter.pendingCount))" + repairs)
        }
    }

    private var capabilityStrip: some View {
        HStack(spacing: 6) {
            self.capabilityButton(
                title: String(localized: "Browser"),
                symbol: "globe",
                enabled: self.browserEnabled)
            {
                let enabled = !self.browserEnabled
                self.browserEnabled = enabled
                Task { await self.saveBrowserEnabled(enabled) }
            }

            self.capabilityButton(
                title: String(localized: "Camera"),
                symbol: "camera",
                enabled: self.cameraEnabled)
            {
                self.cameraEnabled.toggle()
            }

            self.capabilityButton(
                title: String(localized: "Canvas"),
                symbol: "rectangle.and.pencil.and.ellipsis",
                enabled: self.state.canvasEnabled)
            {
                self.state.canvasEnabled.toggle()
                if !self.state.canvasEnabled {
                    CanvasManager.shared.hideAll()
                }
            }

            if voiceWakeSupported {
                self.capabilityButton(
                    title: String(localized: "Voice Wake"),
                    symbol: "mic.fill",
                    enabled: self.state.swabbleEnabled)
                {
                    let binding = MicRefreshSupport.voiceWakeBinding(for: self.state)
                    binding.wrappedValue.toggle()
                }
            }
        }
    }

    private func capabilityButton(
        title: String,
        symbol: String,
        enabled: Bool,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .medium))
                Text(title)
                    .font(.system(size: 9, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(enabled ? Color.accentColor : Color.secondary)
            .frame(maxWidth: .infinity, minHeight: 39)
            .background(
                enabled ? Color.accentColor.opacity(0.13) : Color.secondary.opacity(0.07),
                in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(enabled ? String(localized: "On") : String(localized: "Off"))
    }

    private var statusTitle: String {
        if self.state.connectionMode == .unconfigured {
            return String(localized: "OpenClaw Not Configured")
        }
        if self.state.isPaused {
            return String(localized: "OpenClaw Paused")
        }
        if self.isSleeping {
            return String(localized: "OpenClaw Sleeping")
        }
        return DashboardGatewayMenuModel.connectionLabel(
            mode: self.state.connectionMode,
            controlState: self.controlChannel.state,
            entries: self.dashboardManager.gatewayEntries)
    }

    private var connectionModeLabel: String? {
        switch self.state.connectionMode {
        case .unconfigured:
            nil
        case .local:
            String(localized: "local")
        case .remote:
            String(localized: "remote")
        }
    }

    private var statusColor: Color {
        if self.state.isPaused { return .orange }
        if self.isSleeping || self.state.connectionMode == .unconfigured { return .secondary }
        return self.healthStatus.color
    }

    private var endpointHost: String? {
        if let resolved = GatewayConnectivityCoordinator.shared.resolvedHostLabel?.nonEmpty {
            return resolved
        }
        switch self.state.connectionMode {
        case .unconfigured:
            return nil
        case .local:
            return "127.0.0.1:\(GatewayEnvironment.gatewayPort())"
        case .remote:
            if self.state.remoteTransport == .direct,
               let endpoint = URL(string: self.state.remoteUrl),
               let host = endpoint.host
            {
                return endpoint.port.map { "\(host):\($0)" } ?? host
            }
            if let target = CommandResolver.parseSSHTarget(self.state.remoteTarget) {
                return target.port == 22 ? target.host : "\(target.host):\(target.port)"
            }
            return self.state.remoteUrl.nonEmpty ?? self.state.remoteTarget.nonEmpty
        }
    }

    private var healthStatus: (label: String, color: Color) {
        if self.state.connectionMode == .local,
           let failure = GatewayProcessManager.shared.lastFailureReason
        {
            return (failure, .red)
        }
        if self.state.connectionMode == .remote {
            let presentation = GatewayConnectionPresentation(state: self.controlChannel.state)
            switch presentation.tone {
            case .healthy:
                break
            case .transient:
                return (presentation.generalSubtitle, .orange)
            case .attention:
                return (presentation.generalSubtitle, .red)
            }
        }

        if let activity = self.activityStore.current {
            let role = activity.role == .main ? String(localized: "Main") : String(localized: "Other")
            return ("\(role) · \(activity.label)", activity.role == .main ? .accentColor : .gray)
        }

        let health = self.healthStore.state
        if self.healthStore.isRefreshing {
            return (String(localized: "Health check running…"), health.tint)
        }
        let checkAge = self.healthStore.lastSuccess.map {
            " · " + String(localized: "checked") + " " + age(from: $0)
        } ?? ""
        switch health {
        case .ok:
            return (String(localized: "Health ok") + checkAge, .green)
        case .linkingNeeded:
            return (String(localized: "Health: login required"), .red)
        case let .degraded(reason):
            return ((self.healthStore.degradedSummary ?? reason) + checkAge, .orange)
        case .unknown:
            return (String(localized: "Health pending"), .secondary)
        }
    }

    private var macNodeStatus: (label: String, color: Color)? {
        guard self.state.connectionMode != .unconfigured,
              case .connected = self.controlChannel.state
        else { return nil }

        // The coordinator records why the node channel is down at the connect
        // boundary; prefer that recorded fact over inferring from node listings.
        if let line = self.nodeChannelStatus.state.operatorStatusLine {
            return (line.label, line.isDegraded ? .orange : .red)
        }

        let deviceID: String
        switch self.nodesStore.localNodeIdentityState {
        case .loading:
            return nil
        case let .available(id):
            deviceID = id
        case .unavailable:
            return (String(localized: "Mac identity unavailable"), .red)
        }

        if let node = self.nodesStore.nodes.first(where: { $0.nodeId == deviceID }) {
            guard node.isConnected else {
                return (String(localized: "Mac capabilities offline"), .orange)
            }
            let commands = Set(node.commands ?? [])
            let requiredCommands = [
                OpenClawSystemCommand.notify.rawValue,
                OpenClawSystemCommand.run.rawValue,
                OpenClawSystemCommand.which.rawValue,
            ]
            guard requiredCommands.allSatisfy(commands.contains) else {
                return (String(localized: "Mac capabilities incomplete"), .orange)
            }
            return nil
        }

        guard !self.nodesStore.isLoading, !self.nodesStore.nodes.isEmpty else { return nil }
        return (String(localized: "Mac capabilities offline"), .orange)
    }

    private func statusLine(label: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func pairingRow(_ label: String) -> some View {
        Button {
            PairingApprovalCenter.shared.showPanel()
        } label: {
            self.statusLine(label: label, color: .orange)
        }
        .buttonStyle(.plain)
        .help(String(localized: "Show pairing requests"))
    }

    private func loadBrowserEnabled() async {
        let config = await ConfigStore.load()
        let browser = config["browser"] as? [String: Any]
        self.browserEnabled = browser?["enabled"] as? Bool ?? true
    }

    private func saveBrowserEnabled(_ enabled: Bool) async {
        var config = await ConfigStore.load()
        var browser = config["browser"] as? [String: Any] ?? [:]
        browser["enabled"] = enabled
        config["browser"] = browser
        do {
            try await ConfigStore.save(config)
        } catch {
            await self.loadBrowserEnabled()
        }
    }
}
