import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct HealthSummaryServiceTests {
    @Test func `date range covers the current calendar day`() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let now = try #require(ISO8601DateFormatter().date(from: "2026-07-12T18:30:00Z"))

        let today = HealthSummaryService.dateRange(now: now, calendar: calendar)

        #expect(today.end == now)
        #expect(calendar.component(.hour, from: today.start) == 0)
    }

    @Test func `sleep intervals are clipped and merged before aggregation`() throws {
        let formatter = ISO8601DateFormatter()
        let range = try DateInterval(
            start: #require(formatter.date(from: "2026-07-12T00:00:00Z")),
            end: #require(formatter.date(from: "2026-07-12T12:00:00Z")))
        let intervals = try [
            DateInterval(
                start: #require(formatter.date(from: "2026-07-11T23:30:00Z")),
                end: #require(formatter.date(from: "2026-07-12T01:00:00Z"))),
            DateInterval(
                start: #require(formatter.date(from: "2026-07-12T00:30:00Z")),
                end: #require(formatter.date(from: "2026-07-12T02:00:00Z"))),
            DateInterval(
                start: #require(formatter.date(from: "2026-07-12T03:00:00Z")),
                end: #require(formatter.date(from: "2026-07-12T04:00:00Z"))),
        ]

        #expect(HealthSummaryService.mergedDuration(intervals: intervals, clippedTo: range) == 3 * 60 * 60)
        #expect(HealthSummaryService.mergedDuration(intervals: [], clippedTo: range) == nil)
    }
}
