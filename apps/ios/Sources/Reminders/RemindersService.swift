import EventKit
import Foundation
import OpenClawKit

final class RemindersService: RemindersServicing {
    private let reminderAuthorizationStatus: @Sendable () -> EKAuthorizationStatus

    init(
        reminderAuthorizationStatus: @escaping @Sendable () -> EKAuthorizationStatus = {
            EKEventStore.authorizationStatus(for: .reminder)
        })
    {
        self.reminderAuthorizationStatus = reminderAuthorizationStatus
    }

    func list(params: OpenClawRemindersListParams) async throws -> OpenClawRemindersListPayload {
        let status = self.reminderAuthorizationStatus()
        guard EventKitAuthorization.allowsRead(status: status) else {
            throw NSError(domain: "Reminders", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "REMINDERS_PERMISSION_REQUIRED: grant Reminders permission",
            ])
        }

        let store = EKEventStore()
        let limit = max(1, min(params.limit ?? 50, 500))
        let statusFilter = params.status ?? .incomplete

        let predicate = store.predicateForReminders(in: nil)
        let payload: [OpenClawReminderPayload] = try await withCheckedThrowingContinuation { cont in
            store.fetchReminders(matching: predicate) { items in
                let formatter = ISO8601DateFormatter()
                let filtered = (items ?? []).filter { reminder in
                    switch statusFilter {
                    case .all:
                        true
                    case .completed:
                        reminder.isCompleted
                    case .incomplete:
                        !reminder.isCompleted
                    }
                }
                let selected = Array(filtered.prefix(limit))
                let payload = selected.map { reminder in
                    let due = Self.date(fromDueComponents: reminder.dueDateComponents)
                    return OpenClawReminderPayload(
                        identifier: reminder.calendarItemIdentifier,
                        title: reminder.title,
                        dueISO: due.map { formatter.string(from: $0) },
                        completed: reminder.isCompleted,
                        listName: reminder.calendar.title)
                }
                cont.resume(returning: payload)
            }
        }

        return OpenClawRemindersListPayload(reminders: payload)
    }

    func add(params: OpenClawRemindersAddParams) async throws -> OpenClawRemindersAddPayload {
        let status = self.reminderAuthorizationStatus()
        guard EventKitAuthorization.allowsWrite(status: status) else {
            throw NSError(domain: "Reminders", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "REMINDERS_PERMISSION_REQUIRED: grant Reminders permission",
            ])
        }

        let store = EKEventStore()
        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            throw NSError(domain: "Reminders", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "REMINDERS_INVALID: title required",
            ])
        }

        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        if let notes = params.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
            reminder.notes = notes
        }
        reminder.calendar = try Self.resolveList(
            store: store,
            listId: params.listId,
            listName: params.listName)

        try Self.applyDueISO(params.dueISO, to: reminder)

        try store.save(reminder, commit: true)

        let formatter = ISO8601DateFormatter()
        let due = Self.date(fromDueComponents: reminder.dueDateComponents)
        let payload = OpenClawReminderPayload(
            identifier: reminder.calendarItemIdentifier,
            title: reminder.title,
            dueISO: due.map { formatter.string(from: $0) },
            completed: reminder.isCompleted,
            listName: reminder.calendar.title)

        return OpenClawRemindersAddPayload(reminder: payload)
    }

    static func applyDueISO(
        _ rawDueISO: String?,
        to reminder: EKReminder,
        timeZone: TimeZone = .current) throws
    {
        guard let dueISO = rawDueISO?.trimmingCharacters(in: .whitespacesAndNewlines), !dueISO.isEmpty else {
            return
        }
        let formatter = ISO8601DateFormatter()
        guard let dueDate = formatter.date(from: dueISO) else {
            throw NSError(domain: "Reminders", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "REMINDERS_INVALID: dueISO must be ISO-8601",
            ])
        }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var components = calendar.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: dueDate)
        components.calendar = calendar
        components.timeZone = timeZone
        // EventKit requires a Gregorian due calendar and a matching start date on iOS.
        reminder.startDateComponents = components
        reminder.dueDateComponents = components
        reminder.addAlarm(EKAlarm(absoluteDate: dueDate))
    }

    static func date(fromDueComponents components: DateComponents?) -> Date? {
        components?.date
    }

    private static func resolveList(
        store: EKEventStore,
        listId: String?,
        listName: String?) throws -> EKCalendar
    {
        if let id = listId?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty,
           let calendar = store.calendar(withIdentifier: id)
        {
            return calendar
        }

        if let title = listName?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            if let calendar = store.calendars(for: .reminder).first(where: {
                $0.title.compare(title, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
            }) {
                return calendar
            }
            throw NSError(domain: "Reminders", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "REMINDERS_LIST_NOT_FOUND: no list named \(title)",
            ])
        }

        if let fallback = store.defaultCalendarForNewReminders() {
            return fallback
        }

        throw NSError(domain: "Reminders", code: 6, userInfo: [
            NSLocalizedDescriptionKey: "REMINDERS_LIST_NOT_FOUND: no default list",
        ])
    }
}
