import Foundation

enum GatewayAgentChannel: String, Codable, CaseIterable {
    case last
    case whatsapp
    case telegram
    case discord
    case googlechat
    case slack
    case signal
    case imessage
    case msteams
    case webchat

    init(raw: String?) {
        let normalized = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self = GatewayAgentChannel(rawValue: normalized) ?? .last
    }

    var isDeliverable: Bool {
        self != .webchat
    }

    func shouldDeliver(_ deliver: Bool) -> Bool {
        deliver && self.isDeliverable
    }
}

struct GatewayAgentInvocation {
    var message: String
    var sessionKey: String = "main"
    var thinking: String?
    var deliver: Bool = false
    var to: String?
    var channel: GatewayAgentChannel = .last
    var timeoutSeconds: Int?
    var idempotencyKey: String = UUID().uuidString
    var voiceWakeTrigger: String?
}
