import OpenClawKit
import SwiftUI

/// iOS Settings-style icon: white glyph on a solid rounded-square, sized for a List row.
struct SettingsIcon: View {
    let systemName: String
    let color: Color

    var body: some View {
        Image(systemName: self.systemName)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(self.color))
    }
}

extension SettingsProTab {
    var offlineDeviceSection: some View {
        Section {
            self.settingsListRow(
                icon: "applewatch",
                iconColor: .green,
                title: "Apple Watch",
                route: .appleWatch)
                .accessibilityIdentifier("settings-watch-row")
            self.settingsListRow(
                icon: "stethoscope",
                iconColor: .teal,
                title: "Diagnostics",
                route: .diagnostics)
            self.settingsListRow(
                icon: "doc.text",
                iconColor: .gray,
                title: "Licenses",
                route: .licenses)
                .accessibilityIdentifier("settings-licenses-row")
            self.settingsListRow(
                icon: "info.circle.fill",
                iconColor: .gray,
                title: "About",
                route: .about)
        } header: {
            Text("Device")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
        }
    }

    func settingsListRow(
        icon: String,
        iconColor: Color,
        title: LocalizedStringKey,
        route: SettingsRoute) -> some View
    {
        NavigationLink(value: route) {
            Label {
                Text(title)
                    .font(OpenClawType.subheadSemiBold)
            } icon: {
                SettingsIcon(systemName: icon, color: iconColor)
            }
        }
    }

    func destination(for route: SettingsRoute) -> some View {
        List {
            switch route {
            case .gateway:
                self.gatewayDestination
            case .appleWatch:
                self.appleWatchDestination
            case .approvals:
                self.approvalsDestination
            case .diagnostics:
                self.diagnosticsDestination
            case .about:
                self.aboutDestination
            case .licenses:
                self.licensesDestination
            }
        }
        .font(OpenClawType.body)
        .navigationTitle(title(for: route))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: route) {
            guard route == .appleWatch else { return }
            await self.appModel.refreshWatchMessagingStatus()
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(title(for: route))
                    .font(OpenClawType.headline)
                    .foregroundStyle(.primary)
            }
            if route == .gateway {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.openGatewayQRScanner()
                    } label: {
                        Image(systemName: "qrcode.viewfinder")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .disabled(self.connectingGateway != nil)
                    .accessibilityLabel("Scan QR")
                }
            }
            if let headerSidebarAction {
                OpenClawSidebarToolbarItem(
                    action: headerSidebarAction,
                    placement: .topBarLeading)
            }
        }
    }

    /// Ordered by intent: connection state, then pairing (the first-run action),
    /// then facts/preferences; manual entry and credentials are plumbing at the end.
    var gatewayDestination: some View {
        Group {
            self.gatewayStatusCard

            Section {
                Button {
                    Task { await self.reconnectGateway() }
                } label: {
                    Label("Reconnect", systemImage: "arrow.triangle.2.circlepath")
                        .font(OpenClawType.body)
                }
                .disabled(self.isReconnectingGateway || self.appModel.isAppleReviewDemoModeEnabled)
                Button {
                    Task { await self.runDiagnostics() }
                } label: {
                    Label("Diagnose", systemImage: "cross.case")
                        .font(OpenClawType.body)
                }
                .disabled(self.isRefreshingGateway)
            } footer: {
                self.gatewayActionStatusView
            }

            self.gatewaySetupCard
            self.pairedGatewaysCard

            self.detailListCard {
                SettingsDetailRow("Address", value: .verbatim(self.gatewayAddress))
                SettingsDetailRow("Server", value: .verbatim(self.gatewayServer))
                SettingsDetailRow(
                    "Discovered",
                    value: .verbatim(self.gatewayController.gateways.count.formatted()))
                SettingsDetailRow(
                    "Default Agent",
                    value: .verbatim(self.appModel.activeAgentName))
                SettingsDetailRow(
                    "Agents",
                    value: .verbatim(self.appModel.gatewayAgents.count.formatted()))
                SettingsDetailRow(
                    "Access",
                    value: .verbatim(
                        self.appModel.isOperatorGatewayConnected
                            ? (self.appModel.hasOperatorAdminScope ? "Full" : "Limited")
                            : "Not available"))
            }

            if self.appModel.isOperatorGatewayConnected,
               !self.appModel.hasOperatorAdminScope
            {
                // Localization: expand this phone's permissions from limited to full/admin access.
                Section("Upgrade access") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("This phone has limited Gateway access.")
                            .font(OpenClawType.subheadSemiBold)
                        // Localization: this phone scans a code generated by either Control UI or openclaw qr.
                        Text(
                            "Use a secure wss:// or Tailscale Serve Gateway, then scan a full-access setup code from the Control UI or openclaw qr and reconnect to enable settings and upgrades.") // swiftlint:disable:this line_length
                            .font(OpenClawType.caption) // Keep the native localization key contiguous.
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button {
                        self.openGatewayQRScanner()
                    } label: {
                        Label("Scan Full-Access Code", systemImage: "qrcode.viewfinder")
                            .font(OpenClawType.body)
                    }
                }
            }

            self.agentSelectionCard
            self.deviceIdentityCard
            self.manualGatewayCard
            self.gatewayAdvancedCard
        }
        .font(OpenClawType.body)
    }

    private var gatewayStatusCard: some View {
        // Hero pairing action honors the same connect lock as the other scanner
        // entry points; an in-flight attempt must not race a second scan.
        let showScanHero = self.gatewayNeedsPairing && self.connectingGateway == nil
        // Unapplied `self.openGatewayQRScanner` in a ternary crashes the Swift 6
        // type checker ("failed to produce diagnostic"); build the optional closure imperatively.
        var scanAction: (() -> Void)?
        if showScanHero {
            scanAction = { self.openGatewayQRScanner() }
        }
        return self.detailStatusCard(
            icon: "antenna.radiowaves.left.and.right",
            title: "Gateway",
            detail: .verbatim(self.gatewayStatusDetail),
            value: .verbatim(self.gatewayStatusValue),
            color: self.gatewayStatusColor,
            actionTitle: showScanHero ? "Scan QR to Pair" : nil,
            actionSystemImage: "qrcode.viewfinder",
            action: scanAction)
    }

    var approvalsDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "checkmark.shield.fill",
                title: "Approvals",
                detail: .verbatim(self.notificationsNeedAttention
                    ? String(localized: "Out-of-app approval alerts need notification permission.")
                    : (self.pendingApprovalCount == 0
                        ? String(localized: "No gateway actions are waiting for review.")
                        : String(localized: "Review pending gateway actions."))),
                value: self.notificationsNeedAttention
                    ? .verbatim(String(localized: "Alerts Off"))
                    : (self.pendingApprovalCount == 0
                        ? .verbatim(String(localized: "clear"))
                        : .verbatim(self.approvalWaitingText)),
                color: self.notificationsNeedAttention ? OpenClawBrand.warn :
                    (self.pendingApprovalCount == 0 ? OpenClawBrand.ok : OpenClawBrand.warn))

            if self.notificationsNeedAttention {
                self.approvalNotificationsWarningCard
            }

            self.approvalsReviewCard
        }
    }

    var appleWatchDestination: some View {
        Group {
            let watchStatus = self.appModel.watchMessagingStatus
            self.detailStatusCard(
                icon: "applewatch",
                title: "Apple Watch",
                detail: .verbatim(watchStatus.appInstalled
                    ? String(
                        localized: "Relay remains available; direct mode adds an independent Gateway node.")
                    : String(
                        localized: "Install the OpenClaw watch app before enabling direct mode.")),
                value: .verbatim(
                    watchStatus.reachable
                        ? String(localized: "Reachable")
                        : (watchStatus.appInstalled
                            ? String(localized: "Installed")
                            : String(localized: "Unavailable"))),
                color: watchStatus.appInstalled ? OpenClawBrand.ok : OpenClawBrand.warn)

            Section {
                NavigationLink {
                    WatchMessageJournalView()
                } label: {
                    Label("Message Delivery", systemImage: "bubble.left.and.text.bubble.right")
                        .font(OpenClawType.body)
                }
            }

            Section {
                Button {
                    Task { await self.sendDirectWatchSetup() }
                } label: {
                    Label {
                        Text("Connect Apple Watch")
                            .font(OpenClawType.body)
                    } icon: {
                        Image(systemName: "applewatch")
                    }
                }
                .disabled(
                    self.isSendingWatchDirectSetup
                        || !self.appModel.isOperatorGatewayConnected
                        || !self.appModel.hasOperatorAdminScope
                        || !watchStatus.appInstalled)

                if let statusText = self.watchDirectSetupStatusText {
                    Text(statusText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } footer: {
                Text(
                    """
                    The watch receives a one-time pairing code and its own device credentials. \
                    Voice is included with read and Talk access, without admin access. \
                    The microphone starts only when you tap Start on the watch. \
                    A reachable secure Gateway URL is required away from the iPhone.
                    """)
                    .font(OpenClawType.footnote)
            }

            Section("Direct node features") {
                SettingsDetailRow("Device", value: "Info and status")
                SettingsDetailRow("Notifications", value: "While app is active")
            }
        }
    }

    var approvalNotificationsWarningCard: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("Notifications are off")
                    .font(OpenClawType.subheadSemiBold)
                Text("Enable Notifications to receive approval alerts while OpenClaw is not open.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                self.openNotificationsRouteFromApprovals()
            } label: {
                Label("Open Notifications", systemImage: "bell.badge")
                    .font(OpenClawType.body)
            }
        }
    }

    @ViewBuilder
    var approvalsReviewCard: some View {
        if !self.appModel.pendingExecApprovalInboxItems.isEmpty {
            Section("Pending approvals") {
                ForEach(self.appModel.pendingExecApprovalInboxItems) { item in
                    Button {
                        self.appModel.presentPendingExecApprovalFromInbox(item.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.prompt.commandPreview ?? item.prompt.commandText)
                                .font(OpenClawType.body)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Text(item.prompt.gatewayStableID)
                                .font(OpenClawType.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityLabel("Review exec approval")
                    .accessibilityValue(item.prompt.commandPreview ?? item.prompt.commandText)
                }
            }
        }

        if let pendingApproval {
            Section("Reviewing") {
                ForEach(self.approvalItems, id: \.id) { item in
                    SettingsApprovalRow(item: item)
                }
                if let warningText = pendingApproval.warningText {
                    Label {
                        Text(warningText)
                            .font(OpenClawType.caption)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .foregroundStyle(OpenClawBrand.warn)
                    .fixedSize(horizontal: false, vertical: true)
                }
                if let errorText = self.appModel.pendingExecApprovalPromptErrorText {
                    Text(errorText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(OpenClawBrand.danger)
                }
                if let resolvedText = self.appModel.pendingExecApprovalPromptResolvedText {
                    Text(resolvedText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(self.approvalOutcomeColor)
                    Button {
                        self.appModel.dismissPendingExecApprovalPrompt()
                    } label: {
                        Label("Dismiss", systemImage: "xmark")
                            .font(OpenClawType.body)
                    }
                } else {
                    if pendingApproval.allowsAllowOnce {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once") }
                        } label: {
                            Label("Allow Once", systemImage: "checkmark")
                                .font(OpenClawType.body)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if pendingApproval.allowsAllowAlways {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always") }
                        } label: {
                            Label("Allow Always", systemImage: "checkmark.shield")
                                .font(OpenClawType.body)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if pendingApproval.allowsDeny {
                        Button(role: .destructive) {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny") }
                        } label: {
                            Label("Deny", systemImage: "xmark")
                                .font(OpenClawType.body)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if self.appModel.pendingExecApprovalPromptResolving,
                       self.appModel.pendingExecApprovalPromptCanDismiss
                    {
                        Button(role: .cancel) {
                            self.appModel.dismissPendingExecApprovalPrompt()
                        } label: {
                            Label("Dismiss", systemImage: "xmark")
                                .font(OpenClawType.body)
                        }
                    }
                }
            }
        } else if self.pendingApprovalCount == 0 {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("No approvals waiting")
                            .font(OpenClawType.subheadSemiBold)
                        Text(self.approvalEmptyDetail)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "checkmark.shield.fill")
                        .foregroundStyle(OpenClawBrand.ok)
                }
            }
        }
    }

    private var approvalOutcomeColor: Color {
        switch self.appModel.pendingExecApprovalPromptOutcome?.tone {
        case .success:
            OpenClawBrand.ok
        case .danger:
            OpenClawBrand.danger
        case .warning:
            OpenClawBrand.warn
        case .neutral, nil:
            .secondary
        }
    }

    var diagnosticsDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "checklist.checked",
                title: "Health Check",
                detail: "Run app, permission, and gateway-adjacent checks without editing setup.",
                value: .verbatim(self.diagnosticsHealthValue),
                color: self.gatewayDiagnosticConnected ? OpenClawBrand.ok : OpenClawBrand.warn)

            Section {
                Button {
                    Task { await self.runDiagnostics() }
                } label: {
                    Label("Run Diagnostics", systemImage: "cross.case")
                        .font(OpenClawType.body)
                }
                .disabled(self.isRefreshingGateway)
            }

            self.diagnosticChecksCard

            self.detailListCard {
                SettingsDetailRow("Device", value: .verbatim(DeviceInfoHelper.deviceFamily()))
                SettingsDetailRow(
                    "Platform",
                    value: .verbatim(DeviceInfoHelper.platformStringForDisplay()))
                SettingsDetailRow(
                    "App",
                    value: .verbatim(DeviceInfoHelper.openClawVersionString()))
                SettingsDetailRow("Model", value: .verbatim(DeviceInfoHelper.modelIdentifier()))
            }

            self.diagnosticsAdvancedCard
        }
    }

    @ViewBuilder
    var gatewayActionStatusView: some View {
        if let gatewayActionStatusText {
            Text(verbatim: gatewayActionStatusText)
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder var licensesDestination: some View {
        let documents = LicenseDocumentLoader.bundledDocuments()
        if documents.isEmpty {
            ContentUnavailableView(
                "No Licenses Bundled",
                systemImage: "doc.text",
                description: Text("License files are not available in this build."))
                .font(OpenClawType.body)
        } else {
            Section {
                ForEach(documents) { document in
                    NavigationLink {
                        LicenseDocumentDetailView(document: document)
                    } label: {
                        Label {
                            Text(document.title)
                                .font(OpenClawType.subhead)
                        } icon: {
                            SettingsIcon(systemName: "doc.text", color: .gray)
                        }
                    }
                }
            } footer: {
                Text("OpenClaw appreciates its partners in the open-source community.")
                    .font(OpenClawType.footnote)
            }
            .accessibilityIdentifier("settings-licenses-list")
        }
    }

    /// Native inset-grouped action row (plain tinted text, no pill chrome).
    func gatewayActionButton(
        title: LocalizedStringKey,
        icon: String,
        color: Color,
        isBusy: Bool,
        isDisabled: Bool = false,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack {
                Label(title, systemImage: icon)
                    .font(OpenClawType.body)
                Spacer()
                if isBusy {
                    ProgressView().controlSize(.small)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(color)
        .disabled(isBusy || isDisabled)
        .accessibilityLabel(Text(title))
    }

    var aboutDestination: some View {
        Group {
            Section {
                VStack(spacing: 12) {
                    OpenClawProMark(size: 96, shadowRadius: 18, interactive: true)
                        .accessibilityHidden(true)
                    VStack(spacing: 2) {
                        Text("OpenClaw")
                            .font(OpenClawType.title2SemiBold)
                        Text("Personal AI on your devices")
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                        SettingsBuildMetadataStrip(metadata: DeviceInfoHelper.buildMetadata())
                            .padding(.top, 8)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
                .accessibilityElement(children: .contain)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            // Concise public details only; deep hardware identifiers live in Diagnostics.
            detailListCard {
                SettingsDetailRow("Device", value: .verbatim(DeviceInfoHelper.deviceFamily()))
                SettingsDetailRow(
                    "iOS",
                    value: .verbatim(DeviceInfoHelper.iOSVersionStringForDisplay()))
            }

            Section {
                self.aboutLinkRow(
                    title: "Website",
                    icon: "globe",
                    color: .blue,
                    url: URL(string: "https://openclaw.ai")!)
                self.aboutLinkRow(
                    title: "Docs",
                    icon: "book.fill",
                    color: .orange,
                    url: URL(string: "https://docs.openclaw.ai")!)
                self.aboutLinkRow(
                    title: "GitHub",
                    icon: "chevron.left.slash.chevron.right",
                    color: .gray,
                    url: URL(string: "https://github.com/openclaw/openclaw")!)
                self.aboutLinkRow(
                    title: "Discord",
                    icon: "bubble.left.and.bubble.right.fill",
                    color: .indigo,
                    url: URL(string: "https://discord.gg/clawd")!)
            } footer: {
                Text("© 2026 OpenClaw Foundation — MIT License.")
                    .font(OpenClawType.footnote)
            }
        }
    }

    /// About link row with explicit branded label; shorthand `Link("Title", ...)`
    /// would bypass the typography audit and OpenClawType styling.
    func aboutLinkRow(
        title: LocalizedStringKey,
        icon: String,
        color: Color,
        url: URL) -> some View
    {
        Link(destination: url) {
            HStack {
                Label {
                    Text(title)
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(.primary)
                } icon: {
                    SettingsIcon(systemName: icon, color: color)
                }
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Text(title))
    }

    var agentSelectionCard: some View {
        Section {
            Picker("Default Agent", selection: self.$selectedAgentPickerId) {
                Text("Default").font(OpenClawType.body).tag("")
                let defaultId = (self.appModel.gatewayDefaultAgentId ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                ForEach(
                    self.appModel.gatewayAgents.filter(\.isSelectableAgent).filter { $0.id != defaultId },
                    id: \.id)
                { agent in
                    let name = (agent.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    Text(name.isEmpty ? agent.id : name).font(OpenClawType.body).tag(agent.id)
                }
            }
            .font(OpenClawType.body)
        } footer: {
            Text("Used for new Chat and Talk sessions.")
                .font(OpenClawType.footnote)
        }
    }

    /// One section owns the whole pairing story: scan, paste, and discovered
    /// gateways; splitting these across the page hid Scan QR below plumbing.
    var gatewaySetupCard: some View {
        Section {
            self.gatewayActionButton(
                title: "Scan QR",
                icon: "qrcode.viewfinder",
                color: OpenClawBrand.accent,
                isBusy: false,
                isDisabled: self.connectingGateway != nil)
            {
                self.openGatewayQRScanner()
            }
            TextField("Paste setup code", text: self.$setupCode)
                .font(OpenClawType.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(self.connectingGateway != nil)
            self.gatewayActionButton(
                title: "Connect",
                icon: "bolt.horizontal.circle",
                color: OpenClawBrand.accent,
                isBusy: self.setupAttemptID != nil,
                isDisabled: !self.canApplyGatewaySetup || self.connectingGateway != nil)
            {
                Task { await self.applySetupCodeAndConnect() }
            }
            if self.gatewayController.gateways.isEmpty {
                Text("No gateways found yet. Use manual setup if Bonjour is blocked.")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.gatewayController.gateways) { gateway in
                    self.discoveredGatewayRow(gateway)
                }
            }
        } header: {
            Text("Add Gateway")
                .font(OpenClawType.subheadSemiBold)
        } footer: {
            if let warning = self.tailnetWarningText {
                Text(warning).font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.warn)
            } else if let status = self.setupStatusLine {
                Text(status)
                    .font(OpenClawType.footnote)
            }
        }
    }

    var pairedGatewaysCard: some View {
        Section {
            if self.gatewayRegistry.entries.isEmpty {
                Text("Pair a gateway to make it available here.")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.gatewayRegistry.entries) { entry in
                    self.pairedGatewayRow(entry)
                }
            }
        } header: {
            Text("Paired Gateways")
                .font(OpenClawType.subheadSemiBold)
        } footer: {
            Text("Keep multiple gateways connected and switch which one is in focus.")
                .font(OpenClawType.footnote)
        }
    }

    func pairedGatewayRow(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> some View {
        let isActive = GatewayStableIdentifier.matches(
            entry.stableID,
            self.gatewayRegistry.activeStableID)
        let keepsConnected = self.gatewayRegistry.connectedStableIDs.contains {
            GatewayStableIdentifier.matches($0, entry.stableID)
        }
        return HStack(spacing: 12) {
            Button {
                guard !isActive else { return }
                Task { await self.switchGateway(to: entry) }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.name)
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(.primary)
                    Text(self.gatewayEndpointSummary(entry))
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
            }
            .buttonStyle(.plain)
            .disabled(self.connectingGateway != nil)

            if self.connectingGateway == .gateway(entry.id) {
                ProgressView()
                    .controlSize(.small)
            } else if isActive {
                Image(systemName: "checkmark.circle.fill")
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(OpenClawBrand.accent)
                    .accessibilityLabel("Focused Gateway")
            } else {
                Button {
                    if self.gatewayController.setGatewayConnectionEnabled(
                        stableID: entry.stableID,
                        enabled: !keepsConnected)
                    {
                        self.refreshGatewayRegistry()
                    }
                } label: {
                    Image(systemName: keepsConnected ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle")
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(keepsConnected ? OpenClawBrand.accent : .secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(keepsConnected ? "Disconnect Gateway" : "Keep Gateway Connected")
            }
        }
        .contentShape(Rectangle())
        .swipeActions {
            Button(role: .destructive) {
                self.pendingForgetGateway = entry
            } label: {
                Label {
                    Text("Forget")
                        .font(OpenClawType.captionSemiBold)
                } icon: {
                    Image(systemName: "trash")
                }
            }
        }
        .contextMenu {
            Button(role: .destructive) {
                self.pendingForgetGateway = entry
            } label: {
                Label {
                    Text("Forget Gateway")
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "trash")
                }
            }
        }
    }

    func discoveredGatewayRow(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> some View {
        let availability = self.gatewayController.discoveredGatewayConnectionAvailability(gateway)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: gateway.name)
                        .font(OpenClawType.subheadSemiBold)
                    Text(verbatim: self.gatewayDetailLines(gateway).joined(separator: " • "))
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                if availability.canConnect {
                    Button {
                        Task { await self.connect(gateway) }
                    } label: {
                        if self.connectingGateway == .gateway(gateway.id) {
                            ProgressView().controlSize(.small)
                        } else {
                            Text(availability.actionTitle)
                                .font(OpenClawType.captionSemiBold)
                        }
                    }
                    .font(OpenClawType.captionSemiBold)
                    .buttonStyle(.bordered)
                    .disabled(self.connectingGateway != nil)
                } else {
                    Text(availability.actionTitle)
                        .font(OpenClawType.captionSemiBold)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }

            if let guidanceText = availability.guidanceText {
                Text(guidanceText)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    var manualGatewayCard: some View {
        Section("Manual Gateway") {
            self.settingsToggle("Use Manual Gateway", isOn: self.manualGatewayEnabledBinding)
            TextField("Host", text: self.manualHostBinding)
                .font(OpenClawType.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Port", text: self.manualPortBinding)
                .font(OpenClawType.body)
                .keyboardType(.numberPad)
            Picker(selection: self.manualGatewayTLSBinding) {
                Text("Unencrypted")
                    .font(OpenClawType.captionSemiBold)
                    .tag(false)
                Text("Secure (TLS)")
                    .font(OpenClawType.captionSemiBold)
                    .tag(true)
            } label: {
                Text("Connection security")
                    .font(OpenClawType.captionSemiBold)
            }
            .pickerStyle(.segmented)
            .disabled(self.manualGatewayTransport.requiresTLS)
            if let helperText = self.manualGatewayTransport.helperText {
                Text(helperText)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            }
            self.gatewayActionButton(
                title: "Connect Manual",
                icon: "network",
                color: OpenClawBrand.accent,
                isBusy: self.connectingGateway == .manual,
                isDisabled: self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || !self.manualPortIsValid)
            {
                Task { await self.connectManual() }
            }
        }
        .disabled(self.setupAttemptID != nil)
    }

    private var manualGatewayTransport: GatewayManualTransportPresentation {
        GatewayConnectionController.manualTransportPresentation(
            host: self.manualGatewayHost,
            requestedTLS: self.manualGatewayTLS)
    }

    private var manualGatewayTLSBinding: Binding<Bool> {
        Binding(
            get: { self.manualGatewayTransport.effectiveTLS },
            set: { enabled in
                guard !self.manualGatewayTransport.requiresTLS else { return }
                self.manualGatewayContextPath = nil
                self.manualGatewayTLS = enabled
            })
    }

    var gatewayAdvancedCard: some View {
        Section {
            self.settingsToggle("Auto-connect on launch", isOn: self.$gatewayAutoConnect)
            self.gatewaySecureField("Gateway Auth Token", text: self.gatewayTokenBinding)
            self.gatewaySecureField("Gateway Password", text: self.gatewayPasswordBinding)
            if let headersStableID = self.gatewayCustomHeadersTargetStableID {
                NavigationLink {
                    GatewayCustomHeadersSettingsView(gatewayStableID: headersStableID)
                } label: {
                    Text("Custom Headers")
                        .font(OpenClawType.body)
                }
            }
            Button(role: .destructive) {
                self.showResetOnboardingAlert = true
            } label: {
                Label("Reset Onboarding", systemImage: "arrow.counterclockwise")
                    .font(OpenClawType.body)
            }
        }
    }

    func gatewaySecureField(
        _ placeholder: LocalizedStringKey,
        text: Binding<String>) -> some View
    {
        ZStack(alignment: .leading) {
            SecureField("", text: text)
                .font(OpenClawType.subhead)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(Text(placeholder))
            if text.wrappedValue.isEmpty {
                Text(placeholder)
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 8)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .font(OpenClawType.subhead)
    }

    var diagnosticsAdvancedCard: some View {
        Section {
            self.settingsToggle("Discovery Debug Logs", isOn: self.$discoveryDebugLogsEnabled) { enabled in
                self.gatewayController.setDiscoveryDebugLoggingEnabled(enabled)
            }
            NavigationLink {
                GatewayDiscoveryDebugLogView()
            } label: {
                SettingsDetailRow(
                    "Discovery Logs",
                    value: .verbatim(self.gatewayController.discoveryStatusText))
            }
        }
    }

    var deviceIdentityCard: some View {
        Section("Device") {
            TextField("Device Name", text: self.$displayName)
                .font(OpenClawType.body)
            SettingsDetailRow("Instance ID", value: .verbatim(self.instanceId))
        }
    }

    func settingsToggle(
        _ title: LocalizedStringKey,
        isOn: Binding<Bool>,
        onChange: ((Bool) -> Void)? = nil) -> some View
    {
        // Native Toggle rows can ignore visible-row taps on iOS 26; reuse the shared indicator row.
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            HStack {
                Text(title)
                    .font(OpenClawType.body)
                Spacer(minLength: 8)
                OpenClawToggleIndicator(isOn: isOn.wrappedValue)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title))
        .accessibilityValue(isOn.wrappedValue
            ? String(localized: "On")
            : String(localized: "Off"))
        .onChange(of: isOn.wrappedValue) { _, enabled in
            onChange?(enabled)
        }
    }
}
