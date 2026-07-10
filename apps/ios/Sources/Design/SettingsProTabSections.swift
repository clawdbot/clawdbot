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

private struct AppearanceSettingsRow: View {
    @Environment(AppAppearanceModel.self) private var appearanceModel

    private var preference: AppAppearancePreference {
        self.appearanceModel.preference
    }

    var body: some View {
        NavigationLink {
            AppearanceSettingsScreen()
        } label: {
            self.rowLabel
        }
        .accessibilityIdentifier("settings-appearance-row")
        .accessibilityLabel("Appearance")
        .accessibilityValue(self.preference.label)
        .accessibilityHint("Choose system, light, or dark appearance")
    }

    private var rowLabel: some View {
        HStack(spacing: 12) {
            ProIconBadge(
                systemName: "circle.lefthalf.filled",
                color: .secondary)

            Text("Appearance")
                .font(OpenClawType.subheadSemiBold)

            Spacer(minLength: 8)

            Text(self.preference.label)
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
        }
    }
}

private struct AppearanceSettingsScreen: View {
    @Environment(AppAppearanceModel.self) private var appearanceModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                ForEach(AppAppearancePreference.allCases) { preference in
                    Button {
                        self.select(preference)
                    } label: {
                        Label {
                            HStack {
                                Text(preference.label)
                                    .font(OpenClawType.body)
                                Spacer()
                                if preference == self.appearanceModel.preference {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(OpenClawBrand.accent)
                                }
                            }
                        } icon: {
                            Image(systemName: preference.systemImage)
                        }
                    }
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("settings-appearance-\(preference.rawValue)")
                    .accessibilityValue(
                        preference == self.appearanceModel.preference ? "Selected" : "")
                }
            } footer: {
                Text("System follows this device’s appearance setting.")
                    .font(OpenClawType.footnote)
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func select(_ preference: AppAppearancePreference) {
        guard preference != self.appearanceModel.preference else { return }
        self.dismiss()
        Task { @MainActor in
            // Changing the root scheme while an iPad split-view destination is active can
            // leave that destination blank. Apply only after the native pop transition.
            try? await Task.sleep(for: .milliseconds(500))
            self.appearanceModel.select(preference)
        }
    }
}

extension SettingsProTab {
    var appearanceRow: some View {
        AppearanceSettingsRow()
    }

    var gatewaySection: some View {
        Section("Gateway") {
            HStack(spacing: 8) {
                NavigationLink(value: SettingsRoute.gateway) {
                    self.gatewayConnectionRow
                }
                if self.gatewayRegistry.entries.count > 1 {
                    self.gatewayQuickSwitchMenu
                }
            }
            SettingsDetailRow("Address", value: self.gatewayAddress)
            SettingsDetailRow("Server", value: self.gatewayServer)
            SettingsDetailRow("Agents", value: "\(self.appModel.gatewayAgents.count)")
            self.gatewayActions
        }
    }

    var gatewayConnectionRow: some View {
        LabeledContent {
            Text(self.gatewayStatusDetail)
                .font(OpenClawType.subhead)
                .foregroundStyle(self.gatewayStatusColor)
        } label: {
            Text("Connection")
                .font(OpenClawType.subheadSemiBold)
        }
    }

    @ViewBuilder var settingsListSection: some View {
        Section {
            self.settingsListRow(
                icon: "checkmark.shield.fill",
                iconColor: self.pendingApproval == nil ? .green : .orange,
                title: "Approvals",
                route: .approvals,
                badgeValue: self.pendingApproval == nil ? nil : "1")
            self.settingsListRow(
                icon: "person.2.fill",
                iconColor: .blue,
                title: "Permissions",
                route: .permissions)
            self.settingsListRow(
                icon: "point.3.connected.trianglepath.dotted",
                iconColor: .purple,
                title: "Channels",
                route: .channels)
            self.settingsListRow(
                icon: "waveform",
                iconColor: .pink,
                title: "Voice & Talk",
                route: .voice)
        }

        Section {
            self.appearanceRow
            self.settingsListRow(
                icon: "stethoscope",
                iconColor: .teal,
                title: "Diagnostics",
                route: .diagnostics)
            self.settingsListRow(
                icon: "hand.raised.fill",
                iconColor: .indigo,
                title: "Privacy",
                route: .privacy)
            self.settingsListRow(
                icon: "applewatch",
                iconColor: .green,
                title: "Apple Watch",
                route: .appleWatch)
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

        Section {
            self.settingsListRow(
                icon: "doc.text",
                iconColor: .gray,
                title: "Licenses",
                route: .licenses)
                .accessibilityIdentifier("settings-licenses-row")
        }
    }

    func settingsListRow(
        icon: String,
        iconColor: Color,
        title: String,
        route: SettingsRoute,
        badgeValue: String? = nil) -> some View
    {
        NavigationLink(value: route) {
            Label {
                Text(title)
                    .font(OpenClawType.subheadSemiBold)
            } icon: {
                SettingsIcon(systemName: icon, color: iconColor)
            }
        }
        .badge(badgeValue.map { Text($0).font(OpenClawType.captionSemiBold) })
    }

    @ViewBuilder
    func destination(for route: SettingsRoute) -> some View {
        switch route {
        case .channels:
            SettingsChannelsDestination()
                .navigationTitle(title(for: route))
                .navigationBarTitleDisplayMode(.inline)
        default:
            List {
                switch route {
                case .gateway:
                    self.gatewayDestination
                case .appleWatch:
                    self.appleWatchDestination
                case .approvals:
                    self.approvalsDestination
                case .permissions:
                    self.permissionsDestination
                case .voice:
                    self.voiceDestination
                case .diagnostics:
                    self.diagnosticsDestination
                case .privacy:
                    self.privacyDestination
                case .notifications:
                    self.notificationsDestination
                case .about:
                    self.aboutDestination
                case .licenses:
                    self.licensesDestination
                case .channels:
                    EmptyView()
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
                if let headerLeadingAction {
                    ToolbarItem(placement: .topBarLeading) {
                        OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)
                    }
                }
                ToolbarItem(placement: .principal) {
                    Text(title(for: route))
                        .font(OpenClawType.headline)
                        .foregroundStyle(.primary)
                }
            }
        }
    }

    var gatewayDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "antenna.radiowaves.left.and.right",
                title: "Gateway",
                detail: self.gatewayStatusDetail,
                value: self.gatewayStatusValue,
                color: self.gatewayStatusColor)

            self.detailListCard {
                SettingsDetailRow("Address", value: self.gatewayAddress)
                SettingsDetailRow("Server", value: self.gatewayServer)
                SettingsDetailRow("Discovered", value: "\(self.gatewayController.gateways.count)")
                SettingsDetailRow("Default Agent", value: self.appModel.activeAgentName)
                SettingsDetailRow("Agents", value: "\(self.appModel.gatewayAgents.count)")
            }

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
            }

            self.manualGatewayCard
            self.pairedGatewaysCard
            self.deviceIdentityCard
            self.agentSelectionCard
            self.gatewaySetupCard
            self.discoveredGatewaysCard
            self.gatewayAdvancedCard
        }
        .font(OpenClawType.body)
    }

    var gatewayQuickSwitchMenu: some View {
        Menu {
            ForEach(self.gatewayRegistry.entries) { entry in
                Button {
                    Task { await self.switchGateway(to: entry) }
                } label: {
                    Label {
                        Text(entry.name)
                            .font(OpenClawType.body)
                    } icon: {
                        Image(systemName: entry.stableID == self.gatewayRegistry.activeStableID
                            ? "checkmark.circle.fill"
                            : "circle")
                    }
                }
                .disabled(entry.stableID == self.gatewayRegistry.activeStableID || self.connectingGatewayID != nil)
            }
        } label: {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(OpenClawBrand.accent)
        }
        .accessibilityLabel("Switch Gateway")
    }

    var approvalsDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "checkmark.shield.fill",
                title: "Approvals",
                detail: self.notificationsNeedAttention
                    ? "Out-of-app approval alerts need notification permission."
                    : (self.pendingApproval == nil ? "No gateway actions are waiting for review." :
                        "Review the pending gateway action."),
                value: self.notificationsNeedAttention
                    ? "Alerts Off"
                    : (self.pendingApproval == nil ? "clear" : "1 waiting"),
                color: self.notificationsNeedAttention ? OpenClawBrand.warn :
                    (self.pendingApproval == nil ? OpenClawBrand.ok : OpenClawBrand.warn))

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
                detail: watchStatus.appInstalled
                    ? "Relay remains available; direct mode adds an independent Gateway node."
                    : "Install the OpenClaw watch app before enabling direct mode.",
                value: watchStatus.reachable ? "Reachable" : (watchStatus.appInstalled ? "Installed" : "Unavailable"),
                color: watchStatus.appInstalled ? OpenClawBrand.ok : OpenClawBrand.warn)

            Section {
                Button {
                    Task { await self.sendDirectWatchSetup() }
                } label: {
                    Label("Enable Direct Gateway Connection", systemImage: "point.3.connected.trianglepath.dotted")
                        .font(OpenClawType.body)
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
                    The watch receives a one-time pairing code and stores its own device token. \
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
            if self.directRoute == nil {
                Button {
                    self.openNotificationsRouteFromApprovals()
                } label: {
                    Label("Open Notifications", systemImage: "bell.badge")
                        .font(OpenClawType.body)
                }
            }
        }
    }

    @ViewBuilder
    var approvalsReviewCard: some View {
        if let pendingApproval {
            Section {
                ForEach(self.approvalItems, id: \.id) { item in
                    SettingsApprovalRow(item: item)
                }
                if let errorText = self.appModel.pendingExecApprovalPromptErrorText {
                    Text(errorText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(OpenClawBrand.danger)
                }
                Button {
                    Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once") }
                } label: {
                    Label("Allow", systemImage: "checkmark")
                        .font(OpenClawType.body)
                }
                .disabled(self.appModel.pendingExecApprovalPromptResolving)
                if pendingApproval.allowsAllowAlways {
                    Button {
                        Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always") }
                    } label: {
                        Label("Always Allow", systemImage: "checkmark.shield")
                            .font(OpenClawType.body)
                    }
                    .disabled(self.appModel.pendingExecApprovalPromptResolving)
                }
                Button(role: .destructive) {
                    Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny") }
                } label: {
                    Label("Deny", systemImage: "xmark")
                        .font(OpenClawType.body)
                }
                .disabled(self.appModel.pendingExecApprovalPromptResolving)
            }
        } else {
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

    var permissionsDestination: some View {
        Group {
            self.toggleCard(
                title: "Camera",
                isOn: self.$cameraEnabled)

            self.locationModeCard

            self.toggleCard(
                title: "Keep Awake",
                isOn: self.$preventSleep)

            self.privacyAccessCard
        }
    }

    var voiceDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "waveform",
                title: "Voice & Talk",
                detail: self.appModel.talkMode.gatewayTalkVoiceModeTitle,
                value: self.voiceDetail,
                color: self.talkEnabled || self.voiceWakeEnabled ? OpenClawBrand.accent : .secondary)

            self.voiceFeatureCard
            self.talkVoiceSettingsCard
            self.shareSettingsCard
        }
    }

    var diagnosticsDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "checklist.checked",
                title: "Health Check",
                detail: "Run app, permission, and gateway-adjacent checks without editing setup.",
                value: self.diagnosticsHealthValue,
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
                SettingsDetailRow("Device", value: DeviceInfoHelper.deviceFamily())
                SettingsDetailRow("Platform", value: DeviceInfoHelper.platformStringForDisplay())
                SettingsDetailRow("App", value: DeviceInfoHelper.openClawVersionString())
                SettingsDetailRow("Model", value: DeviceInfoHelper.modelIdentifier())
            }

            self.diagnosticsAdvancedCard
        }
    }

    var privacyDestination: some View {
        Group {
            self.notificationsSection

            self.toggleCard(
                title: "Camera Access",
                isOn: self.$cameraEnabled)

            self.locationModeCard

            self.toggleCard(
                title: "Background Listening",
                isOn: self.$talkBackgroundEnabled)

            self.privacyAccessCard
        }
    }

    var notificationsDestination: some View {
        self.notificationsSection
    }

    var notificationsSection: some View {
        Section("Notifications") {
            HStack(spacing: 12) {
                SettingsIcon(systemName: "bell.fill", color: self.notificationStatusColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Notifications")
                        .font(OpenClawType.subheadSemiBold)
                    Text(self.notificationStatusDetail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Toggle(isOn: self.notificationToggleBinding) {
                    Text("Notifications")
                        .font(OpenClawType.subheadSemiBold)
                }
                .labelsHidden()
                .disabled(self.notificationStatus == .checking || self.isRequestingNotificationAuthorization)
                .accessibilityIdentifier("settings-notifications-toggle")
                .accessibilityValue(self.notificationServingActive ? "On" : "Off")
                .accessibilityHint("Turns OpenClaw notification delivery on or off")
            }

            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "network")
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(OpenClawBrand.accent)
                    .frame(width: 22, height: 22)
                Text(self.notificationRelayDetail)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityIdentifier("settings-privacy-notifications-section")
    }

    var gatewayActions: some View {
        Group {
            self.gatewayActionButton(
                title: "Reconnect",
                icon: "arrow.triangle.2.circlepath",
                color: OpenClawBrand.accent,
                isBusy: self.isReconnectingGateway,
                isDisabled: self.appModel.isAppleReviewDemoModeEnabled)
            {
                Task { await self.reconnectGateway() }
            }

            self.gatewayActionButton(
                title: "Diagnose",
                icon: "cross.case",
                color: OpenClawBrand.accent,
                isBusy: self.isRefreshingGateway)
            {
                Task { await self.runDiagnostics() }
            }
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
        title: String,
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
        .accessibilityLabel(title)
    }

    var aboutDestination: some View {
        Group {
            Section {
                VStack(spacing: 12) {
                    OpenClawProMark(size: 96, shadowRadius: 18)
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
                SettingsDetailRow("Device", value: DeviceInfoHelper.deviceFamily())
                SettingsDetailRow("iOS", value: DeviceInfoHelper.iOSVersionStringForDisplay())
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
    func aboutLinkRow(title: String, icon: String, color: Color, url: URL) -> some View {
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
        .accessibilityLabel(title)
    }

    func toggleCard(title: String, isOn: Binding<Bool>) -> some View {
        Section {
            self.settingsToggle(title, isOn: isOn)
        }
    }

    var locationModeCard: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Button {
                    self.handleLocationSharingTap()
                } label: {
                    HStack {
                        Text("Location")
                            .font(OpenClawType.body)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        ZStack {
                            OpenClawToggleIndicator(isOn: self.locationSettingsPresentation.sharingControlIsOn)
                                .opacity(self.isChangingLocationMode ? 0 : 1)
                            if self.isChangingLocationMode {
                                ProgressView()
                                    .controlSize(.small)
                            }
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(self.isChangingLocationMode)
                .accessibilityIdentifier("settings-location-sharing-toggle")
                .accessibilityLabel("Location Sharing")
                .accessibilityValue(self.locationSettingsPresentation.sharingControlIsOn ? "On" : "Off")

                if self.locationSettingsPresentation.showsAccessLevel,
                   let accessLevelText = self.locationSettingsPresentation.accessLevelText
                {
                    Divider()
                    Button {
                        self.showLocationAccessDialog = true
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Text("Access Level")
                                .font(OpenClawType.body)
                                .foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            Text(accessLevelText)
                                .font(OpenClawType.subhead)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.trailing)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(self.isChangingLocationMode)
                    .accessibilityElement(children: .ignore)
                    .accessibilityIdentifier("settings-location-access-level")
                    .accessibilityLabel("Access Level")
                    .accessibilityValue(accessLevelText)
                    .accessibilityHint("Chooses While Using the App or Always")
                }

                if let locationPermissionDetailText {
                    Text(locationPermissionDetailText)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }

                if let locationPermissionWarningText {
                    Text(locationPermissionWarningText)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
    }

    var agentSelectionCard: some View {
        Section {
            Picker("Default Agent", selection: self.$selectedAgentPickerId) {
                Text("Default").font(OpenClawType.body).tag("")
                let defaultId = (self.appModel.gatewayDefaultAgentId ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                ForEach(self.appModel.gatewayAgents.filter { $0.id != defaultId }, id: \.id) { agent in
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

    var gatewaySetupCard: some View {
        Section {
            TextField("Paste setup code", text: self.$setupCode)
                .font(OpenClawType.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(self.connectingGatewayID != nil)
            self.gatewayActionButton(
                title: "Scan QR",
                icon: "qrcode.viewfinder",
                color: OpenClawBrand.accent,
                isBusy: false,
                isDisabled: self.connectingGatewayID != nil)
            {
                self.openGatewayQRScanner()
            }

            self.gatewayActionButton(
                title: "Connect",
                icon: "bolt.horizontal.circle",
                color: OpenClawBrand.accent,
                isBusy: self.connectingGatewayID == "manual",
                isDisabled: !self.canApplyGatewaySetup || self.connectingGatewayID != nil)
            {
                Task { await self.applySetupCodeAndConnect() }
            }
        } header: {
            Text("Setup Code")
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

    var discoveredGatewaysCard: some View {
        Section("Discovered Gateways") {
            if self.gatewayController.gateways.isEmpty {
                Text("No gateways found yet. Use manual setup if Bonjour is blocked.")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.gatewayController.gateways) { gateway in
                    self.discoveredGatewayRow(gateway)
                }
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
            Text("Switch gateways without pairing again.")
                .font(OpenClawType.footnote)
        }
    }

    func pairedGatewayRow(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> some View {
        let isActive = entry.stableID == self.gatewayRegistry.activeStableID
        return Button {
            guard !isActive else { return }
            Task { await self.switchGateway(to: entry) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.name)
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(.primary)
                    Text(self.gatewayEndpointSummary(entry))
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if self.connectingGatewayID == entry.stableID {
                    ProgressView()
                        .controlSize(.small)
                } else if isActive {
                    Image(systemName: "checkmark.circle.fill")
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(OpenClawBrand.accent)
                        .accessibilityLabel("Active Gateway")
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(self.connectingGatewayID != nil)
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
                        if self.connectingGatewayID == gateway.id {
                            ProgressView().controlSize(.small)
                        } else {
                            Text(availability.actionTitle)
                                .font(OpenClawType.captionSemiBold)
                        }
                    }
                    .font(OpenClawType.captionSemiBold)
                    .buttonStyle(.bordered)
                    .disabled(self.connectingGatewayID != nil)
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
                isBusy: self.connectingGatewayID == "manual",
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

    func gatewaySecureField(_ placeholder: String, text: Binding<String>) -> some View {
        ZStack(alignment: .leading) {
            SecureField("", text: text)
                .font(OpenClawType.subhead)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(placeholder)
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

    var voiceFeatureCard: some View {
        Section {
            self.settingsToggle("Voice Wake", isOn: self.$voiceWakeEnabled) { enabled in
                self.appModel.setVoiceWakeEnabled(enabled)
            }
            self.settingsToggle("Talk Mode", isOn: self.$talkEnabled) { enabled in
                guard !self.appModel.isAppleReviewDemoModeEnabled else {
                    self.talkEnabled = false
                    return
                }
                self.appModel.setTalkEnabled(enabled)
            }
            .disabled(self.appModel.isAppleReviewDemoModeEnabled)
            Picker("Speech Language", selection: self.$talkSpeechLocale) {
                ForEach(TalkSpeechLocale.supportedOptions()) { option in
                    Text(option.label).font(OpenClawType.body).tag(option.id)
                }
            }
            .font(OpenClawType.body)
            self.settingsToggle("Background Listening", isOn: self.$talkBackgroundEnabled)
            self.settingsToggle("Speakerphone", isOn: self.talkSpeakerphoneBinding)
            NavigationLink {
                VoiceWakeWordsSettingsView()
            } label: {
                SettingsDetailRow(
                    "Wake Words",
                    value: VoiceWakePreferences.displayString(for: self.voiceWake.triggerWords))
            }
        }
    }

    var talkVoiceSettingsCard: some View {
        Group {
            if self.gatewayConnected,
               let issue = self.appModel.talkMode.gatewayTalkCurrentFallbackIssue
            {
                Section {
                    TalkRuntimeIssueBanner(
                        issue: issue,
                        onOpenSettings: nil,
                        onShowDetails: {
                            self.showTalkIssueDetails = true
                        })
                }
            }
            Section("Voice") {
                Picker("Provider", selection: self.talkProviderSelectionBinding) {
                    ForEach(TalkModeProviderSelection.allCases) { option in
                        Text(option.label).font(OpenClawType.body).tag(option.rawValue)
                    }
                }
                .font(OpenClawType.body)
                if self.shouldShowRealtimeVoicePicker {
                    Picker("Realtime Voice", selection: self.talkRealtimeVoiceSelectionBinding) {
                        Text("Gateway Default").font(OpenClawType.body).tag("")
                        ForEach(TalkModeRealtimeVoiceSelection.voices, id: \.self) { voice in
                            Text(TalkModeRealtimeVoiceSelection.label(for: voice)).font(OpenClawType.body).tag(voice)
                        }
                    }
                    .font(OpenClawType.body)
                }
                SettingsDetailRow("Voice Mode", value: self.appModel.talkMode.gatewayTalkVoiceModeTitle)
                SettingsDetailRow("Active Voice", value: self.gatewayTalkActiveVoiceDetail)
                if let issue = self.gatewayTalkLastIssueDetail {
                    SettingsDetailRow("Last Voice Issue", value: issue)
                }
                SettingsDetailRow("Transport", value: self.appModel.talkMode.gatewayTalkTransportLabel)
                SettingsDetailRow("API Key", value: self.talkApiKeyStatus)
            }
        }
    }

    var shareSettingsCard: some View {
        Section {
            self.settingsToggle("Show Talk Control", isOn: self.$talkButtonEnabled)
            TextField("Default Share Instruction", text: self.$defaultShareInstruction, axis: .vertical)
                .font(OpenClawType.body)
                .lineLimit(2...5)
                .textInputAutocapitalization(.sentences)
            Button {
                Task { await self.appModel.runSharePipelineSelfTest() }
            } label: {
                Label("Run Share Self-Test", systemImage: "checkmark.seal")
                    .font(OpenClawType.body)
            }
        } footer: {
            Text(self.appModel.lastShareEventText)
                .font(OpenClawType.footnote)
        }
    }

    var privacyAccessCard: some View {
        Section {
            PrivacyAccessSectionView()
        }
    }

    var diagnosticsAdvancedCard: some View {
        Section {
            self.settingsToggle("Discovery Debug Logs", isOn: self.$discoveryDebugLogsEnabled) { enabled in
                self.gatewayController.setDiscoveryDebugLoggingEnabled(enabled)
            }
            self.settingsToggle("Debug Screen Status", isOn: self.$canvasDebugStatusEnabled)
            NavigationLink {
                GatewayDiscoveryDebugLogView()
            } label: {
                SettingsDetailRow("Discovery Logs", value: self.gatewayController.discoveryStatusText)
            }
        }
    }

    var deviceIdentityCard: some View {
        Section("Device") {
            TextField("Device Name", text: self.$displayName)
                .font(OpenClawType.body)
            SettingsDetailRow("Instance ID", value: self.instanceId)
        }
    }

    func settingsToggle(
        _ title: String,
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
        .accessibilityLabel(title)
        .accessibilityValue(isOn.wrappedValue ? "On" : "Off")
        .onChange(of: isOn.wrappedValue) { _, enabled in
            onChange?(enabled)
        }
    }
}
