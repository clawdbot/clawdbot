struct RootTabsHomeCanvasPayload: Codable {
    var gatewayState: String
    var eyebrow: String
    var title: String
    var subtitle: String
    var gatewayLabel: String
    var activeAgentName: String
    var activeAgentBadge: String
    var activeAgentCaption: String
    var agentCount: Int
    var agents: [RootTabsHomeCanvasAgentCard]
    var footer: String
}

struct RootTabsHomeCanvasAgentCard: Codable {
    var id: String
    var name: String
    var badge: String
    var caption: String
    var isActive: Bool
}
