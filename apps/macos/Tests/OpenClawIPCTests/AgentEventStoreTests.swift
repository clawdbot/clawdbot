import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct AgentEventStoreTests {
    @Test
    func `append and clear`() {
        let store = AgentEventStore()
        #expect(store.events.isEmpty)

        store.append(ControlAgentEvent(
            runId: "run",
            seq: 1,
            stream: "test",
            ts: 0,
            data: [:] as [String: OpenClawProtocol.AnyCodable],
            summary: nil))
        #expect(store.events.count == 1)

        store.clear()
        #expect(store.events.isEmpty)
    }

    @Test
    func `trims to max events`() {
        let store = AgentEventStore()
        for i in 1...401 {
            store.append(ControlAgentEvent(
                runId: "run",
                seq: i,
                stream: "test",
                ts: Double(i),
                data: [:] as [String: OpenClawProtocol.AnyCodable],
                summary: nil))
        }

        #expect(store.events.count == 400)
        #expect(store.events.first?.seq == 2)
        #expect(store.events.last?.seq == 401)
    }
}
