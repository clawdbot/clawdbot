import AppKit
import SwiftUI

/// Hosts arbitrary SwiftUI content as an AppKit view so it can be embedded in a native `NSMenuItem.view`.
///
/// SwiftUI `MenuBarExtraStyle.menu` aggressively simplifies many view hierarchies into a title + image.
/// Wrapping the content in an `NSViewRepresentable` forces AppKit-backed menu item rendering.
struct MenuHostedItem: NSViewRepresentable {
    let width: CGFloat
    let rootView: AnyView

    func makeNSView(context _: Context) -> NSHostingView<AnyView> {
        let hosting = NSHostingView(rootView: self.rootView)
        self.applySizing(to: hosting)
        return hosting
    }

    func updateNSView(_ nsView: NSHostingView<AnyView>, context _: Context) {
        nsView.rootView = self.rootView
        self.applySizing(to: nsView)
    }

    private func applySizing(to hosting: NSHostingView<AnyView>) {
        let width = max(1, self.width)
        hosting.frame.size.width = width
        let fitting = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: width, height: fitting.height))
    }
}
