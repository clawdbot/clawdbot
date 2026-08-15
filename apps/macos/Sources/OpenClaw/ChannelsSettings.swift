import AppKit
import SwiftUI

struct ChannelsSettings: View {
    struct ChannelItem: Identifiable, Hashable {
        let id: String
        let title: String
        let detailTitle: String
        let systemImage: String
        let sortOrder: Int
    }

    @Bindable var store: ChannelsStore
    let isActive: Bool
    @State var selectedChannel: ChannelItem?

    init(store: ChannelsStore = .shared, isActive: Bool = true) {
        self.store = store
        self.isActive = isActive
    }
}
