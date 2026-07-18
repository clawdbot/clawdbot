import SwiftUI

struct QuickChatWindowPickerView: View {
    let candidates: [QuickChatWindowCandidate]
    let onSelect: (QuickChatWindowCandidate) -> Void
    let onCancel: () -> Void

    @State private var hoveredWindowID: Int?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.opacity(0.18)

            // Candidates arrive front-to-back for hit testing; paint back-to-front so the
            // topmost window's highlight is never covered by an occluded window's cell.
            ForEach(self.candidates.reversed()) { candidate in
                let isHovered = self.hoveredWindowID == candidate.windowID
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.accentColor.opacity(isHovered ? 0.16 : 0.04))
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color.accentColor.opacity(isHovered ? 0.95 : 0.62), lineWidth: isHovered ? 3 : 2)
                    Text(QuickChatWindowPickerLogic.labelText(
                        appName: candidate.appName,
                        title: candidate.title))
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .frame(maxWidth: max(80, candidate.bounds.width - 20))
                        .background(.regularMaterial, in: Capsule())
                        .shadow(radius: 4, y: 1)
                }
                .frame(width: candidate.bounds.width, height: candidate.bounds.height)
                .position(x: candidate.bounds.midX, y: candidate.bounds.midY)
                .allowsHitTesting(false)
            }
        }
        .contentShape(Rectangle())
        .onContinuousHover { phase in
            switch phase {
            case let .active(point):
                self.hoveredWindowID = QuickChatWindowPickerLogic.hitTest(self.candidates, at: point)?.windowID
            case .ended:
                self.hoveredWindowID = nil
            }
        }
        .gesture(SpatialTapGesture().onEnded { value in
            if let candidate = QuickChatWindowPickerLogic.hitTest(self.candidates, at: value.location) {
                self.onSelect(candidate)
            } else {
                self.onCancel()
            }
        })
        .ignoresSafeArea()
    }
}
