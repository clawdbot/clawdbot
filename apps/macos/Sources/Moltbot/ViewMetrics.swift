import SwiftUI

private struct ViewWidthPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

extension View {
    func onWidthChange(_ onChange: @escaping (CGFloat) -> Void) -> some View {
        self.background(
            GeometryReader { proxy in
                Color.clear.preference(key: ViewWidthPreferenceKey.self, value: proxy.size.width)
            })
            .onPreferenceChange(ViewWidthPreferenceKey.self, perform: onChange)
    }
}

#if DEBUG
enum ViewMetricsTesting {
    static func reduceWidth(current: CGFloat, next: CGFloat) -> CGFloat {
        var value = current
        ViewWidthPreferenceKey.reduce(value: &value, nextValue: { next })
        return value
    }
}
#endif
