import OpenClawProtocol

extension GatewayConnection {
    func agentsList(timeoutMs: Double = 15000) async throws -> AgentsListResult {
        try await self.requestDecoded(method: .agentsList, timeoutMs: timeoutMs)
    }
}
