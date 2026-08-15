import SwiftUI

struct SettingsSidebarScroll<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            self.content
                .padding(.vertical, 10)
                .padding(.horizontal, 10)
        }
        .settingsSidebarCardLayout()
        .padding(.leading, 16)
        .padding(.trailing, 16)
    }
}
