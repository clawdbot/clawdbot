import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension GatewayConnection {
    func configuredInferenceModel(
        ifCurrentRoute route: Route,
        timeoutMs: Double = 15000) async throws -> String?
    {
        let data = try await request(
            OpenClawChatGatewayRequests.agentsList(timeoutMs: timeoutMs),
            ifCurrentRoute: route)
        guard await self.isCurrentRoute(route) else {
            throw CancellationError()
        }
        return try Self.decodeConfiguredInferenceModel(data)
    }

    static func decodeConfiguredInferenceModel(_ data: Data) throws -> String? {
        let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
        let primary = result.agents
            .first(where: { $0.id == result.defaultid })?
            .model?["primary"]?.value as? String
        let trimmed = primary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
