import AppKit
import ApplicationServices
import ConcurrencyExtras
import SwiftUI
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
@MainActor
struct ConfigSelectionRecoveryTests {
    @Test(arguments: [true, false])
    func `a retained Config section stays actionable after root recovery`(sectionRecovers: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let fixture = ConfigSelectionFixture(sectionRecovers: sectionRecovers)
            let store = ChannelsStore(isPreview: false, gateway: fixture.gateway)
            let hosting = NSHostingView(rootView: ConfigSettings(store: store))
            hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 700)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = hosting
            defer {
                window.orderOut(nil)
                window.contentView = nil
                window.close()
            }
            window.orderFront(nil)
            let result: Result<Void, Error>
            do {
                var content = try await Self.waitForContent(hosting) { content in
                    store.configLookupNode(path: "browser") != nil && content.labels.contains("Enabled")
                }
                try #require(content.labels.contains("Enabled"), "Gateway A selected section must render")
                try #require(store.startCount == 1)
                try #require(store.gatewayPushTask != nil)
                let originalSource = try #require(store.source)
                fixture.revision.setValue(2)
                _ = try await fixture.gateway.acquireServerLease()
                let valuesDeadline = ContinuousClock.now + .seconds(3)
                while !store.configLoaded || store.source == nil || store.source === originalSource,
                      ContinuousClock.now < valuesDeadline
                {
                    hosting.layoutSubtreeIfNeeded()
                    window.displayIfNeeded()
                    try await Task.sleep(for: .milliseconds(10))
                }
                let replacementSource = try #require(store.source)
                try #require(store.owns(replacementSource))
                try #require(replacementSource !== originalSource)
                try #require(
                    store.configLoaded,
                    """
                    B values: requests=\(fixture.requests.value), loading=\(store.configLoading),
                    status=\(store.configStatus ?? "none"), error=\(store.lastError ?? "none"),
                    owns=\(store.owns(replacementSource))
                    """)
                await fixture.replacementRootGate.open()
                content = try await Self.waitForContent(hosting) { content in
                    content.labels.contains { $0.contains("lookup failed") } &&
                        fixture.requests.value["2:browser"] == 1 &&
                        !store.configLookupLoadingPaths.contains("browser")
                }
                try #require(content.labels.contains { $0.contains("lookup failed") })
                try #require(store.configLookupRoot == nil)
                try #require(store.configLookupNode(path: "browser") == nil)
                try #require(fixture.requests.value["2:."] == 1)
                try #require(fixture.requests.value["2:browser"] == 1)
                try #require(content.actions["Reload"] == true)
                try await Self.press("Reload", in: hosting)
                content = try await Self.waitForContent(hosting) { content in
                    store.configLookupRoot != nil && content.labels.contains("Browser")
                }
                try #require(store.configLookupRoot?.path == ".")
                try #require(content.labels.contains("Browser"))
                #expect(
                    content.labels.contains("Enabled") || content.actions["Retry"] == true,
                    "Recovered root must leave its retained section loaded or actionable: \(content.labels)")
                if content.actions["Retry"] == true { try await Self.press("Retry", in: hosting) }
                content = try await Self.waitForContent(hosting) { content in
                    fixture.requests.value["2:browser"] == 2 &&
                        (sectionRecovers ? content.labels.contains("Enabled") : content.actions["Retry"] == true)
                }
                #expect(fixture.requests.value["2:browser"] == 2)
                #expect((store.configLookupNode(path: "browser") != nil) == sectionRecovers)
                #expect(sectionRecovers ? content.labels.contains("Enabled") : content.actions["Retry"] == true)
                result = .success(())
            } catch {
                result = .failure(error)
            }
            await fixture.replacementRootGate.open()
            store.stop()
            await fixture.gateway.shutdown()
            try result.get()
        }
    }

    private struct Content {
        let labels: [String]
        let actions: [String: Bool]
    }

    private static func waitForContent(
        _ hosting: NSView,
        until condition: (Content) -> Bool) async throws -> Content
    {
        var content = Content(labels: [], actions: [:])
        let deadline = ContinuousClock.now + .seconds(3)
        repeat {
            hosting.layoutSubtreeIfNeeded()
            hosting.window?.displayIfNeeded()
            var labels: [String] = []
            var actions: [String: Bool] = [:]
            for element in try await Self.elements(hosting) {
                let value: Any? = element.accessibilityValue?()
                let text = [element.accessibilityLabel?(), element.accessibilityTitle?(), value as? String]
                    .compactMap(\.self)
                labels.append(contentsOf: text)
                if element.accessibilityRole?() == .button, let enabled = element.isAccessibilityEnabled?() {
                    for label in text {
                        actions[label] = enabled
                    }
                }
            }
            content = Content(labels: labels, actions: actions)
            if condition(content) { return content }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        return content
    }

    private static func press(_ label: String, in hosting: NSView) async throws {
        let elements = try await Self.elements(hosting)
        let button = try #require(elements.first { element in
            element.accessibilityRole?() == .button &&
                [element.accessibilityLabel?(), element.accessibilityTitle?()].contains(label)
        })
        try #require(button.accessibilityPerformPress?() == true)
    }

    private static func elements(_ root: NSView) async throws -> [AnyObject] {
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
            let children: [Any]? = element.accessibilityChildren?()
            for child in children ?? [] {
                visit(child as AnyObject)
            }
            if let view = element as? NSView {
                for child in view.subviews where !child.isHidden {
                    visit(child)
                }
            }
        }
        visit(root)
        return elements
    }
}

private final class ConfigSelectionFixture: @unchecked Sendable {
    let revision = LockIsolated<UInt64>(1)
    let requests = LockIsolated<[String: Int]>([:])
    let replacementRootGate = GatewayConnectionSuspensionGate()
    let gateway: GatewayConnection

    init(sectionRecovers: Bool) {
        let revision = self.revision
        let requests = self.requests
        let replacementRootGate = self.replacementRootGate
        let session = GatewayTestWebSocketSession {
            let server = revision.value
            return GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0 else { return }
                let data: Data
                switch message {
                case let .data(value): data = value
                case let .string(value): data = Data(value.utf8)
                @unknown default: return
                }
                guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = frame["id"] as? String, let method = frame["method"] as? String else { return }
                let params = frame["params"] as? [String: Any] ?? [:]
                let payload: String
                if method == "config.get" {
                    requests.withValue { $0["\(server):config.get", default: 0] += 1 }
                }
                if method == "config.schema.lookup", let path = params["path"] as? String {
                    let count = requests.withValue { requests in
                        requests["\(server):\(path)", default: 0] += 1
                        return requests["\(server):\(path)"]!
                    }
                    if server == 2, path == ".", count == 1 { await replacementRootGate.suspend() }
                    if server == 2, count == 1 || (path == "browser" && !sectionRecovers) {
                        socket.emitReceiveSuccess(.string(
                            #"""
                            {"type":"res","id":"\#(id)","ok":false,
                             "error":{"code":"UNAVAILABLE","message":"Synthetic \#(path) lookup failed"}}
                            """#))
                        return
                    }
                    payload = path == "."
                        ? #"""
                        {"path":".","schema":{"type":"object"},"children":[
                         {"key":"browser","path":"browser","type":"object","hasChildren":true}]}
                        """#
                        : #"""
                        {"path":"browser","schema":{"type":"object","properties":{
                         "enabled":{"type":"boolean"}}},"children":[]}
                        """#
                } else {
                    switch method {
                    case "config.get":
                        payload = #"{"hash":"synthetic-config","valid":true,"config":{"browser":{"enabled":true}}}"#
                    case "config.schema":
                        payload = #"""
                        {"schema":{"type":"object"},"uiHints":{},"version":"synthetic","generatedAt":"2026-09-03"}
                        """#
                    case "channels.status":
                        payload = #"""
                        {"ts":1,"channelOrder":[],"channelLabels":{},"channels":{},
                         "channelAccounts":{},"channelDefaultAccountId":{}}
                        """#
                    default:
                        payload = #"{"ok":true}"#
                    }
                }
                socket.emitReceiveSuccess(.string(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#))
            })
        }
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                let selected = revision.value
                return .init(
                    config: (URL(string: "ws://127.0.0.1:\(33300 + selected)")!, nil, nil),
                    routeAuthority: selected,
                    revision: selected)
            },
            currentEndpointRevision: { revision.value },
            sessionBox: WebSocketSessionBox(session: session))
    }
}
