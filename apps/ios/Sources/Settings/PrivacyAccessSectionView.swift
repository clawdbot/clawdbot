import Contacts
import EventKit
import Photos
import SwiftUI
import UIKit

struct PrivacyGatewayPermissionSnapshot: Equatable {
    let contacts: Bool
    let photos: Bool
    let calendar: Bool
    let reminders: Bool

    init(
        contactsStatus: CNAuthorizationStatus,
        photosStatus: PHAuthorizationStatus,
        calendarStatus: EKAuthorizationStatus,
        remindersStatus: EKAuthorizationStatus)
    {
        self.contacts = contactsStatus == .authorized || contactsStatus == .limited
        self.photos = PhotoLibraryAccess.canRead(photosStatus)
        self.calendar = Self.hasReadableEventKitAccess(calendarStatus)
        self.reminders = Self.hasReadableEventKitAccess(remindersStatus)
    }

    private static func hasReadableEventKitAccess(_ status: EKAuthorizationStatus) -> Bool {
        status == .fullAccess
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
    @State private var requestingIdentifiers: Set<String> = []

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        DisclosureGroup {
            self.contactsRow
            self.photosRow
            self.calendarAddRow
            self.calendarViewRow
            self.remindersRow
            self.healthRow

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

    private var contactsRow: some View {
        let grant = DevicePermissionStatusMap.contacts(self.contactsStatus)
        return self.permissionRow(
            identifier: "contacts",
            kind: .contacts,
            detail: LocalizedStringResource("Search and add contacts from the assistant."),
            grant: grant,
            statusLabel: grant == .limited ? LocalizedStringResource("Limited") : nil,
            actionTitle: self.standardActionTitle(for: grant, limitedTitle: "Manage Access"),
            action: self.standardAction(identifier: "contacts", for: grant) {
                await self.requestContacts()
            })
    }

    private var photosRow: some View {
        let grant = DevicePermissionStatusMap.photos(self.photosStatus)
        return self.permissionRow(
            identifier: "photos",
            kind: .photos,
            detail: grant == .limited
                ? LocalizedStringResource("Read photos you select for the assistant.")
                : LocalizedStringResource("Read recent photos for the assistant."),
            grant: grant,
            statusLabel: grant == .limited ? LocalizedStringResource("Limited") : nil,
            actionTitle: self.standardActionTitle(for: grant, limitedTitle: "Manage Access"),
            action: self.standardAction(identifier: "photos", for: grant) {
                await self.updatePhotosStatus(PhotoLibraryAccess.requestReadWrite())
            })
    }

    private var calendarAddRow: some View {
        let grant = DevicePermissionStatusMap.eventKitWrite(self.calendarStatus)
        return self.permissionRow(
            identifier: "calendar-add",
            kind: .calendar,
            symbol: "calendar.badge.plus",
            title: LocalizedStringResource("Calendar (Add Events)"),
            detail: LocalizedStringResource("Add events with least privilege."),
            grant: grant,
            actionTitle: self.standardActionTitle(for: grant),
            action: self.standardAction(identifier: "calendar-add", for: grant) {
                _ = await self.requestCalendarWriteOnly()
                self.applyCalendarStatus()
            })
    }

    private var calendarViewRow: some View {
        let grant = DevicePermissionStatusMap.eventKitRead(self.calendarStatus)
        return self.permissionRow(
            identifier: "calendar-view",
            kind: .calendar,
            detail: LocalizedStringResource("List and read calendar events."),
            grant: grant,
            statusLabel: grant == .limited ? LocalizedStringResource("Add-Only") : nil,
            actionTitle: self.standardActionTitle(for: grant, limitedTitle: "Upgrade"),
            action: self.standardAction(identifier: "calendar-view", for: grant, limitedRequests: true) {
                _ = await self.requestCalendarFull()
                self.applyCalendarStatus()
            })
    }

    private var remindersRow: some View {
        let grant = DevicePermissionStatusMap.eventKitRead(self.remindersStatus)
        return self.permissionRow(
            identifier: "reminders",
            kind: .reminders,
            detail: LocalizedStringResource("List, add, and complete reminders."),
            grant: grant,
            statusLabel: grant == .limited ? LocalizedStringResource("Add-Only") : nil,
            actionTitle: self.standardActionTitle(for: grant, limitedTitle: "Upgrade"),
            action: self.standardAction(identifier: "reminders", for: grant, limitedRequests: true) {
                _ = await self.requestRemindersFull()
                self.remindersStatus = EKEventStore.authorizationStatus(for: .reminder)
                self.refreshAll()
            })
    }

    private var healthRow: some View {
        DevicePermissionRow(
            identifierPrefix: "privacy-access",
            identifier: "health",
            symbol: "heart.text.clipboard",
            tint: .red,
            title: LocalizedStringResource("Health Summaries"),
            detail: self.healthDetail,
            grant: self.healthGrant,
            isRequesting: self.requestingIdentifiers.contains("health"),
            actionTitle: self.healthActionTitle,
            action: HealthAuthorization.isAvailable ? { self.handleHealthAction() } : nil)
    }

    private func permissionRow(
        identifier: String,
        kind: DevicePermissionKind,
        symbol: String? = nil,
        title: LocalizedStringResource? = nil,
        detail: LocalizedStringResource,
        grant: DevicePermissionGrant,
        statusLabel: LocalizedStringResource? = nil,
        actionTitle: LocalizedStringResource?,
        action: (() -> Void)?) -> some View
    {
        DevicePermissionRow(
            identifierPrefix: "privacy-access",
            identifier: identifier,
            symbol: symbol ?? kind.symbol,
            tint: kind.tint,
            title: title ?? kind.title,
            detail: detail,
            grant: grant,
            isRequesting: self.requestingIdentifiers.contains(identifier),
            statusLabel: statusLabel,
            actionTitle: actionTitle,
            action: action)
    }

    private func standardActionTitle(
        for grant: DevicePermissionGrant,
        limitedTitle: LocalizedStringResource? = nil) -> LocalizedStringResource?
    {
        switch grant {
        case .notRequested:
            LocalizedStringResource("Allow")
        case .denied:
            LocalizedStringResource("Open Settings")
        case .limited:
            limitedTitle
        case .granted:
            nil
        }
    }

    /// `limitedRequests`: a limited grant re-requests (EventKit write-only → full)
    /// instead of routing to Settings like Photos/Contacts limited access does.
    private func standardAction(
        identifier: String,
        for grant: DevicePermissionGrant,
        limitedRequests: Bool = false,
        request: @escaping () async -> Void) -> (() -> Void)?
    {
        let run: () -> Void = {
            guard !self.requestingIdentifiers.contains(identifier) else { return }
            Task {
                self.requestingIdentifiers.insert(identifier)
                defer { self.requestingIdentifiers.remove(identifier) }
                await request()
            }
        }
        switch grant {
        case .notRequested:
            return run
        case .limited:
            return limitedRequests ? run : { self.openSettings() }
        case .denied:
            return { self.openSettings() }
        case .granted:
            return nil
        }
    }

    private func requestContacts() async {
        let granted = await PermissionRequestBridge.awaitRequest { completion in
            let store = CNContactStore()
            store.requestAccess(for: .contacts) { granted, _ in
                completion(granted)
            }
        }
        self.refreshAll()
        if granted {
            self.contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        }
    }

    private func applyCalendarStatus() {
        self.calendarStatus = EKEventStore.authorizationStatus(for: .event)
        self.refreshAll()
    }

    private var healthGrant: DevicePermissionGrant {
        guard HealthAuthorization.isAvailable else { return .denied }
        // HealthKit hides read authorization; this is only OpenClaw's sharing switch.
        return self.healthEnabled ? .granted : .notRequested
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

        guard !self.requestingIdentifiers.contains("health") else { return }
        Task { @MainActor in
            self.requestingIdentifiers.insert("health")
            defer { self.requestingIdentifiers.remove("health") }
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
        let previousPermissions = PrivacyGatewayPermissionSnapshot(
            contactsStatus: self.contactsStatus,
            photosStatus: self.photosStatus,
            calendarStatus: self.calendarStatus,
            remindersStatus: self.remindersStatus)
        let contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        let photosStatus = PhotoLibraryAccess.authorizationStatus()
        let calendarStatus = EKEventStore.authorizationStatus(for: .event)
        let remindersStatus = EKEventStore.authorizationStatus(for: .reminder)
        let currentPermissions = PrivacyGatewayPermissionSnapshot(
            contactsStatus: contactsStatus,
            photosStatus: photosStatus,
            calendarStatus: calendarStatus,
            remindersStatus: remindersStatus)

        self.contactsStatus = contactsStatus
        self.photosStatus = photosStatus
        self.calendarStatus = calendarStatus
        self.remindersStatus = remindersStatus
        self.healthEnabled = HealthAuthorization.isEnabled
        if previousPermissions != currentPermissions {
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        }
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
