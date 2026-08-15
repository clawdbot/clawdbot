import AppKit
import OpenClawIPC
import SwiftUI

struct ComputerControlReadinessRow: Equatable, Identifiable {
    enum ID: Hashable {
        case provider
        case accessibility
        case screenRecording
        case cuaDaemon
    }

    enum Status: Equatable {
        case available
        case granted
        case running
        case unavailable
        case notGranted
        case notReady
        case unknown

        var text: String {
            switch self {
            case .available: String(localized: "Available")
            case .granted: String(localized: "Granted")
            case .running: String(localized: "Running")
            case .unavailable: String(localized: "Unavailable")
            case .notGranted: String(localized: "Not granted")
            case .notReady: String(localized: "Not ready")
            case .unknown: String(localized: "Unknown")
            }
        }

        var icon: String {
            switch self {
            case .available, .granted, .running: "checkmark.circle"
            case .unavailable, .notGranted, .notReady: "exclamationmark.circle"
            case .unknown: "questionmark.circle"
            }
        }

        var color: Color {
            switch self {
            case .available, .granted, .running: .green
            case .unavailable, .notGranted, .notReady: .orange
            case .unknown: .secondary
            }
        }
    }

    let id: ID
    let title: String
    let status: Status
    let nextStep: String?
}

enum ComputerControlReadinessPresentation {
    static func rows(
        provider: ComputerControlProvider,
        cuaDriverAvailable: Bool,
        permissions: [Capability: CapabilityAuthorizationStatus],
        cuaDaemonReady: Bool?) -> [ComputerControlReadinessRow]
    {
        let providerAvailable = provider == .peekaboo || cuaDriverAvailable
        var rows = [
            ComputerControlReadinessRow(
                id: .provider,
                title: provider.displayName,
                status: providerAvailable ? .available : .unavailable,
                nextStep: providerAvailable
                    ? nil
                    : String(localized: "Use a packaged OpenClaw build that includes the CUA driver.")),
            self.permissionRow(
                id: .accessibility,
                title: String(localized: "Accessibility"),
                status: permissions[.accessibility],
                nextStep: String(
                    localized: """
                    Grant OpenClaw in System Settings → Privacy & Security → Accessibility, then reopen it.
                    """)),
            self.permissionRow(
                id: .screenRecording,
                title: String(localized: "Screen Recording"),
                status: permissions[.screenRecording],
                nextStep: String(
                    localized: """
                    Grant OpenClaw in System Settings → Privacy & Security → Screen Recording, then reopen it.
                    """)),
        ]

        if provider == .cua {
            let status: ComputerControlReadinessRow.Status = if !cuaDriverAvailable {
                .unavailable
            } else if let cuaDaemonReady {
                cuaDaemonReady ? .running : .notReady
            } else {
                .unknown
            }
            let nextStep: String? = switch status {
            case .running:
                nil
            case .unavailable:
                String(localized: "Use a packaged OpenClaw build that includes the CUA driver.")
            case .notReady:
                String(localized: "Reopen OpenClaw to retry the embedded CUA daemon.")
            case .unknown:
                String(localized: "Keep OpenClaw open while it checks the embedded CUA daemon.")
            case .available, .granted, .notGranted:
                nil
            }
            rows.append(ComputerControlReadinessRow(
                id: .cuaDaemon,
                title: String(localized: "CUA daemon"),
                status: status,
                nextStep: nextStep))
        }
        return rows
    }

    private static func permissionRow(
        id: ComputerControlReadinessRow.ID,
        title: String,
        status: CapabilityAuthorizationStatus?,
        nextStep: String) -> ComputerControlReadinessRow
    {
        switch status ?? .unknown {
        case .granted:
            ComputerControlReadinessRow(id: id, title: title, status: .granted, nextStep: nil)
        case .notGranted:
            ComputerControlReadinessRow(id: id, title: title, status: .notGranted, nextStep: nextStep)
        case .unknown:
            ComputerControlReadinessRow(id: id, title: title, status: .unknown, nextStep: nextStep)
        }
    }
}

@MainActor
struct ComputerControlReadinessView: View {
    let provider: ComputerControlProvider
    let cuaDriverAvailable: Bool

    @State private var permissions: [Capability: CapabilityAuthorizationStatus] = [:]
    @State private var cuaDaemonReady: Bool?

    init(provider: ComputerControlProvider, cuaDriverAvailable: Bool) {
        self.provider = provider
        self.cuaDriverAvailable = cuaDriverAvailable
        self._cuaDaemonReady = State(initialValue: Self.cuaDaemonReadiness(
            provider: provider,
            cuaDriverAvailable: cuaDriverAvailable))
    }

    var body: some View {
        ForEach(self.rows) { row in
            SettingsCardRow(
                title: .verbatim(row.title),
                subtitle: row.nextStep.map(SettingsTextValue.verbatim))
            {
                Label {
                    Text(verbatim: row.status.text)
                } icon: {
                    Image(systemName: row.status.icon)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(row.status.color)
            }
        }
        .task(id: self.provider) {
            await self.refreshPermissions()
            self.refreshCuaDaemonReadiness()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await self.refreshPermissions() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openclawPermissionsChanged)) { _ in
            Task { await self.refreshPermissions() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openclawCuaDriverAvailabilityChanged)) { _ in
            self.refreshCuaDaemonReadiness()
        }
    }

    private var rows: [ComputerControlReadinessRow] {
        ComputerControlReadinessPresentation.rows(
            provider: self.provider,
            cuaDriverAvailable: self.cuaDriverAvailable,
            permissions: self.permissions,
            cuaDaemonReady: self.cuaDaemonReady)
    }

    private func refreshPermissions() async {
        self.permissions = await PermissionManager.authorizationStatus([.accessibility, .screenRecording])
    }

    private func refreshCuaDaemonReadiness() {
        self.cuaDaemonReady = Self.cuaDaemonReadiness(
            provider: self.provider,
            cuaDriverAvailable: self.cuaDriverAvailable)
    }

    private static func cuaDaemonReadiness(
        provider: ComputerControlProvider,
        cuaDriverAvailable: Bool) -> Bool?
    {
        guard provider == .cua, cuaDriverAvailable else { return nil }
        return CuaDriverHostCoordinator.shared.workerEndpoint != nil
    }
}
