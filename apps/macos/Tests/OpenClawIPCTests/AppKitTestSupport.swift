import AppKit
import ApplicationServices
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

    static func accessibilityElements(in root: NSView) async throws -> [AnyObject] {
        // SwiftUI materializes its virtual accessibility children after a real client request.
        let result = await Task.detached {
            let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
            var windows: CFTypeRef?
            return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
        }.value
        try #require(result == .success)
        var elements: [AnyObject] = []
        var visited = Set<ObjectIdentifier>()
        func visit(_ element: AnyObject) {
            guard visited.insert(ObjectIdentifier(element)).inserted else { return }
            elements.append(element)
            for child in element.accessibilityChildren?() ?? [] {
                visit(child as AnyObject)
            }
        }
        visit(root)
        return elements
    }
}
