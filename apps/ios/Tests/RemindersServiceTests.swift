import EventKit
import Foundation
import Testing
@testable import OpenClaw

struct RemindersServiceTests {
    @Test func `due date uses Gregorian components and an absolute alarm`() throws {
        let dueISO = "2026-07-18T10:15:30+09:00"
        let expectedDate = try #require(ISO8601DateFormatter().date(from: dueISO))
        let timeZone = try #require(TimeZone(secondsFromGMT: 9 * 60 * 60))
        let reminder = EKReminder(eventStore: EKEventStore())

        try RemindersService.applyDueISO(dueISO, to: reminder, timeZone: timeZone)

        let start = try #require(reminder.startDateComponents)
        let due = try #require(reminder.dueDateComponents)
        let startCalendar = try #require(start.calendar)
        let dueCalendar = try #require(due.calendar)
        let reconstructedStartDate = try #require(startCalendar.date(from: start))
        let reconstructedDueDate = try #require(dueCalendar.date(from: due))
        let alarms = try #require(reminder.alarms)
        #expect(startCalendar.identifier == .gregorian)
        #expect(dueCalendar.identifier == .gregorian)
        #expect(start.timeZone == timeZone)
        #expect(due.timeZone == timeZone)
        #expect(reconstructedStartDate == expectedDate)
        #expect(reconstructedDueDate == expectedDate)
        #expect(alarms.count == 1)
        #expect(alarms[0].absoluteDate == expectedDate)
    }

    @Test func `missing due leaves reminder unscheduled`() throws {
        let omittedValues: [String?] = [nil, "", " \n "]

        for dueISO in omittedValues {
            let reminder = EKReminder(eventStore: EKEventStore())
            try RemindersService.applyDueISO(dueISO, to: reminder)

            #expect(reminder.startDateComponents == nil)
            #expect(reminder.dueDateComponents == nil)
            #expect(!reminder.hasAlarms)
        }
    }

    @Test func `due serialization honors the components calendar`() throws {
        let timeZone = try #require(TimeZone(secondsFromGMT: 0))
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = timeZone
        let components = DateComponents(
            calendar: gregorian,
            timeZone: timeZone,
            year: 2026,
            month: 7,
            day: 18,
            hour: 10,
            minute: 15,
            second: 30)
        let expectedDate = try #require(gregorian.date(from: components))

        var buddhist = Calendar(identifier: .buddhist)
        buddhist.timeZone = timeZone
        #expect(buddhist.date(from: components) != expectedDate)
        #expect(RemindersService.date(fromDueComponents: components) == expectedDate)
    }
}
