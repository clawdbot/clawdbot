import AppKit
import SwiftUI

struct ConnectionsSettings: View {
    enum ConnectionChannel: String, CaseIterable, Identifiable, Hashable {
        case whatsapp
        case telegram
        case discord
        case signal
        case imessage

        var id: String { self.rawValue }

        var sortOrder: Int {
            switch self {
            case .whatsapp: 0
            case .telegram: 1
            case .discord: 2
            case .signal: 3
            case .imessage: 4
            }
        }

        var title: String {
            switch self {
            case .whatsapp: "WhatsApp"
            case .telegram: "Telegram"
            case .discord: "Discord"
            case .signal: "Signal"
            case .imessage: "iMessage"
            }
        }

        var detailTitle: String {
            switch self {
            case .whatsapp: "WhatsApp Web"
            case .telegram: "Telegram Bot"
            case .discord: "Discord Bot"
            case .signal: "Signal REST"
            case .imessage: "iMessage (imsg)"
            }
        }

        var systemImage: String {
            switch self {
            case .whatsapp: "message"
            case .telegram: "paperplane"
            case .discord: "bubble.left.and.bubble.right"
            case .signal: "antenna.radiowaves.left.and.right"
            case .imessage: "message.fill"
            }
        }
    }

    @Bindable var store: ConnectionsStore
    @State var selectedChannel: ConnectionChannel?
    @State var showTelegramToken = false
    @State var showDiscordToken = false

    init(store: ConnectionsStore = .shared) {
        self.store = store
    }
}
