import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct NodeHostStatsReporterTests {
    @Test func `snapshot and node event envelope match the wire contract`() throws {
        let payload = try NodeHostStatsReporter.makePayload(sampler: Self.sampler())
        let requestJSON = try NodeHostStatsReporter.makeNodeEventRequestPayloadJSON(payload: payload)
        let request = try #require(JSONSerialization.jsonObject(with: Data(requestJSON.utf8)) as? [String: String])
        #expect(Set(request.keys) == ["event", "payloadJSON"])
        #expect(request["event"] == "node.host.stats")
        let payloadJSON = try #require(request["payloadJSON"])
        let values = try JSONDecoder().decode([String: UInt64].self, from: Data(payloadJSON.utf8))
        // Disk fields stay absent by design (Apple required-reason API policy).
        #expect(values == [
            "cpuCount": 6,
            "memoryTotalBytes": 8_000_000_000,
            "memoryFreeBytes": 2_000_000_000,
        ])
        #expect(payloadJSON.utf8.count < 200)
    }

    @Test(arguments: [0, 8192])
    func `samples are clamped to gateway bounds`(cpuCount: Int) throws {
        var sampler = Self.sampler()
        sampler.cpuCount = { cpuCount }
        sampler.memoryFreeBytes = { UInt64.max }
        let payload = try NodeHostStatsReporter.makePayload(sampler: sampler)
        #expect(payload.cpuCount == (cpuCount == 0 ? 1 : 4096))
        #expect(payload.memoryFreeBytes == payload.memoryTotalBytes)
    }

    @Test func `failed memory sampling surfaces as an error`() {
        var sampler = Self.sampler()
        sampler.memoryFreeBytes = { throw CocoaError(.fileReadUnknown) }
        #expect(throws: CocoaError.self) {
            try NodeHostStatsReporter.makePayload(sampler: sampler)
        }
    }

    @Test func `older gateway unhandled response is accepted`() throws {
        let response = try JSONDecoder().decode(
            NodeEventResult.self,
            from: Data(#"{"ok":true,"event":"node.host.stats","handled":false,"reason":"unsupported"}"#.utf8))
        #expect(response.ok)
        #expect(!response.handled)
    }

    @Test func `live sampler produces a bounded snapshot`() throws {
        let payload = try NodeHostStatsReporter.makePayload()
        #expect((1...4096).contains(payload.cpuCount))
        #expect(payload.memoryTotalBytes == ProcessInfo.processInfo.physicalMemory)
        #expect(payload.memoryFreeBytes <= payload.memoryTotalBytes)
        #expect(try JSONEncoder().encode(payload).count < 200)
    }

    private static func sampler() -> NodeHostStatsReporter.Sampler {
        NodeHostStatsReporter.Sampler(
            cpuCount: { 6 },
            memoryTotalBytes: { 8_000_000_000 },
            memoryFreeBytes: { 2_000_000_000 })
    }
}
