import MoltbotProtocol
import Foundation
import Testing
@testable import Moltbot

@Suite
@MainActor
struct AgentEventStoreTests {
    @Test
    func appendAndClear() {
        let store = AgentEventStore()
        #expect(store.events.isEmpty)

        store.append(ControlAgentEvent(
            runId: "run",
            seq: 1,
            stream: "test",
            ts: 0,
            data: [:] as [String: MoltbotProtocol.AnyCodable],
            summary: nil))
        #expect(store.events.count == 1)

        store.clear()
        #expect(store.events.isEmpty)
    }

    @Test
    func trimsToMaxEvents() {
        let store = AgentEventStore()
        for i in 1...401 {
            store.append(ControlAgentEvent(
                runId: "run",
                seq: i,
                stream: "test",
                ts: Double(i),
                data: [:] as [String: MoltbotProtocol.AnyCodable],
                summary: nil))
        }

        #expect(store.events.count == 400)
        #expect(store.events.first?.seq == 2)
        #expect(store.events.last?.seq == 401)
    }
}
