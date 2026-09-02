import Observation
import SwiftUI

struct CronSettings: View {
    @Bindable var store: CronJobsStore
    @Bindable var channelsStore: ChannelsStore
    let isActive: Bool
    @State var showEditor = false
    @State var editingJob: CronJob?
    @State var editorError: String?
    @State var isSaving = false
    @State var confirmDelete: CronJob?

    init(store: CronJobsStore = .shared, channelsStore: ChannelsStore = .shared, isActive: Bool = true) {
        self.store = store
        self.channelsStore = channelsStore
        self.isActive = isActive
    }
}
