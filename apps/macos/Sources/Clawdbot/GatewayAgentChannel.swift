import Foundation

enum GatewayAgentChannel: String, CaseIterable, Sendable {
    case last
    case webchat
    case whatsapp
    case telegram

    init(raw: String?) {
        let trimmed = raw?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        self = GatewayAgentChannel(rawValue: trimmed) ?? .last
    }

    func shouldDeliver(_ isLast: Bool) -> Bool {
        switch self {
        case .webchat:
            false
        case .last:
            isLast
        case .whatsapp, .telegram:
            true
        }
    }
}
