import SwiftUI

struct AppIconPicker: View {
    @AppStorage(appIconStyleKey, store: AppDefaults.standard)
    private var selection: AppIconStyle = .paper

    var body: some View {
        // Read here so the lazy grid refreshes its selection indicators.
        let selection = self.selection
        return SettingsCardGroup("Dock icon") {
            VStack(alignment: .leading, spacing: 10) {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    ForEach(AppIconStyle.allCases) { style in
                        self.choice(style, selected: selection == style)
                    }
                }
                Text("Each design includes light and dark artwork.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(
                    "Original uses your Mac’s icon style. Other designs follow light/dark mode while OpenClaw runs.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(14)
        }
    }

    private func choice(_ style: AppIconStyle, selected: Bool) -> some View {
        Button {
            self.selection = style
        } label: {
            VStack(spacing: 10) {
                HStack(spacing: 14) {
                    ForEach(AppIconAppearance.allCases, id: \.self) { appearance in
                        VStack(spacing: 3) {
                            if let image = AppIconArtwork.image(for: style, appearance: appearance) {
                                Image(nsImage: image)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(width: 64, height: 64)
                            }
                            Text(appearance.title)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                HStack(spacing: 6) {
                    Text(style.title)
                        .font(.callout.weight(selected ? .semibold : .regular))
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary.opacity(0.5))
                        .font(.caption)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(
                selected ? Color.accentColor.opacity(0.1) : .clear,
                in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(AppIconAppearance.allCases.contains { AppIconArtwork.image(for: style, appearance: $0) == nil })
        .accessibilityLabel(style.title)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}
