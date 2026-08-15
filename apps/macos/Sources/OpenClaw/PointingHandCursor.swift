import AppKit
import SwiftUI

private struct PointingHandCursorModifier: ViewModifier {
    @State private var isHovering = false

    func body(content: Content) -> some View {
        content
            .onHover { hovering in
                guard hovering != self.isHovering else { return }
                self.isHovering = hovering
                if hovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }
            .onDisappear {
                guard self.isHovering else { return }
                self.isHovering = false
                NSCursor.pop()
            }
    }
}

extension View {
    func pointingHandCursor() -> some View {
        self.modifier(PointingHandCursorModifier())
    }
}
