import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TalkOverlayTests {
    @Test
    func `visibility intent changes before animations complete`() throws {
        _ = NSApplication.shared
        let controller = TalkOverlayController()
        controller.present()
        let window = try #require(NSApplication.shared.windows.first {
            ($0.contentView as? NSHostingView<TalkOverlayView>)?.rootView.controller === controller
        })
        defer { window.orderOut(nil) }

        #expect(controller.model.isVisible)
        controller.dismiss()
        #expect(!controller.model.isVisible)
        controller.present()
        #expect(controller.model.isVisible)
        controller.dismiss()
        #expect(!controller.model.isVisible)
    }
}
