import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    func agentName(for agent: AgentSummary) -> String {
        self.normalized(agent.name) ?? agent.id
    }

    func agentBadge(for agent: AgentSummary) -> String {
        if let identity = agent.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = self.normalized(emoji)
        {
            return normalizedEmoji
        }

        let words = self.agentName(for: agent)
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        return initials.isEmpty ? "OC" : initials.uppercased()
    }

    func agentTint(for agent: AgentSummary, state: AgentRosterState) -> Color {
        if agent.id == self.activeAgentID { return OpenClawBrand.accent }
        return state.color.opacity(0.62)
    }

    func agentDetail(for agent: AgentSummary) -> String {
        let parts = [
            self.modelLabel(for: agent),
            agent.id == self.appModel.gatewayDefaultAgentId ? "Default" : nil,
        ].compactMap(\.self)
        return parts.isEmpty ? agent.id : parts.joined(separator: " • ")
    }

    func agentAccessibilityLabel(
        _ agent: AgentSummary,
        isActive: Bool,
        state: AgentRosterState) -> String
    {
        let status = state == .online ? "Online" : "Ready"
        let selection = isActive ? "Selected" : "Not selected"
        return "\(self.agentName(for: agent)), \(self.agentDetail(for: agent)), \(status), \(selection)"
    }

    func agentRosterState(for agent: AgentSummary) -> AgentRosterState {
        guard self.gatewayConnected else { return .ready }
        if agent.id == self.activeAgentID { return .online }
        return .ready
    }

    func modelLabel(for agent: AgentSummary) -> String? {
        guard let model = agent.model else { return nil }
        for key in ["primary", "name", "id", "model"] {
            if let value = model[key]?.value as? String,
               let normalized = self.normalized(value)
            {
                return normalized
            }
        }
        return nil
    }

    @MainActor
    func refreshAgents() async {
        guard self.scenePhase == .active, self.liveGatewayConnected else { return }
        await self.appModel.refreshGatewayOverviewIfConnected()
    }

    func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
