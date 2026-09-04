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

    /// A healthy system stays silent: lines appear only for states the
    /// operator can act on, so the header is stable while nothing is wrong.
    @ViewBuilder
    private var statusSummary: some View {
        let problems = self.problemLines
        if !problems.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(problems, id: \.label) { problem in
                    self.statusLine(label: problem.label, diagnostic: problem.diagnostic, color: problem.color)
                }
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
        if self.dashboardManager.gatewayEntries.count >= 2,
           let primaryName = self.dashboardManager.gatewayEntries.first(where: \.isPrimary)?.name.nonEmpty
        {
            return primaryName
        }
        return "OpenClaw"
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

    /// Operator-actionable trouble only. Healthy, refreshing, pending, and
    /// activity states intentionally produce nothing - the menu stays quiet
    /// and stable instead of narrating routine churn.
    private var problemLines: [(label: String, diagnostic: String?, color: Color)] {
        guard self.state.connectionMode != .unconfigured else { return [] }
        var lines: [(label: String, diagnostic: String?, color: Color)] = []

        if self.state.connectionMode == .local,
           let failure = GatewayProcessManager.shared.lastFailureReason
        {
            lines.append((failure, nil, .red))
        }
        if self.state.connectionMode == .remote {
            let presentation = GatewayConnectionPresentation(state: self.controlChannel.state)
            switch presentation.tone {
            case .healthy:
                break
            case .transient:
                lines.append((presentation.generalSubtitle, nil, .orange))
            case .attention:
                lines.append((presentation.generalSubtitle, nil, .red))
            }
        }

        switch self.healthStore.state {
        case .ok, .unknown:
            break
        case .linkingNeeded:
            lines.append((String(localized: "Login required"), nil, .red))
        case let .degraded(reason):
            lines.append((self.healthStore.degradedSummary ?? reason, nil, .orange))
        }

        if let macNodeStatus = self.macNodeStatus {
            lines.append(macNodeStatus)
        }
        return lines
    }

    private var macNodeStatus: (label: String, diagnostic: String?, color: Color)? {
        guard self.state.connectionMode != .unconfigured,
              case .connected = self.controlChannel.state
        else { return nil }

        // The coordinator records why the node channel is down at the connect
        // boundary; prefer that recorded fact over inferring from node listings.
        if let line = self.nodeChannelStatus.state.operatorStatusLine {
            return (line.label, line.diagnostic, line.isDegraded ? .orange : .red)
        }

        let deviceID: String
        switch self.nodesStore.localNodeIdentityState {
        case .loading:
            return nil
        case let .available(id):
            deviceID = id
        case .unavailable:
            return (String(localized: "Mac identity unavailable"), nil, .red)
        }

        if let node = self.nodesStore.nodes.first(where: { $0.nodeId == deviceID }) {
            guard node.isConnected else {
                return (String(localized: "Mac capabilities offline"), nil, .orange)
            }
            let commands = Set(node.commands ?? [])
            let requiredCommands = [
                OpenClawSystemCommand.notify.rawValue,
                OpenClawSystemCommand.run.rawValue,
                OpenClawSystemCommand.which.rawValue,
            ]
            guard requiredCommands.allSatisfy(commands.contains) else {
                return (String(localized: "Mac capabilities incomplete"), nil, .orange)
            }
            return nil
        }

        guard !self.nodesStore.isLoading, !self.nodesStore.nodes.isEmpty else { return nil }
        return (String(localized: "Mac capabilities offline"), nil, .orange)
    }

    private func statusLine(label: String, diagnostic: String? = nil, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(color)
                .lineLimit(diagnostic == nil ? 3 : 2)

            if let diagnostic {
                Text(diagnostic)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                    .textSelection(.enabled)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .help(diagnostic.map { "\(label)\n\($0)" } ?? label)
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
        guard config.isCurrent else { return }
        let browser = config.root["browser"] as? [String: Any]
        self.browserEnabled = browser?["enabled"] as? Bool ?? true
    }

    private func saveBrowserEnabled(_ enabled: Bool) async {
        var config = await ConfigStore.load()
        var browser = config.root["browser"] as? [String: Any] ?? [:]
        browser["enabled"] = enabled
        config.root["browser"] = browser
        do {
            try await ConfigStore.save(config)
        } catch {
            await self.loadBrowserEnabled()
        }
    }
}
