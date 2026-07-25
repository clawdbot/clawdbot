import SwiftUI

private enum RootSidebarDrawerMetric {
    static let edgeGestureWidth: CGFloat = 44
    static let topGestureExclusion: CGFloat = 44
    static let settleTranslation: CGFloat = 80
    static let settlePredictedTranslation: CGFloat = 160
    static let topLeadingRadius: CGFloat = 8
    static let cornerRadius: CGFloat = 28
}

struct RootSidebarDrawer<Sidebar: View, Detail: View>: View {
    private enum DragDisposition: Equatable {
        case opening
        case closing
        case rejected
    }

    private struct DragState: Equatable {
        var disposition: DragDisposition?
        var translationWidth: CGFloat = 0
    }

    private final class DragSession {
        var disposition: DragDisposition?
    }

    let sidebarWidth: CGFloat
    let isPresented: Bool
    let canOpenFromEdge: Bool
    let reduceMotion: Bool
    let animation: Animation?
    let onShow: () -> Void
    let onHide: () -> Void
    let sidebar: Sidebar
    let detail: Detail

    @State private var dragSession = DragSession()
    @GestureState(resetTransaction: Transaction(animation: .spring(response: 0.35, dampingFraction: 0.86)))
    private var dragState = DragState()

    var body: some View {
        ZStack(alignment: .leading) {
            self.sidebarLayer
                .opacity(self.reduceMotion && !self.isPresented ? 0 : 1)
                .accessibilityHidden(!self.isPresented)

            self.contentCard
                .opacity(self.reduceMotion && self.isPresented ? 0 : 1)
                .accessibilityHidden(self.isPresented)
                .zIndex(1)

            self.dismissalLayer
                .zIndex(2)
        }
        // Gesture state stays inside this stable shell. The destination tree does
        // not own per-frame drag state, and the moving card never owns its recognizer.
        .simultaneousGesture(
            self.drawerGesture,
            // Keep the recognizer attached while pushed content owns the edge.
            // It rejects that touch once, so the same back-swipe cannot open the drawer after popping.
            isEnabled: !self.reduceMotion)
        .animation(self.animation, value: self.isPresented)
    }

    private var sidebarLayer: some View {
        self.sidebar
            .frame(width: self.sidebarWidth, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(OpenClawSidebarPalette.background)
            .ignoresSafeArea(.container, edges: .vertical)
    }

    private var contentCard: some View {
        let offset = self.contentOffset
        let progress = self.sidebarWidth > 0 ? offset / self.sidebarWidth : 0
        let shape = Self.contentShape(progress: progress)
        return self.detail
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // RootTabs always supplies its shared NavigationStack here. Expanding
            // that stack paints destination backgrounds through the rounded safe
            // areas while navigation chrome keeps destination content inset.
            .background(OpenClawProBackground())
            .ignoresSafeArea(.container, edges: .vertical)
            .allowsHitTesting(!self.isPresented)
            .clipShape(shape)
            .overlay {
                shape.strokeBorder(
                    OpenClawSidebarPalette.hairline.opacity(Double(progress)),
                    lineWidth: 1)
            }
            .offset(x: offset)
    }

    @ViewBuilder
    private var dismissalLayer: some View {
        if self.isPresented {
            HStack(spacing: 0) {
                Color.clear
                    .frame(width: self.sidebarWidth)
                    .allowsHitTesting(false)
                Color.clear
                    .contentShape(Rectangle())
                    .accessibilityHidden(true)
                    .onTapGesture(perform: self.onHide)
            }
        }
    }

    private var contentOffset: CGFloat {
        RootTabs.sidebarContentOffset(
            sidebarWidth: self.sidebarWidth,
            isVisible: self.isPresented,
            dragOffset: self.dragState.translationWidth,
            reduceMotion: self.reduceMotion)
    }

    private var drawerGesture: some Gesture {
        let sidebarWidth = self.sidebarWidth
        let isPresented = self.isPresented
        let canOpenFromEdge = self.canOpenFromEdge
        let onShow = self.onShow
        let onHide = self.onHide
        let dragSession = self.dragSession
        return DragGesture(minimumDistance: 8)
            .updating(self.$dragState) { value, state, _ in
                let disposition: DragDisposition
                if let latchedDisposition = state.disposition {
                    disposition = latchedDisposition
                } else {
                    disposition = Self.dragDisposition(
                        for: value,
                        isPresented: isPresented,
                        canOpenFromEdge: canOpenFromEdge)
                    state.disposition = disposition
                    dragSession.disposition = disposition
                }
                switch disposition {
                case .opening:
                    state.translationWidth = max(0, min(sidebarWidth, value.translation.width))
                case .closing:
                    state.translationWidth = max(-sidebarWidth, min(0, value.translation.width))
                case .rejected:
                    break
                }
            }
            .onEnded { value in
                let disposition = dragSession.disposition
                dragSession.disposition = nil
                switch disposition {
                case .opening:
                    if Self.shouldSettle(
                        translation: value.translation.width,
                        predictedTranslation: value.predictedEndTranslation.width)
                    {
                        onShow()
                    }
                case .closing:
                    if Self.shouldSettle(
                        translation: -value.translation.width,
                        predictedTranslation: -value.predictedEndTranslation.width)
                    {
                        onHide()
                    }
                case .rejected, nil:
                    break
                }
            }
    }

    private static func dragDisposition(
        for value: DragGesture.Value,
        isPresented: Bool,
        canOpenFromEdge: Bool) -> DragDisposition
    {
        if isPresented {
            return self.isClosingDrag(value) ? .closing : .rejected
        }
        guard canOpenFromEdge else { return .rejected }
        return self.isOpeningDrag(value) ? .opening : .rejected
    }

    private static func shouldSettle(
        translation: CGFloat,
        predictedTranslation: CGFloat) -> Bool
    {
        translation > RootSidebarDrawerMetric.settleTranslation ||
            predictedTranslation > RootSidebarDrawerMetric.settlePredictedTranslation
    }

    private static func isOpeningDrag(_ value: DragGesture.Value) -> Bool {
        value.startLocation.x <= RootSidebarDrawerMetric.edgeGestureWidth &&
            value.startLocation.y > RootSidebarDrawerMetric.topGestureExclusion &&
            value.translation.width > 0 &&
            value.translation.width > abs(value.translation.height)
    }

    private static func isClosingDrag(_ value: DragGesture.Value) -> Bool {
        value.translation.width < 0 &&
            -value.translation.width > abs(value.translation.height)
    }

    private static func contentShape(progress: CGFloat) -> UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: RootSidebarDrawerMetric.topLeadingRadius * progress,
            bottomLeadingRadius: RootSidebarDrawerMetric.cornerRadius * progress,
            bottomTrailingRadius: RootSidebarDrawerMetric.cornerRadius * progress,
            topTrailingRadius: RootSidebarDrawerMetric.cornerRadius * progress,
            style: .continuous)
    }
}
