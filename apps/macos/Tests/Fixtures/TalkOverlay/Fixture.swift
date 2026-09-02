import AppKit
import SwiftUI

/// Compile the real controller and factory without loading app state or microphone services.
enum TalkModePhase: String {
    case idle, listening, thinking, speaking
}

struct TalkOverlayView: View {
    var controller: TalkOverlayController
    var body: some View {
        Text("Synthetic Talk overlay proof").padding().background(.blue)
    }
}

@MainActor
private final class FixtureDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_: Notification) {
        Task { @MainActor in
            do {
                var failures = 0
                for delay in [0, 40, 120] {
                    let controller = TalkOverlayController()
                    controller.present()
                    guard let panel = NSApplication.shared.windows.first(where: {
                        ($0.contentView as? NSHostingView<TalkOverlayView>)?.rootView.controller === controller
                    }) else {
                        print("FAIL missing Talk panel")
                        exit(2)
                    }
                    // Timed end-to-end observations with the normal AppKit run loop, not a completion hook.
                    try await Task.sleep(for: .milliseconds(240))
                    controller.dismiss()
                    if delay > 0 { try await Task.sleep(for: .milliseconds(delay)) }
                    controller.present()
                    try await Task.sleep(for: .milliseconds(450))
                    let shown = controller.model.isVisible && panel.isVisible && panel.alphaValue == 1
                    print("reopen delay_ms=\(delay) model=\(controller.model.isVisible) " +
                        "panel=\(panel.isVisible) alpha=\(panel.alphaValue) pass=\(shown)")
                    if !shown { failures += 1 }

                    controller.dismiss()
                    try await Task.sleep(for: .milliseconds(250))
                    let hidden = !controller.model.isVisible && !panel.isVisible
                    print("dismiss model=\(controller.model.isVisible) panel=\(panel.isVisible) pass=\(hidden)")
                    if !hidden { failures += 1 }
                    panel.orderOut(nil)
                }
                print("RESULT failures=\(failures)")
                fflush(stdout)
                exit(failures == 0 ? 0 : 1)
            } catch {
                print("FAIL fixture interrupted: \(error)")
                exit(2)
            }
        }
    }
}

@main
private struct TalkOverlayFixture {
    @MainActor static func main() {
        let app = NSApplication.shared
        guard !NSScreen.screens.isEmpty else {
            print("FAIL Talk overlay fixture requires a logged-in macOS desktop")
            exit(2)
        }
        app.setActivationPolicy(.accessory)
        let delegate = FixtureDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
