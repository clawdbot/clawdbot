import Contacts
import EventKit
import Photos
import SwiftUI
import UIKit

private enum PrivacyPermissionStatus {
    case addOnly
    case allowed
    case enabled
    case limited
    case notAllowed
    case notSet
    case unknown

    var resource: LocalizedStringResource {
        switch self {
        case .addOnly: LocalizedStringResource("Add-Only")
        case .allowed: LocalizedStringResource("Allowed")
        case .enabled: LocalizedStringResource("Enabled")
        case .limited: LocalizedStringResource("Limited")
        case .notAllowed: LocalizedStringResource("Not Allowed")
        case .notSet: LocalizedStringResource("Not Set")
        case .unknown: LocalizedStringResource("Unknown")
        }
    }

    var tone: OpenClawStatusTone {
        switch self {
        case .allowed, .enabled, .limited:
            .ok
        case .addOnly, .notSet:
            .warn
        case .notAllowed, .unknown:
            .danger
        }
    }
}

struct PrivacyAccessSectionView: View {
    @Environment(GatewayConnectionController.self) private var gatewayController
    @State private var contactsStatus: CNAuthorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
    @State private var calendarStatus: EKAuthorizationStatus = EKEventStore.authorizationStatus(for: .event)
    @State private var remindersStatus: EKAuthorizationStatus = EKEventStore.authorizationStatus(for: .reminder)
    @State private var photosStatus = PhotoLibraryAccess.authorizationStatus()
    @State private var healthEnabled = HealthAuthorization.isEnabled
    @State private var healthError: String?

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        DisclosureGroup {
            self.permissionRow(
                identifier: "contacts",
                title: "Contacts",
                icon: "person.crop.circle",
                status: self.permissionStatus(for: self.contactsStatus),
                detail: "Search and add contacts from the assistant.",
                actionTitle: self.actionTitle(for: self.contactsStatus),
                action: self.handleContactsAction)

            self.permissionRow(
                identifier: "photos",
                title: "Photos",
                icon: "photo.on.rectangle",
                status: self.photosPermissionStatus,
                detail: self.photosDetail,
                actionTitle: self.photosActionTitle,
                action: self.handlePhotosAction)

            self.permissionRow(
                identifier: "calendar-add",
                title: "Calendar (Add Events)",
                icon: "calendar.badge.plus",
                status: self.calendarWritePermissionStatus,
                detail: "Add events with least privilege.",
                actionTitle: self.calendarWriteActionTitle,
                action: self.handleCalendarWriteAction)

            self.permissionRow(
                identifier: "calendar-view",
                title: "Calendar (View Events)",
                icon: "calendar",
                status: self.calendarReadPermissionStatus,
                detail: "List and read calendar events.",
                actionTitle: self.calendarReadActionTitle,
                action: self.handleCalendarReadAction)

            self.permissionRow(
                identifier: "reminders",
                title: "Reminders",
                icon: "checklist",
                status: self.remindersPermissionStatus,
                detail: "List, add, and complete reminders.",
                actionTitle: self.remindersActionTitle,
                action: self.handleRemindersAction)

            self.permissionRow(
                identifier: "health",
                title: "Health Summaries",
                icon: "heart.text.clipboard",
                status: self.healthPermissionStatus,
                detail: self.healthDetail,
                actionTitle: self.healthActionTitle,
                action: self.handleHealthAction)

            if let healthError {
                Text(healthError)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(OpenClawBrand.danger)
            }
        } label: {
            Text("Privacy & Access")
                .font(OpenClawType.subheadSemiBold)
        }
        .font(OpenClawType.body)
        .onAppear { self.refreshAll() }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active {
                self.refreshAll()
            }
        }
    }

    private func permissionRow(
        identifier: String,
        title: LocalizedStringResource,
        icon: String,
        status: PrivacyPermissionStatus,
        detail: LocalizedStringResource,
        actionTitle: LocalizedStringResource?,
        action: (() -> Void)?) -> some View
    {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label {
                    Text(title)
                } icon: {
                    Image(systemName: icon)
                }
                .font(OpenClawType.subheadSemiBold)
                Spacer()
                OpenClawStatusBadge(
                    label: .verbatim(String(localized: status.resource)),
                    tone: status.tone)
                    .accessibilityIdentifier("privacy-access-\(identifier)-status")
            }
            Text(detail)
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(OpenClawType.footnoteSemiBold)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("privacy-access-\(identifier)-action")
            }
        }
        .padding(.vertical, 2)
    }

    private func permissionStatus(for cnStatus: CNAuthorizationStatus) -> PrivacyPermissionStatus {
        switch cnStatus {
        case .authorized, .limited:
            .allowed
        case .notDetermined:
            .notSet
        case .denied, .restricted:
            .notAllowed
        @unknown default:
            .unknown
        }
    }

    private func actionTitle(for cnStatus: CNAuthorizationStatus) -> LocalizedStringResource? {
        switch cnStatus {
        case .notDetermined:
            LocalizedStringResource("Request Access")
        case .denied, .restricted:
            LocalizedStringResource("Open Settings")
        default:
            nil
        }
    }

    private var photosPermissionStatus: PrivacyPermissionStatus {
        switch self.photosStatus {
        case .authorized:
            .allowed
        case .limited:
            .limited
        case .notDetermined:
            .notSet
        case .denied, .restricted:
            .notAllowed
        @unknown default:
            .unknown
        }
    }

    private var photosDetail: LocalizedStringResource {
        self.photosStatus == .limited
            ? LocalizedStringResource("Read photos you select for the assistant.")
            : LocalizedStringResource("Read recent photos for the assistant.")
    }

    private var photosActionTitle: LocalizedStringResource? {
        switch self.photosStatus {
        case .notDetermined:
            LocalizedStringResource("Request Access")
        case .limited:
            LocalizedStringResource("Manage Access")
        case .denied, .restricted:
            LocalizedStringResource("Open Settings")
        default:
            nil
        }
    }

    private func handlePhotosAction() {
        switch self.photosStatus {
        case .notDetermined:
            Task {
                let status = await PhotoLibraryAccess.requestReadWrite()
                await MainActor.run { self.updatePhotosStatus(status) }
            }
        case .limited, .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private func handleContactsAction() {
        switch self.contactsStatus {
        case .notDetermined:
            Task {
                let granted = await PermissionRequestBridge.awaitRequest { completion in
                    let store = CNContactStore()
                    store.requestAccess(for: .contacts) { granted, _ in
                        completion(granted)
                    }
                }
                await MainActor.run {
                    self.refreshAll()
                    if granted {
                        self.contactsStatus = .authorized
                    }
                }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var calendarWritePermissionStatus: PrivacyPermissionStatus {
        switch self.calendarStatus {
        case .authorized, .fullAccess, .writeOnly:
            .allowed
        case .notDetermined:
            .notSet
        case .denied, .restricted:
            .notAllowed
        @unknown default:
            .unknown
        }
    }

    private var calendarWriteActionTitle: LocalizedStringResource? {
        switch self.calendarStatus {
        case .notDetermined:
            LocalizedStringResource("Request Access")
        case .denied, .restricted:
            LocalizedStringResource("Open Settings")
        default:
            nil
        }
    }

    private func handleCalendarWriteAction() {
        switch self.calendarStatus {
        case .notDetermined:
            Task {
                let granted = await self.requestCalendarWriteOnly()
                await MainActor.run {
                    self.refreshAll()
                    if granted {
                        self.calendarStatus = .writeOnly
                    }
                }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var calendarReadPermissionStatus: PrivacyPermissionStatus {
        switch self.calendarStatus {
        case .authorized, .fullAccess:
            .allowed
        case .writeOnly:
            .addOnly
        case .notDetermined:
            .notSet
        case .denied, .restricted:
            .notAllowed
        @unknown default:
            .unknown
        }
    }

    private var calendarReadActionTitle: LocalizedStringResource? {
        switch self.calendarStatus {
        case .notDetermined:
            LocalizedStringResource("Request Full Access")
        case .writeOnly:
            LocalizedStringResource("Upgrade to Full Access")
        case .denied, .restricted:
            LocalizedStringResource("Open Settings")
        default:
            nil
        }
    }

    private func handleCalendarReadAction() {
        switch self.calendarStatus {
        case .notDetermined, .writeOnly:
            Task {
                let granted = await self.requestCalendarFull()
                await MainActor.run {
                    self.refreshAll()
                    if granted {
                        self.calendarStatus = .fullAccess
                    }
                }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var remindersPermissionStatus: PrivacyPermissionStatus {
        switch self.remindersStatus {
        case .authorized, .fullAccess:
            .allowed
        case .writeOnly:
            .addOnly
        case .notDetermined:
            .notSet
        case .denied, .restricted:
            .notAllowed
        @unknown default:
            .unknown
        }
    }

    private var remindersActionTitle: LocalizedStringResource? {
        switch self.remindersStatus {
        case .notDetermined:
            LocalizedStringResource("Request Access")
        case .writeOnly:
            LocalizedStringResource("Upgrade to Full Access")
        case .denied, .restricted:
            LocalizedStringResource("Open Settings")
        default:
            nil
        }
    }

    private func handleRemindersAction() {
        switch self.remindersStatus {
        case .notDetermined, .writeOnly:
            Task {
                let granted = await self.requestRemindersFull()
                await MainActor.run {
                    self.refreshAll()
                    if granted {
                        self.remindersStatus = .fullAccess
                    }
                }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var healthPermissionStatus: PrivacyPermissionStatus {
        guard HealthAuthorization.isAvailable else { return .notAllowed }
        // HealthKit hides read authorization; this is only OpenClaw's sharing switch.
        return self.healthEnabled ? .enabled : .notSet
    }

    private var healthDetail: LocalizedStringResource {
        if !HealthAuthorization.isAvailable {
            return LocalizedStringResource("Health data is unavailable on this device.")
        }
        if self.healthEnabled {
            return LocalizedStringResource(
                """
                Shares only requested step, sleep, resting heart rate, and workout aggregates through your Gateway \
                with your configured AI provider. Results may remain in chat history.
                """)
        }
        return LocalizedStringResource(
            """
            Off by default. Enabling lets requested aggregates leave this iPhone through your Gateway and configured \
            AI provider.
            """)
    }

    private var healthActionTitle: LocalizedStringResource? {
        guard HealthAuthorization.isAvailable else { return nil }
        return self.healthEnabled
            ? LocalizedStringResource("Disable")
            : LocalizedStringResource("Enable & Share Summaries")
    }

    private func handleHealthAction() {
        if self.healthEnabled {
            HealthAuthorization.disable()
            self.healthEnabled = false
            self.healthError = nil
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            return
        }

        Task { @MainActor in
            do {
                try await HealthAuthorization.enable()
                self.healthEnabled = true
                self.healthError = nil
                self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            } catch {
                self.healthError = error.localizedDescription
            }
        }
    }

    private func refreshAll() {
        self.contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        self.calendarStatus = EKEventStore.authorizationStatus(for: .event)
        self.remindersStatus = EKEventStore.authorizationStatus(for: .reminder)
        self.updatePhotosStatus(PhotoLibraryAccess.authorizationStatus())
        self.healthEnabled = HealthAuthorization.isEnabled
    }

    private func updatePhotosStatus(_ status: PHAuthorizationStatus) {
        let changed = self.photosStatus != status
        self.photosStatus = status
        if changed {
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        }
    }

    private func requestCalendarWriteOnly() async -> Bool {
        await PermissionRequestBridge.awaitRequest { completion in
            let store = EKEventStore()
            store.requestWriteOnlyAccessToEvents { granted, _ in
                completion(granted)
            }
        }
    }

    private func requestCalendarFull() async -> Bool {
        await PermissionRequestBridge.awaitRequest { completion in
            let store = EKEventStore()
            store.requestFullAccessToEvents { granted, _ in
                completion(granted)
            }
        }
    }

    private func requestRemindersFull() async -> Bool {
        await PermissionRequestBridge.awaitRequest { completion in
            let store = EKEventStore()
            store.requestFullAccessToReminders { granted, _ in
                completion(granted)
            }
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
