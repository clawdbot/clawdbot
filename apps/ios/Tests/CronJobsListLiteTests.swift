import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct CronJobsListLiteTests {
    @Test @MainActor func `cron collector preserves snapshot order and normalized revision`() async throws {
        let collected = await Self.collectCronPages([
            Self.cronPage(["z", "a"], total: 3, revision: " rev-1 ", hasMore: true, nextOffset: 2),
            Self.cronPage(["m"], total: 3, revision: "rev-1\n"),
        ], maximumPageCount: 2)
        let snapshot = try #require(collected.snapshot)

        #expect(collected.offsets == [0, 2])
        #expect(snapshot.jobs.map(\.id) == ["z", "a", "m"])
        #expect(snapshot.snapshotRevision == "rev-1")
        #expect(snapshot.total == 3)
        #expect(!snapshot.hasMore)
        #expect(snapshot.nextOffset == nil)
    }

    @Test @MainActor func `cron collector accepts empty advancing pages and absent identity`() async throws {
        let collected = await Self.collectCronPages([
            Self.cronPage(revision: " \n", hasMore: true, nextOffset: 3),
            Self.cronPage(["a"], nextOffset: 99),
        ])
        let snapshot = try #require(collected.snapshot)

        #expect(collected.offsets == [0, 3])
        #expect(snapshot.jobs.map(\.id) == ["a"])
        #expect(snapshot.snapshotRevision == nil)
        #expect(snapshot.total == nil)
        #expect(!snapshot.hasMore)
        #expect(snapshot.nextOffset == nil)
    }

    @Test func `legacy cron list defaults to a single page`() throws {
        let page = try JSONDecoder().decode(
            CronJobsListLite.self,
            from: Data(#"{"jobs":[],"total":0}"#.utf8))
        #expect(page.snapshotRevision == nil)
        #expect(!page.hasMore)
        #expect(page.nextOffset == nil)
    }

    @Test @MainActor func `cron collector rejects snapshot identity changes including missing values`() async {
        let cases: [(name: String, firstTotal: Int?, firstRevision: String?, total: Int?, revision: String?)] = [
            ("revision changes", 2, "rev-1", 2, "rev-2"),
            ("revision appears", 2, nil, 2, "rev-1"),
            ("revision disappears", 2, "rev-1", 2, nil),
            ("total changes", 2, "rev-1", 3, "rev-1"),
            ("total appears", nil, nil, 2, nil),
            ("total disappears", 2, nil, nil, nil),
        ]
        for scenario in cases {
            let collected = await Self.collectCronPages([
                Self.cronPage(
                    ["a"], total: scenario.firstTotal, revision: scenario.firstRevision,
                    hasMore: true, nextOffset: 1),
                Self.cronPage(["b"], total: scenario.total, revision: scenario.revision),
            ])
            #expect(collected.snapshot == nil, "\(scenario.name)")
            #expect(collected.offsets == [0, 1], "\(scenario.name)")
        }
    }

    @Test @MainActor func `cron collector rejects duplicate rows count contradictions and missing pages`() async {
        let first = Self.cronPage(["a"], hasMore: true, nextOffset: 1)
        let cases: [(name: String, pages: [CronJobsListLite?], offsets: [Int])] = [
            ("duplicate within page", [Self.cronPage(["a", "a"])], [0]),
            ("duplicate across pages", [first, Self.cronPage(["a"])], [0, 1]),
            ("negative total", [Self.cronPage(total: -1)], [0]),
            ("total below collected count", [Self.cronPage(["a", "b"], total: 1)], [0]),
            ("more after exact total", [Self.cronPage(["a"], total: 1, hasMore: true, nextOffset: 1)], [0]),
            ("page exceeds job budget", [Self.cronPage(["a", "b", "c", "d"])], [0]),
            ("aggregate exceeds job budget", [
                Self.cronPage(["a", "b"], hasMore: true, nextOffset: 2), Self.cronPage(["c", "d"]),
            ], [0, 2]),
            ("first fetch unavailable", [nil], [0]),
            ("later fetch unavailable", [first, nil], [0, 1]),
        ]
        for scenario in cases {
            let collected = await Self.collectCronPages(scenario.pages)
            #expect(collected.snapshot == nil, "\(scenario.name)")
            #expect(collected.offsets == scenario.offsets, "\(scenario.name)")
        }
    }

    @Test @MainActor func `cron collector rejects missing nonadvancing and over-budget offsets`() async {
        let firstOffsets: [Int?] = [nil, -1, 0, 4]
        for nextOffset in firstOffsets {
            let collected = await Self.collectCronPages([
                Self.cronPage(["a"], hasMore: true, nextOffset: nextOffset),
            ])
            #expect(collected.snapshot == nil)
            #expect(collected.offsets == [0])
        }
        for nextOffset in [0, 1, 2] {
            let collected = await Self.collectCronPages([
                Self.cronPage(["a"], hasMore: true, nextOffset: 2),
                Self.cronPage(["b"], hasMore: true, nextOffset: nextOffset),
            ])
            #expect(collected.snapshot == nil)
            #expect(collected.offsets == [0, 2])
        }
    }

    @Test @MainActor func `cron collector preserves terminal metadata at configured budgets`() async throws {
        let empty = await Self.collectCronPages([Self.cronPage(total: 0)])
        #expect(empty.offsets == [0])
        #expect(empty.snapshot?.jobs.isEmpty == true)
        #expect(empty.snapshot?.total == 0)

        for limits in [(pages: 5, jobs: 1000), (pages: 100, jobs: 20000)] {
            var pages: [CronJobsListLite?] = (1...limits.pages).map {
                Self.cronPage(total: limits.jobs, hasMore: true, nextOffset: $0)
            }
            let exhausted = await Self.collectCronPages(
                pages, maximumPageCount: limits.pages, maximumJobCount: limits.jobs)
            #expect(exhausted.snapshot == nil)
            #expect(exhausted.offsets == Array(0..<limits.pages))

            pages[limits.pages - 1] = Self.cronPage(["a"], total: limits.jobs)
            let completed = await Self.collectCronPages(
                pages, maximumPageCount: limits.pages, maximumJobCount: limits.jobs)
            let snapshot = try #require(completed.snapshot)
            #expect(completed.offsets == Array(0..<limits.pages))
            #expect(snapshot.jobs.map(\.id) == ["a"])
            #expect(snapshot.total == nil)
            #expect(!snapshot.hasMore)
            #expect(snapshot.nextOffset == nil)

            let oversized = await Self.collectCronPages(
                [Self.cronPage(total: limits.jobs + 1)],
                maximumPageCount: limits.pages, maximumJobCount: limits.jobs)
            #expect(oversized.snapshot == nil)
            #expect(oversized.offsets == [0])
        }
    }

    @MainActor
    private static func collectCronPages(
        _ pages: [CronJobsListLite?],
        maximumPageCount: Int = 3,
        maximumJobCount: Int = 3) async -> (snapshot: CronJobsListLite?, offsets: [Int])
    {
        var offsets: [Int] = []
        let snapshot = await CronJobsListLite.collect(
            maximumPageCount: maximumPageCount,
            maximumJobCount: maximumJobCount)
        { offset in
            let index = offsets.count
            offsets.append(offset)
            return index < pages.count ? pages[index] : nil
        }
        return (snapshot, offsets)
    }

    private static func cronPage(
        _ ids: [String] = [],
        total: Int? = nil,
        revision: String? = nil,
        hasMore: Bool = false,
        nextOffset: Int? = nil) -> CronJobsListLite
    {
        CronJobsListLite(
            jobs: ids.map { Self.job(id: $0) },
            snapshotRevision: revision,
            total: total,
            hasMore: hasMore,
            nextOffset: nextOffset)
    }

    private static func job(id: String) -> CronJob {
        CronJob(
            id: id,
            name: "Release briefing",
            description: "Daily mobile release overview",
            enabled: true,
            deleteafterrun: false,
            createdatms: 1_783_468_800_000,
            updatedatms: 1_783_555_200_000,
            configrevision: "sha256:test-revision",
            schedule: AnyCodable([
                "kind": AnyCodable("every"),
                "everyMs": AnyCodable(86_400_000),
                "anchorMs": AnyCodable(1_783_468_800_000),
            ]),
            sessiontarget: AnyCodable("isolated"),
            wakemode: AnyCodable("now"),
            payload: AnyCodable([
                "kind": AnyCodable("agentTurn"),
                "message": AnyCodable("Summarize release readiness."),
                "model": AnyCodable("openai/gpt-5.2"),
            ]),
            state: [:],
            nextrunatms: 1_783_641_600_000)
    }
}
