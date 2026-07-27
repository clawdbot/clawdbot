import SwiftUI

struct WatchDetailScroll<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 9) {
                self.content
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .padding(.bottom, 18)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(WatchClawStyle.background.ignoresSafeArea())
        .navigationTitle(self.title)
    }
}
