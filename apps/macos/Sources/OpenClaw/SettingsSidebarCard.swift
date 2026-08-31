import SwiftUI

extension View {
    func settingsSidebarCardLayout() -> some View {
        self
            .frame(width: SettingsLayout.nestedSidebarWidth, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(nsColor: .windowBackgroundColor)))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
