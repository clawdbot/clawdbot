import Observation
import SwiftUI

struct CronSettings: View {
    @Bindable var store: CronJobsStore
    @Bindable var channelsStore: ChannelsStore
    let isActive: Bool
    @State var editor: CronJobsStore.EditorContext?
    @State var confirmDelete: CronJobsStore.JobContext?

    init(store: CronJobsStore = .shared, channelsStore: ChannelsStore = .shared, isActive: Bool = true) {
        self.store = store
        self.channelsStore = channelsStore
        self.isActive = isActive
    }
}
