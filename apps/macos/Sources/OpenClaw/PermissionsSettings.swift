import CoreLocation
import OpenClawIPC
import OpenClawKit
import SwiftUI

struct PermissionsSettings: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void
    let showOnboarding: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                SettingsPageHeader(
                    title: "Permissions",
                    subtitle: "macOS access for notifications, capture, voice, and device context.")

                self.permissionSummaryPanel

                SettingsCardGroup("System Access") {
                    PermissionStatusList(status: self.status, refresh: self.refresh)
                }

                SettingsCardGroup("Location") {
                    LocationAccessSettings()
                }

                SettingsCardGroup("Setup") {
                    SettingsCardRow(
                        title: "Onboarding walkthrough",
                        subtitle: "Use this if macOS prompts were skipped or permissions need a fresh walkthrough.",
                        showsDivider: false)
                    {
                        Button("Restart onboarding") { self.showOnboarding() }
                            .buttonStyle(.bordered)
                    }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.trailing, SettingsLayout.scrollbarGutter)
            .padding(.vertical, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var permissionSummaryPanel: some View {
        let granted = self.status.values.filter(\.self).count
        let total = Capability.allCases.count
        let complete = granted == total

        return HStack(alignment: .center, spacing: 14) {
            ZStack {
                Circle()
                    .fill((complete ? Color.green : Color.orange).opacity(0.18))
                Image(systemName: complete ? "checkmark.shield.fill" : "shield.lefthalf.filled")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(complete ? .green : .orange)
            }
            .frame(width: 46, height: 46)

            VStack(alignment: .leading, spacing: 4) {
                Text(complete ? "All access granted" : "\(granted) of \(total) permissions granted")
                    .font(.headline)
                Text("OpenClaw only asks for macOS capabilities when a feature needs them.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 18)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.white.opacity(0.06))
        }
    }
}

private struct LocationAccessSettings: View {
    private static let controlWidth: CGFloat = 180

    @AppStorage(locationModeKey) private var locationModeRaw: String = OpenClawLocationMode.off.rawValue
    @AppStorage(locationPreciseKey) private var locationPreciseEnabled: Bool = true
    @State private var lastLocationModeRaw: String = OpenClawLocationMode.off.rawValue

    var body: some View {
        VStack(spacing: 0) {
            SettingsCardRow(
                title: "Location access",
                subtitle: "Allow agents to use device location when a tool asks for it.")
            {
                Picker("Location Access", selection: self.$locationModeRaw) {
                    Text("Off").tag(OpenClawLocationMode.off.rawValue)
                    Text("While Using").tag(OpenClawLocationMode.whileUsing.rawValue)
                    Text("Always").tag(OpenClawLocationMode.always.rawValue)
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(width: Self.controlWidth, alignment: .trailing)
            }

            SettingsCardRow(
                title: "Precise location",
                subtitle: "Always may require System Settings to approve background location.",
                showsDivider: false)
            {
                Toggle("Precise Location", isOn: self.$locationPreciseEnabled)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .frame(width: Self.controlWidth, alignment: .trailing)
                    .disabled(self.locationMode == .off)
            }
        }
        .onAppear {
            self.lastLocationModeRaw = self.locationModeRaw
        }
        .onChange(of: self.locationModeRaw) { _, newValue in
            let previous = self.lastLocationModeRaw
            self.lastLocationModeRaw = newValue
            guard let mode = OpenClawLocationMode(rawValue: newValue) else { return }
            Task {
                let granted = await self.requestLocationAuthorization(mode: mode)
                if !granted {
                    await MainActor.run {
                        self.locationModeRaw = previous
                        self.lastLocationModeRaw = previous
                    }
                }
            }
        }
    }

    private var locationMode: OpenClawLocationMode {
        OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off
    }

    private func requestLocationAuthorization(mode: OpenClawLocationMode) async -> Bool {
        guard mode != .off else { return true }
        guard CLLocationManager.locationServicesEnabled() else {
            await MainActor.run { LocationPermissionHelper.openSettings() }
            return false
        }

        let status = CLLocationManager().authorizationStatus
        let requireAlways = mode == .always
        if PermissionManager.isLocationAuthorized(status: status, requireAlways: requireAlways) {
            return true
        }
        let updated = await LocationPermissionRequester.shared.request(always: requireAlways)
        return PermissionManager.isLocationAuthorized(status: updated, requireAlways: requireAlways)
    }
}

struct PermissionStatusList: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void
    @State private var pendingCapability: Capability?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(Capability.allCases.enumerated()), id: \.element) { index, cap in
                PermissionRow(
                    capability: cap,
                    status: self.status[cap] ?? false,
                    isPending: self.pendingCapability == cap,
                    showsDivider: index != Capability.allCases.count - 1)
                {
                    Task { await self.handle(cap) }
                }
            }

            SettingsCardRow(
                title: "Refresh status",
                subtitle: "Recheck macOS after approving access in System Settings.",
                showsDivider: false)
            {
                Button {
                    Task { await self.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .font(.footnote)
                .help("Refresh status")
            }
        }
    }

    @MainActor
    private func handle(_ cap: Capability) async {
        guard self.pendingCapability == nil else { return }
        self.pendingCapability = cap
        defer { self.pendingCapability = nil }

        _ = await PermissionManager.ensure([cap], interactive: true)
        await self.refreshStatusTransitions()
    }

    @MainActor
    private func refreshStatusTransitions() async {
        await self.refresh()

        // TCC and notification settings can settle after the prompt closes or when the app regains focus.
        for delay in [300_000_000, 900_000_000, 1_800_000_000] {
            try? await Task.sleep(nanoseconds: UInt64(delay))
            await self.refresh()
        }
    }
}

struct PermissionRow: View {
    let capability: Capability
    let status: Bool
    let isPending: Bool
    let compact: Bool
    let showsDivider: Bool
    let action: () -> Void

    init(
        capability: Capability,
        status: Bool,
        isPending: Bool = false,
        compact: Bool = false,
        showsDivider: Bool = false,
        action: @escaping () -> Void)
    {
        self.capability = capability
        self.status = status
        self.isPending = isPending
        self.compact = compact
        self.showsDivider = showsDivider
        self.action = action
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: self.compact ? 10 : 12) {
                ZStack {
                    Circle().fill(self.status ? Color.green.opacity(0.2) : Color.gray.opacity(0.15))
                        .frame(width: self.iconSize, height: self.iconSize)
                    Image(systemName: self.icon)
                        .foregroundStyle(self.status ? Color.green : Color.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.title).font(.body.weight(.semibold))
                    Text(self.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
                VStack(alignment: .trailing, spacing: 4) {
                    if self.status {
                        Label("Granted", systemImage: "checkmark.circle.fill")
                            .labelStyle(.iconOnly)
                            .foregroundStyle(.green)
                            .font(.title3)
                            .help("Granted")
                    } else if self.isPending {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 78)
                    } else {
                        Button("Grant") { self.action() }
                            .buttonStyle(.bordered)
                            .controlSize(self.compact ? .small : .regular)
                            .frame(minWidth: self.compact ? 68 : 78, alignment: .trailing)
                    }

                    if self.status {
                        Text("Granted")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.green)
                    } else if self.isPending {
                        Text("Checking…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Request access")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(minWidth: self.compact ? 86 : 104, alignment: .trailing)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, self.compact ? 0 : 14)
            .padding(.vertical, self.compact ? 4 : 11)

            if self.showsDivider {
                Divider()
                    .padding(.leading, self.compact ? 0 : 14)
                    .padding(.trailing, self.compact ? 0 : 14)
            }
        }
    }

    private var iconSize: CGFloat {
        self.compact ? 28 : 32
    }

    private var title: String {
        switch self.capability {
        case .appleScript: "Automation (AppleScript)"
        case .notifications: "Notifications"
        case .accessibility: "Accessibility"
        case .screenRecording: "Screen Recording"
        case .microphone: "Microphone"
        case .speechRecognition: "Speech Recognition"
        case .camera: "Camera"
        case .location: "Location"
        }
    }

    private var subtitle: String {
        switch self.capability {
        case .appleScript:
            "Control other apps (e.g. Terminal) for automation actions"
        case .notifications: "Show desktop alerts for agent activity"
        case .accessibility: "Control UI elements when an action requires it"
        case .screenRecording: "Capture the screen for context or screenshots"
        case .microphone: "Allow Voice Wake and audio capture"
        case .speechRecognition: "Transcribe Voice Wake trigger phrases on-device"
        case .camera: "Capture photos and video from the camera"
        case .location: "Share location when requested by the agent"
        }
    }

    private var icon: String {
        switch self.capability {
        case .appleScript: "applescript"
        case .notifications: "bell"
        case .accessibility: "hand.raised"
        case .screenRecording: "display"
        case .microphone: "mic"
        case .speechRecognition: "waveform"
        case .camera: "camera"
        case .location: "location"
        }
    }
}

#if DEBUG
struct PermissionsSettings_Previews: PreviewProvider {
    static var previews: some View {
        PermissionsSettings(
            status: [
                .appleScript: true,
                .notifications: true,
                .accessibility: false,
                .screenRecording: false,
                .microphone: true,
                .speechRecognition: false,
            ],
            refresh: {},
            showOnboarding: {})
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
