import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: PropertyStore

    var body: some View {
        TabView {
            NavigationStack {
                TaskListView()
            }
            .tabItem {
                Label("Tasks", systemImage: "checklist")
            }

            NavigationStack {
                AssetListView()
            }
            .tabItem {
                Label("Assets", systemImage: "wrench.and.screwdriver")
            }

            NavigationStack {
                SettingsView()
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape")
            }
        }
        .task {
            await store.refresh()
            await store.refreshAssets()
        }
        .onOpenURL { url in
            store.handleDeepLink(url)
        }
    }
}
