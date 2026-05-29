import SwiftUI

struct RootView: View {
    @AppStorage(AppAppearancePreference.storageKey) private var appearancePreferenceRaw: String =
        AppAppearancePreference.system.rawValue

    var body: some View {
        RootTabs()
            .preferredColorScheme(self.appearancePreference.colorScheme)
    }

    private var appearancePreference: AppAppearancePreference {
        AppAppearancePreference(rawValue: self.appearancePreferenceRaw) ?? .system
    }
}
