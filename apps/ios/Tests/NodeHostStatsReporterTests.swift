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
        #expect(values == [
            "cpuCount": 6,
            "memoryTotalBytes": 8_000_000_000,
            "memoryFreeBytes": 2_000_000_000,
            "diskTotalBytes": 256_000_000_000,
            "diskAvailableBytes": 100_000_000_000,
        ])
        #expect(payloadJSON.utf8.count < 200)
    }

    @Test(arguments: [(nil, nil), (Int64(256), nil), (nil, Int64(100))])
    func `disk fields are omitted together`(capacity: (Int64?, Int64?)) throws {
        var sampler = Self.sampler()
        sampler.diskCapacity = { capacity }
        let payload = try NodeHostStatsReporter.makePayload(sampler: sampler)
        let values = try JSONDecoder().decode([String: UInt64].self, from: JSONEncoder().encode(payload))
        #expect(Set(values.keys) == ["cpuCount", "memoryTotalBytes", "memoryFreeBytes"])
    }

    @Test func `failed disk sampling still reports memory`() throws {
        var sampler = Self.sampler()
        sampler.diskCapacity = { throw CocoaError(.fileReadUnknown) }
        let payload = try NodeHostStatsReporter.makePayload(sampler: sampler)
        #expect(payload.diskTotalBytes == nil)
        #expect(payload.diskAvailableBytes == nil)
        #expect(payload.memoryFreeBytes == 2_000_000_000)
    }

    @Test(arguments: [0, 8192])
    func `samples are clamped to gateway bounds`(cpuCount: Int) throws {
        var sampler = Self.sampler()
        sampler.cpuCount = { cpuCount }
        sampler.memoryFreeBytes = { UInt64.max }
        sampler.diskCapacity = { (100, 200) }
        let payload = try NodeHostStatsReporter.makePayload(sampler: sampler)
        #expect(payload.cpuCount == (cpuCount == 0 ? 1 : 4096))
        #expect(payload.memoryFreeBytes == payload.memoryTotalBytes)
        #expect(payload.diskAvailableBytes == payload.diskTotalBytes)
    }

    @Test func `negative disk values are clamped to zero`() throws {
        var sampler = Self.sampler()
        sampler.diskCapacity = { (-1, -2) }
        let payload = try NodeHostStatsReporter.makePayload(sampler: sampler)
        #expect(payload.diskTotalBytes == 0)
        #expect(payload.diskAvailableBytes == 0)
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
        #expect((payload.diskTotalBytes == nil) == (payload.diskAvailableBytes == nil))
        if let total = payload.diskTotalBytes, let available = payload.diskAvailableBytes {
            #expect(total >= 0)
            #expect((0...total).contains(available))
        }
        #expect(try JSONEncoder().encode(payload).count < 200)
    }

    private static func sampler() -> NodeHostStatsReporter.Sampler {
        NodeHostStatsReporter.Sampler(
            cpuCount: { 6 },
            memoryTotalBytes: { 8_000_000_000 },
            memoryFreeBytes: { 2_000_000_000 },
            diskCapacity: { (256_000_000_000, 100_000_000_000) })
    }
}
