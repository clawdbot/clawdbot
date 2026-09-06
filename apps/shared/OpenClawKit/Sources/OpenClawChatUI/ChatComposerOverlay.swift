import SwiftUI

/// iOS Chat floats the composer over the transcript. macOS desktop and Quick
/// Chat keep a stacked composer so the compact panel does not grow.
func chatComposerOverlaysTranscript(platformIsIOS: Bool) -> Bool {
    platformIsIOS
}

/// Pins chat chrome to the bottom of the transcript without reserving an opaque
/// footer. iOS 26 uses `safeAreaBar` so the scroll-edge effect continues behind
/// the glass; iOS 18 uses `safeAreaInset` plus a material fade.
struct ChatFloatingComposerBar<Bar: View>: ViewModifier {
    let bar: Bar

    init(@ViewBuilder bar: () -> Bar) {
        self.bar = bar()
    }

    func body(content: Content) -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *) {
            content.safeAreaBar(edge: .bottom, spacing: 0) {
                self.bar
            }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                self.bar
                    .background {
                        ChatComposerOverlayFallbackScrim()
                    }
            }
        }
        #else
        content
        #endif
    }
}

#if os(iOS)
private struct ChatComposerOverlayFallbackScrim: View {
    var body: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(
                        colors: [.clear, .black],
                        startPoint: .top,
                        endPoint: .bottom)
                        .frame(height: 28)
                    Color.black
                }
            }
            .allowsHitTesting(false)
    }
}
#endif
