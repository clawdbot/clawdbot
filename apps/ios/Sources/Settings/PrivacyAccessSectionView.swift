import Contacts
import EventKit
import SwiftUI
import UIKit

struct PrivacyAccessSectionView: View {
    @State private var contactsStatus: CNAuthorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
    @State private var calendarStatus: EKAuthorizationStatus = EKEventStore.authorizationStatus(for: .event)
    @State private var remindersStatus: EKAuthorizationStatus = EKEventStore.authorizationStatus(for: .reminder)

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        DisclosureGroup("Privacy & Access") {
            self.permissionRow(
                title: "Contacts",
                icon: "person.crop.circle",
                status: self.statusText(for: self.contactsStatus),
                detail: "Search and add contacts from the assistant.",
                actionTitle: self.actionTitle(for: self.contactsStatus),
                action: self.handleContactsAction)

            self.permissionRow(
                title: "Calendar (Add Events)",
                icon: "calendar.badge.plus",
                status: self.calendarWriteStatusText,
                detail: "Add events with least privilege.",
                actionTitle: self.calendarWriteActionTitle,
                action: self.handleCalendarWriteAction)

            self.permissionRow(
                title: "Calendar (View Events)",
                icon: "calendar",
                status: self.calendarReadStatusText,
                detail: "List and read calendar events.",
                actionTitle: self.calendarReadActionTitle,
                action: self.handleCalendarReadAction)

            self.permissionRow(
                title: "Reminders",
                icon: "checklist",
                status: self.remindersStatusText,
                detail: "List, add, and complete reminders.",
                actionTitle: self.remindersActionTitle,
                action: self.handleRemindersAction)
        }
        .onAppear { self.refreshAll() }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active {
                self.refreshAll()
            }
        }
    }

    private func permissionRow(
        title: String,
        icon: String,
        status: String,
        detail: String,
        actionTitle: String?,
        action: (() -> Void)?) -> some View
    {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(title, systemImage: icon)
                Spacer()
                Text(status)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(self.statusColor(for: status))
            }
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.footnote)
                    .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 2)
    }

    private func statusColor(for status: String) -> Color {
        switch status {
        case "Allowed":
            .green
        case "Not Set":
            .orange
        case "Add-Only":
            .yellow
        default:
            .red
        }
    }

    private func statusText(for cnStatus: CNAuthorizationStatus) -> String {
        switch cnStatus {
        case .authorized, .limited:
            "Allowed"
        case .notDetermined:
            "Not Set"
        case .denied, .restricted:
            "Not Allowed"
        @unknown default:
            "Unknown"
        }
    }

    private func actionTitle(for cnStatus: CNAuthorizationStatus) -> String? {
        switch cnStatus {
        case .notDetermined:
            "Request Access"
        case .denied, .restricted:
            "Open Settings"
        default:
            nil
        }
    }

    private func handleContactsAction() {
        switch self.contactsStatus {
        case .notDetermined:
            Task {
                _ = await PermissionRequestBridge.awaitRequest { completion in
                    let store = CNContactStore()
                    store.requestAccess(for: .contacts) { granted, _ in
                        completion(granted)
                    }
                }
                await MainActor.run { self.refreshAll() }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var calendarWriteStatusText: String {
        switch self.calendarStatus {
        case .authorized, .fullAccess, .writeOnly:
            "Allowed"
        case .notDetermined:
            "Not Set"
        case .denied, .restricted:
            "Not Allowed"
        @unknown default:
            "Unknown"
        }
    }

    private var calendarWriteActionTitle: String? {
        switch self.calendarStatus {
        case .notDetermined:
            "Request Access"
        case .denied, .restricted:
            "Open Settings"
        default:
            nil
        }
    }

    private func handleCalendarWriteAction() {
        switch self.calendarStatus {
        case .notDetermined:
            Task {
                _ = await self.requestCalendarWriteOnly()
                await MainActor.run { self.refreshAll() }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var calendarReadStatusText: String {
        switch self.calendarStatus {
        case .authorized, .fullAccess:
            "Allowed"
        case .writeOnly:
            "Add-Only"
        case .notDetermined:
            "Not Set"
        case .denied, .restricted:
            "Not Allowed"
        @unknown default:
            "Unknown"
        }
    }

    private var calendarReadActionTitle: String? {
        switch self.calendarStatus {
        case .notDetermined:
            "Request Full Access"
        case .writeOnly:
            "Upgrade to Full Access"
        case .denied, .restricted:
            "Open Settings"
        default:
            nil
        }
    }

    private func handleCalendarReadAction() {
        switch self.calendarStatus {
        case .notDetermined, .writeOnly:
            Task {
                _ = await self.requestCalendarFull()
                await MainActor.run { self.refreshAll() }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var remindersStatusText: String {
        switch self.remindersStatus {
        case .authorized, .fullAccess:
            "Allowed"
        case .writeOnly:
            "Add-Only"
        case .notDetermined:
            "Not Set"
        case .denied, .restricted:
            "Not Allowed"
        @unknown default:
            "Unknown"
        }
    }

    private var remindersActionTitle: String? {
        switch self.remindersStatus {
        case .notDetermined:
            "Request Access"
        case .writeOnly:
            "Upgrade to Full Access"
        case .denied, .restricted:
            "Open Settings"
        default:
            nil
        }
    }

    private func handleRemindersAction() {
        switch self.remindersStatus {
        case .notDetermined, .writeOnly:
            Task {
                _ = await self.requestRemindersFull()
                await MainActor.run { self.refreshAll() }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private func refreshAll() {
        self.contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        self.calendarStatus = EKEventStore.authorizationStatus(for: .event)
        self.remindersStatus = EKEventStore.authorizationStatus(for: .reminder)
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
