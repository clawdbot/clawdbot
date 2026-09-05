import Contacts
import EventKit
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite struct NodeServicePermissionTests {
    @Test func `calendar events do not request access from node invoke`() async throws {
        let service = CalendarService(eventAuthorizationStatus: { .notDetermined })

        await expectPermissionError(
            code: "CALENDAR_PERMISSION_REQUIRED",
            performing: {
                _ = try await service.events(params: OpenClawCalendarEventsParams())
            })
    }

    @Test func `calendar add does not request access from node invoke`() async throws {
        let service = CalendarService(eventAuthorizationStatus: { .notDetermined })

        await expectPermissionError(
            code: "CALENDAR_PERMISSION_REQUIRED",
            performing: {
                _ = try await service.add(params: calendarAddParams())
            })
    }

    @Test func `reminders list does not request access from node invoke`() async throws {
        let service = RemindersService(reminderAuthorizationStatus: { .notDetermined })

        await expectPermissionError(
            code: "REMINDERS_PERMISSION_REQUIRED",
            performing: {
                _ = try await service.list(params: OpenClawRemindersListParams())
            })
    }

    @Test func `reminders add does not request access from node invoke`() async throws {
        let service = RemindersService(reminderAuthorizationStatus: { .notDetermined })

        await expectPermissionError(
            code: "REMINDERS_PERMISSION_REQUIRED",
            performing: {
                _ = try await service.add(params: OpenClawRemindersAddParams(title: "Follow up"))
            })
    }

    @Test func `contacts search does not request access from node invoke`() async throws {
        let service = ContactsService(authorizationStatus: { .notDetermined })

        await expectPermissionError(
            code: "CONTACTS_PERMISSION_REQUIRED",
            performing: {
                _ = try await service.search(params: OpenClawContactsSearchParams(query: "Ada"))
            })
    }

    @Test func `contacts add does not request access from node invoke`() async throws {
        let service = ContactsService(authorizationStatus: { .notDetermined })

        await expectPermissionError(
            code: "CONTACTS_PERMISSION_REQUIRED",
            performing: {
                _ = try await service.add(params: OpenClawContactsAddParams(givenName: "Ada"))
            })
    }
}

private func calendarAddParams() -> OpenClawCalendarAddParams {
    OpenClawCalendarAddParams(
        title: "Review",
        startISO: "2026-07-03T09:00:00Z",
        endISO: "2026-07-03T09:30:00Z")
}

private func expectPermissionError(
    code: String,
    performing operation: () async throws -> Void) async
{
    do {
        try await operation()
        Issue.record("Expected \(code)")
    } catch {
        #expect(error.localizedDescription.contains(code))
    }
}
