import SwiftUI

/// The bar overlays the full transcript viewport. Its measured height belongs
/// to a trailing content spacer, never to an inset that shrinks the viewport.
struct ChatFloatingComposerBar<Bar: View>: ViewModifier {
    @Binding var height: CGFloat
    let bar: Bar

    init(height: Binding<CGFloat>, @ViewBuilder bar: () -> Bar) {
        self._height = height
        self.bar = bar()
    }

    func body(content: Content) -> some View {
        #if os(iOS)
        content.overlay(alignment: .bottom) {
            self.bar
                .onGeometryChange(for: CGFloat.self) { geometry in
                    geometry.size.height
                } action: { height in
                    self.height = height
                }
        }
        #else
        content
        #endif
    }
}
