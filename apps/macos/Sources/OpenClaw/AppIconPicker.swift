import SwiftUI

struct AppIconPicker: View {
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(appIconStyleKey, store: AppDefaults.standard)
    private var selection: AppIconStyle = .automatic

    var body: some View {
        SettingsCardGroup("Dock icon") {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    ForEach(AppIconStyle.allCases) { style in
                        self.choice(style)
                    }
                }
                Text("Automatic follows your Mac’s light or dark appearance.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text("Changes apply while OpenClaw is running.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(14)
        }
    }

    private func choice(_ style: AppIconStyle) -> some View {
        let selected = self.selection == style
        let artwork = style == .automatic ? (self.colorScheme == .dark ? AppIconStyle.ink : .paper) : style
        return Button {
            self.selection = style
        } label: {
            VStack(spacing: 5) {
                if let image = AppIconArtwork.image(for: artwork) {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 56, height: 56)
                }
                Text(style.title)
                    .font(.caption.weight(selected ? .semibold : .regular))
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary.opacity(0.5))
                    .font(.caption)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                selected ? Color.accentColor.opacity(0.1) : .clear,
                in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(AppIconArtwork.image(for: artwork) == nil)
        .accessibilityLabel(style.title)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}
