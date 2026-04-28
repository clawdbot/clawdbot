import SwiftUI

private struct StatusGlassCardModifier: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast

    let brighten: Bool
    let verticalPadding: CGFloat
    let horizontalPadding: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(.vertical, self.verticalPadding)
            .padding(.horizontal, self.horizontalPadding)
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(
                                .white.opacity(self.contrast == .increased ? 0.5 : (self.brighten ? 0.24 : 0.18)),
                                lineWidth: self.contrast == .increased ? 1.0 : 0.5)
                    }
                    .shadow(color: .black.opacity(0.25), radius: 12, y: 6)
            }
    }
}

extension View {
    func statusGlassCard(brighten: Bool, verticalPadding: CGFloat, horizontalPadding: CGFloat = 12) -> some View {
        self.modifier(
            StatusGlassCardModifier(
                brighten: brighten,
                verticalPadding: verticalPadding,
                horizontalPadding: horizontalPadding))
    }
}
