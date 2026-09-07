import SwiftUI

struct WatchPrimaryLabel: View {
    let title: LocalizedStringKey

    var body: some View {
        HStack(spacing: 7) {
            WatchVoiceGlyph()
            Text(self.title)
                .font(WatchClawType.captionBold)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 7)
        .background {
            Capsule(style: .continuous)
                .fill(WatchClawStyle.hotGradient)
        }
    }
}

struct WatchVoiceGlyph: View {
    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach([7.0, 13.0, 18.0, 12.0, 8.0], id: \.self) { height in
                Capsule(style: .continuous)
                    .fill(.white.opacity(0.82))
                    .frame(width: 2, height: height)
            }
        }
        .frame(width: 20, height: 20)
    }
}
