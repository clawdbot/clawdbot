import EventKit
import Foundation
import OpenClawKit

final class CalendarService: CalendarServicing {
    func events(params: OpenClawCalendarEventsParams) async throws -> OpenClawCalendarEventsPayload {
        let status = EKEventStore.authorizationStatus(for: .event)
        let authorized: Bool = if status == .notDetermined || status == .writeOnly {
            await Self.requestFullEventAccess()
        } else {
            EventKitAuthorization.allowsRead(status: status)
        }
        guard authorized else {
            throw NSError(domain: "Calendar", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_PERMISSION_REQUIRED: grant Calendar permission",
            ])
        }

        let store = EKEventStore()
        let (start, end) = Self.resolveRange(
            startISO: params.startISO,
            endISO: params.endISO)
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        let events = store.events(matching: predicate)
        let limit = max(1, min(params.limit ?? 50, 500))
        let selected = Array(events.prefix(limit))

        let formatter = ISO8601DateFormatter()
        let payload = selected.map { event in
            OpenClawCalendarEventPayload(
                identifier: event.eventIdentifier ?? UUID().uuidString,
                title: event.title ?? "(untitled)",
                startISO: formatter.string(from: event.startDate),
                endISO: formatter.string(from: event.endDate),
                isAllDay: event.isAllDay,
                location: event.location,
                calendarTitle: event.calendar.title)
        }

        return OpenClawCalendarEventsPayload(events: payload)
    }

    func add(params: OpenClawCalendarAddParams) async throws -> OpenClawCalendarAddPayload {
        let status = EKEventStore.authorizationStatus(for: .event)
        let authorized: Bool = if status == .notDetermined {
            await Self.requestWriteOnlyEventAccess()
        } else {
            EventKitAuthorization.allowsWrite(status: status)
        }
        guard authorized else {
            throw NSError(domain: "Calendar", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_PERMISSION_REQUIRED: grant Calendar permission",
            ])
        }

        let store = EKEventStore()
        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            throw NSError(domain: "Calendar", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_INVALID: title required",
            ])
        }

        let formatter = ISO8601DateFormatter()
        guard let start = formatter.date(from: params.startISO) else {
            throw NSError(domain: "Calendar", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_INVALID: startISO required",
            ])
        }
        guard let end = formatter.date(from: params.endISO) else {
            throw NSError(domain: "Calendar", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_INVALID: endISO required",
            ])
        }

        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start
        event.endDate = end
        event.isAllDay = params.isAllDay ?? false
        if let location = params.location?.trimmingCharacters(in: .whitespacesAndNewlines), !location.isEmpty {
            event.location = location
        }
        if let notes = params.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
            event.notes = notes
        }
        event.calendar = try Self.resolveCalendar(
            store: store,
            calendarId: params.calendarId,
            calendarTitle: params.calendarTitle)

        try store.save(event, span: .thisEvent)

        let payload = OpenClawCalendarEventPayload(
            identifier: event.eventIdentifier ?? UUID().uuidString,
            title: event.title ?? title,
            startISO: formatter.string(from: event.startDate),
            endISO: formatter.string(from: event.endDate),
            isAllDay: event.isAllDay,
            location: event.location,
            calendarTitle: event.calendar.title)

        return OpenClawCalendarAddPayload(event: payload)
    }

    private static func requestFullEventAccess() async -> Bool {
        await PermissionRequestBridge.awaitRequest { completion in
            let store = EKEventStore()
            store.requestFullAccessToEvents { granted, _ in
                completion(granted)
            }
        }
    }

    private static func requestWriteOnlyEventAccess() async -> Bool {
        await PermissionRequestBridge.awaitRequest { completion in
            let store = EKEventStore()
            store.requestWriteOnlyAccessToEvents { granted, _ in
                completion(granted)
            }
        }
    }

    private static func resolveCalendar(
        store: EKEventStore,
        calendarId: String?,
        calendarTitle: String?) throws -> EKCalendar
    {
        if let id = calendarId?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty,
           let calendar = store.calendar(withIdentifier: id)
        {
            return calendar
        }

        if let title = calendarTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            if let calendar = store.calendars(for: .event).first(where: {
                $0.title.compare(title, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
            }) {
                return calendar
            }
            throw NSError(domain: "Calendar", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_NOT_FOUND: no calendar named \(title)",
            ])
        }

        if let fallback = store.defaultCalendarForNewEvents {
            return fallback
        }

        throw NSError(domain: "Calendar", code: 7, userInfo: [
            NSLocalizedDescriptionKey: "CALENDAR_NOT_FOUND: no default calendar",
        ])
    }

    private static func resolveRange(startISO: String?, endISO: String?) -> (Date, Date) {
        let formatter = ISO8601DateFormatter()
        let start = startISO.flatMap { formatter.date(from: $0) } ?? Date()
        let end = endISO.flatMap { formatter.date(from: $0) } ?? start.addingTimeInterval(7 * 24 * 3600)
        return (start, end)
    }
}
