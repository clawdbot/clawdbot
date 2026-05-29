import SwiftUI

struct VoiceWakeToast: View {
    @Environment(\.colorScheme) private var colorScheme

    var command: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "mic.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)

            Text(self.command)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .proGlassSurface(
            fill: self.colorScheme == .dark ? Color.white.opacity(0.055) : Color.white.opacity(0.72),
            stroke: self.colorScheme == .dark ? Color.white.opacity(0.12) : Color.black.opacity(0.08),
            radius: 14)
        .accessibilityLabel("Voice Wake triggered")
        .accessibilityValue("Command: \(self.command)")
    }
}
