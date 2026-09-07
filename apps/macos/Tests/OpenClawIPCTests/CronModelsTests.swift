import Foundation
import Testing
@testable import OpenClaw

struct CronModelsTests {
    @Test func `menu rows trim names and derive their next run time`() {
        let job = CronJob(
            id: "named",
            name: "  Morning job  ",
            enabled: true,
            state: .init(nextRunAtMs: 1_700_000_000_000))
        let unnamed = CronJob(id: "unnamed", name: "   ", enabled: false, state: .init(nextRunAtMs: nil))
        #expect(job.displayName == "Morning job")
        #expect(job.nextRunDate == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(unnamed.displayName == "Untitled job")
        #expect(unnamed.nextRunDate == nil)
    }

    @Test func `menu list ignores Gateway owned payload shapes and skips malformed rows`() throws {
        let json = #"""
        {"total":4,"jobs":[
          {"id":"command","name":"Command job","enabled":true,"state":{},
           "payload":{"kind":"command","argv":["printf","done"]}},
          {"id":"script","name":"Script job","enabled":true,"state":{},
           "payload":{"kind":"script","script":"await agent('check status')"}},
          {"id":"future","name":"Future job","enabled":true,"state":{},
           "payload":{"kind":"new-gateway-kind"},"schedule":{"kind":"new-schedule"}},
          {"id":"malformed","name":"Missing enabled","state":{}}
        ]}
        """#
        let summary = try JSONDecoder().decode(CronJobsSummary.self, from: Data(json.utf8))
        #expect(summary.total == 4)
        #expect(summary.jobs.map(\.id) == ["command", "script", "future"])
    }
}
