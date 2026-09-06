import AppKit
import Testing

@MainActor
enum AppKitTestSupport {
    /// Rendered suites share one process and must initialize AppKit only once.
    static let application: NSApplication = {
        let application = NSApplication.shared
        #expect(application.setActivationPolicy(.accessory))
        application.finishLaunching()
        return application
    }()
}
