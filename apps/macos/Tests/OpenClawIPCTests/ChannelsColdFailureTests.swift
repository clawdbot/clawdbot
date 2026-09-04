import AppKit
import ApplicationServices
import ConcurrencyExtras
import Observation
import SwiftUI
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
@MainActor
struct ChannelsColdFailureTests {
    @Test(arguments: ["channels", "config"], [false, true])
    func `cold Gateway failure is visible and retires with its selected endpoint`(
        pane: String,
        hasPriorFailure: Bool) async throws
    {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let revision = LockIsolated<UInt64>(1)
            let holdAcquisition = LockIsolated(false)
            let acquisitionGate = GatewayConnectionSuspensionGate()
            let gateway = GatewayConnection(
                testEndpointProvider: {
                    let selectedRevision = revision.value
                    if holdAcquisition.value { await acquisitionGate.suspend() }
                    throw NSError(domain: "ChannelsColdFailureTests", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "Synthetic Gateway \(selectedRevision == 1 ? "A" : "B") unavailable",
                    ])
                },
                currentEndpointRevision: { revision.value })
            let store = ChannelsStore(isPreview: true, gateway: gateway)
            let message = "Synthetic Gateway A unavailable"
            if hasPriorFailure {
                await store.refresh(probe: false)
                try #require(store.lastError == message)
            }
            holdAcquisition.setValue(true)
            let root = pane == "channels"
                ? AnyView(ChannelsSettings(store: store, isActive: false))
                : AnyView(ConfigSettings(store: store, isActive: true))
            let hosting = NSHostingView(rootView: root)
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
                let positive = pane == "channels" ? "Show QR" : "Config"
                let retryLabel = pane == "channels" ? "Refresh" : "Reload"
                if pane == "channels" {
                    _ = try await Self.waitForContent(hosting) {
                        $0.contains(hasPriorFailure ? message : positive)
                    }
                    try await Self.press(retryLabel, in: hosting)
                }
                await acquisitionGate.waitUntilStarted()
                if hasPriorFailure {
                    let before = try await Self.waitForContent(hosting) { labels in
                        let renderedError = labels.contains { $0.contains(message) }
                        return labels.contains(positive) && renderedError == (store.lastError == message)
                    }
                    try #require(store.source == nil)
                    try #require(before.labels.contains(positive), "Rendered \(pane) labels: \(before.labels)")
                    #expect(
                        before.labels.contains { $0.contains(message) },
                        "The last Gateway failure must remain visible while \(pane) retries acquisition")
                    #expect(before.actions[retryLabel] == true, "Cold failure must leave \(retryLabel) available")
                } else {
                    var showsProgress = false
                    let deadline = ContinuousClock.now + .seconds(3)
                    repeat {
                        hosting.layoutSubtreeIfNeeded()
                        window.displayIfNeeded()
                        showsProgress = try await channelsColdFailureElements(hosting).contains {
                            let role = $0.accessibilityRole?()
                            return role == .busyIndicator || role == .progressIndicator
                        }
                        if showsProgress { break }
                        try await Task.sleep(for: .milliseconds(20))
                    } while ContinuousClock.now < deadline
                    #expect(showsProgress, "The first cold \(pane) acquisition must show pending work")
                }

                let invalidated = LockIsolated(false)
                withObservationTracking { _ = store.lastError } onChange: { invalidated.setValue(true) }
                revision.setValue(2)
                holdAcquisition.setValue(false)
                try? await gateway.refresh()
                #expect(store.lastError != message)
                if hasPriorFailure { #expect(invalidated.value) }
                let after = try await Self.waitForContent(hosting) { labels in
                    !labels.contains { $0.contains(message) }
                }
                #expect(!after.labels.contains { $0.contains(message) })
                await acquisitionGate.open()
                // Resuming acquisition does not wait for SwiftUI to replace its loading view.
                let ready = try await Self.waitForContent(hosting) { $0.contains(retryLabel) }
                try #require(ready.actions[retryLabel] == true)
                try await Self.press(retryLabel, in: hosting)
                let replacementMessage = "Synthetic Gateway B unavailable"
                let replacement = try await Self.waitForContent(hosting) { labels in
                    labels.contains { $0.contains(replacementMessage) }
                }
                #expect(replacement.labels.contains { $0.contains(replacementMessage) })
                #expect(!replacement.labels.contains { $0.contains(message) })
                result = .success(())
            } catch {
                result = .failure(error)
            }
            holdAcquisition.setValue(false)
            await acquisitionGate.open()
            await gateway.shutdown()
            try result.get()
        }
    }

    fileprivate static func press(_ label: String, in hosting: NSView) async throws {
        let elements = try await channelsColdFailureElements(hosting)
        let button = try #require(elements.first { element in
            element.accessibilityRole?() == .button &&
                [element.accessibilityLabel?(), element.accessibilityTitle?()].contains(label)
        })
        try #require(button.accessibilityPerformPress?() == true)
    }

    fileprivate static func waitForContent(
        _ hosting: NSView,
        until condition: ([String]) -> Bool) async throws -> (labels: [String], actions: [String: Bool])
    {
        var content: (labels: [String], actions: [String: Bool]) = ([], [:])
        let deadline = ContinuousClock.now + .seconds(3)
        repeat {
            hosting.layoutSubtreeIfNeeded()
            hosting.window?.displayIfNeeded()
            content = try await channelsColdFailureContent(hosting)
            if condition(content.labels) { return content }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        return content
    }
}

@MainActor
private func channelsColdFailureContent(_ root: NSView) async throws -> (labels: [String], actions: [String: Bool]) {
    var labels: [String] = []
    var actions: [String: Bool] = [:]
    for element in try await channelsColdFailureElements(root) {
        let value: Any? = element.accessibilityValue?()
        let text = [
            element.accessibilityLabel?(), element.accessibilityTitle?(), value as? String,
        ].compactMap(\.self)
        labels.append(contentsOf: text)
        let role = element.accessibilityRole?()
        if let enabled = element.isAccessibilityEnabled?(), role == .button || role == .link {
            for label in text {
                actions[label] = enabled
            }
        }
    }
    return (labels, actions)
}

@MainActor
private func channelsColdFailureElements(_ root: NSView) async throws -> [AnyObject] {
    // Use the existing Instances/onboarding AX fixture; SwiftUI materializes its
    // virtual children only after a client asks while MainActor can respond.
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

@Suite(.serialized)
@MainActor
struct ConfigLookupOwnershipTests {
    @Test func `cancelling one acquisition caller preserves its live joiner`() async {
        await TestIsolation.withIsolatedState {
            let fixture = ConfigLookupFixture()
            fixture.endpointGates.withValue { $0[1] = fixture.endpointGate }
            let store = ChannelsStore(isPreview: true, gateway: fixture.gateway)
            let first = Task { await store.resolveSource() }
            await fixture.endpointGate.waitUntilStarted()
            let joinedStarted = LockIsolated(false)
            let joined = Task {
                joinedStarted.setValue(true)
                return await store.resolveSource()
            }
            while !joinedStarted.value {
                await Task.yield()
            }
            first.cancel()
            await fixture.endpointGate.open()
            let source = await joined.value
            _ = await first.value
            #expect(source.map(store.owns) == true)
            #expect(store.lastError == nil)
            #expect(fixture.healthReads.value == 1)
            await fixture.gateway.shutdown()
        }
    }

    @Test func `a retired acquisition cannot clear the replacement pending state`() async {
        await TestIsolation.withIsolatedState {
            let fixture = ConfigLookupFixture()
            let replacementGate = GatewayConnectionSuspensionGate()
            fixture.endpointGates.withValue {
                $0[1] = fixture.endpointGate
                $0[2] = replacementGate
            }
            let store = ChannelsStore(isPreview: true, gateway: fixture.gateway)
            let first = Task { await store.resolveSource() }
            await fixture.endpointGate.waitUntilStarted()
            fixture.revision.setValue(2)
            let replacement = Task { await store.resolveSource() }
            await replacementGate.waitUntilStarted()
            await fixture.endpointGate.open()
            _ = await first.value
            #expect(store.source == nil)
            #expect(store.isAcquiringSource)
            #expect(store.lastError == nil)
            await replacementGate.open()
            let source = await replacement.value
            #expect(source?.lease.endpointRevision == 2)
            #expect(source.map(store.owns) == true)
            #expect(!store.isAcquiringSource)
            #expect(store.lastError == nil)
            await fixture.gateway.shutdown()
        }
    }

    @Test(arguments: [false, true])
    func `successful acquisition retires a cold failure before same-revision shutdown`(fromPush: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = ConfigLookupFixture()
            fixture.endpointAvailable.setValue(false)
            let store = ChannelsStore(isPreview: !fromPush, gateway: fixture.gateway)
            await store.refresh(probe: false)
            try #require(store.lastError == "Synthetic cold source unavailable")
            var heldAcquisition: Task<ChannelsStore.Source?, Never>?
            let result: Result<Void, Error>
            do {
                if fromPush {
                    fixture.endpointGates.withValue { $0[1] = fixture.endpointGate }
                    store.start()
                    await fixture.endpointGate.waitUntilStarted()
                    let joined = LockIsolated(false)
                    heldAcquisition = Task {
                        joined.setValue(true)
                        return await store.resolveSource()
                    }
                    while !joined.value {
                        await Task.yield()
                    }
                }
                fixture.endpointAvailable.setValue(true)
                if fromPush {
                    _ = try await fixture.gateway.acquireServerLease()
                    let deadline = ContinuousClock.now + .seconds(3)
                    while store.source == nil, ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                } else {
                    _ = await store.resolveSource()
                }
                let source = try #require(store.source)
                try #require(store.owns(source))
                #expect(store.lastError == nil)
                #expect(!store.isAcquiringSource, "An admitted Source must end the visible connection attempt")
                await fixture.endpointGate.open()
                // A failed acquisition that preceded the push cannot replace the
                // successful Source; shutdown must not resurrect that cold error.
                if let heldAcquisition {
                    _ = await heldAcquisition.value
                    #expect(store.lastError == nil)
                }
                await fixture.gateway.shutdown()
                if fromPush {
                    let deadline = ContinuousClock.now + .seconds(3)
                    while store.source != nil, ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                } else {
                    store.clearSource()
                }
                #expect(store.source == nil)
                #expect(store.lastError == nil)
                result = .success(())
            } catch {
                result = .failure(error)
            }
            await fixture.endpointGate.open()
            _ = await heldAcquisition?.value
            store.stop()
            await fixture.gateway.shutdown()
            try result.get()
        }
    }

    @Test func `root completion does not retry a failed selected section`() async throws {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let fixture = ConfigLookupFixture(failFirstSection: true, holdValues: true)
            let store = ChannelsStore(isPreview: true, gateway: fixture.gateway)
            _ = await store.resolveSource()
            await fixture.rootGate.open()
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
                await fixture.valueGate.waitUntilStarted()
                let before = try await ChannelsColdFailureTests.waitForContent(hosting) { labels in
                    labels.contains { $0.contains("Synthetic section lookup failed") }
                }
                try #require(before.actions["Retry"] == true)
                try #require(fixture.sectionRequests.value == 1)
                try #require(!store.configLoaded)
                await fixture.valueGate.open()
                // Give the root task its normal completion; only an operator Retry
                // may replace the section's already-recorded failure.
                let after = try await ChannelsColdFailureTests.waitForContent(hosting) { $0.contains("Enabled") }
                #expect(store.configLoaded)
                #expect(fixture.sectionRequests.value == 1)
                #expect(after.actions["Retry"] == true)
                #expect(!after.labels.contains("Enabled"))
                if after.actions["Retry"] == true {
                    try await ChannelsColdFailureTests.press("Retry", in: hosting)
                }
                let retried = try await ChannelsColdFailureTests.waitForContent(hosting) { $0.contains("Enabled") }
                #expect(retried.labels.contains("Enabled"))
                #expect(fixture.sectionRequests.value == 2)
                result = .success(())
            } catch {
                result = .failure(error)
            }
            await fixture.valueGate.open()
            await fixture.rootGate.open()
            await fixture.gateway.shutdown()
            try result.get()
        }
    }

    @Test func `a joining root lookup survives cancellation of its first caller`() async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = ConfigLookupFixture()
            let store = ChannelsStore(isPreview: true, gateway: fixture.gateway)
            let first = Task { await store.loadConfigSchemaLookup(path: ".") != nil }
            let deadline = ContinuousClock.now + .seconds(3)
            while !fixture.rootRequested.value, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            let joinedStarted = LockIsolated(false)
            let joined = Task {
                joinedStarted.setValue(true)
                return await store.loadConfigSchemaLookup(path: ".") != nil
            }
            while !joinedStarted.value {
                await Task.yield()
            }
            first.cancel()
            await fixture.rootGate.open()
            _ = await first.value
            let joinedLoaded = await joined.value
            #expect(fixture.rootRequested.value)
            #expect(joinedLoaded)
            #expect(store.configLookupRoot?.path == ".")
            await fixture.gateway.shutdown()
        }
    }

    @Test(arguments: [true, false])
    func `Config opening completes its root lookup after acquiring a Source`(sourceAlreadyAcquired: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let fixture = ConfigLookupFixture()
            let store = ChannelsStore(isPreview: true, gateway: fixture.gateway)
            if sourceAlreadyAcquired { _ = await store.resolveSource() }
            try #require((store.source != nil) == sourceAlreadyAcquired)
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
                let deadline = ContinuousClock.now + .seconds(3)
                while !fixture.rootRequested.value, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(fixture.rootRequested.value, "Config must request the root schema")
                hosting.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                // Let SwiftUI process the Source change while the first root read remains pending.
                try await Task.sleep(for: .milliseconds(200))
                await fixture.rootGate.open()
                var labels: [String] = []
                let finished = ContinuousClock.now + .seconds(3)
                repeat {
                    hosting.layoutSubtreeIfNeeded()
                    window.displayIfNeeded()
                    labels = try await channelsColdFailureContent(hosting).labels
                    if store.configLookupRoot != nil, labels.contains("Browser") { break }
                    try await Task.sleep(for: .milliseconds(20))
                } while ContinuousClock.now < finished
                #expect(store.configLookupRoot?.path == ".", "Config status: \(store.configStatus ?? "none")")
                #expect(labels.contains("Browser"), "Rendered Config labels: \(labels)")
                #expect(!labels.contains("Schema unavailable."))
                result = .success(())
            } catch {
                result = .failure(error)
            }
            await fixture.rootGate.open()
            await fixture.gateway.shutdown()
            try result.get()
        }
    }
}

@Suite(.serialized)
@MainActor
struct ConfigReloadRecoveryTests {
    @Test func `Reload recovers a failed root schema without reactivating Config`() async throws {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let fixture = ConfigLookupFixture(failFirstRoot: true)
            let store = ChannelsStore(isPreview: true, gateway: fixture.gateway)
            _ = await store.resolveSource()
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
                let loaded = ContinuousClock.now + .seconds(3)
                while !store.configLoaded, ContinuousClock.now < loaded {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(store.configLoaded)
                await fixture.rootGate.open()
                var content: (labels: [String], actions: [String: Bool]) = ([], [:])
                let failed = ContinuousClock.now + .seconds(3)
                repeat {
                    hosting.layoutSubtreeIfNeeded()
                    window.displayIfNeeded()
                    content = try await channelsColdFailureContent(hosting)
                    if content.labels.contains(where: { $0.contains("Synthetic root lookup failed") }) { break }
                    try await Task.sleep(for: .milliseconds(20))
                } while ContinuousClock.now < failed
                try #require(content.labels.contains { $0.contains("Synthetic root lookup failed") })
                try #require(store.configLookupRoot == nil)
                try #require(fixture.rootRequests.value == 1)
                try #require(content.actions["Reload"] == true)
                let elements = try await channelsColdFailureElements(hosting)
                let reload = try #require(elements.first { element in
                    element.accessibilityRole?() == .button &&
                        [element.accessibilityLabel?(), element.accessibilityTitle?()].contains("Reload")
                })
                try #require(reload.accessibilityPerformPress?() == true)
                let recovered = ContinuousClock.now + .seconds(3)
                repeat {
                    hosting.layoutSubtreeIfNeeded()
                    window.displayIfNeeded()
                    content = try await channelsColdFailureContent(hosting)
                    if store.configLookupRoot != nil, content.labels.contains("Browser") { break }
                    try await Task.sleep(for: .milliseconds(20))
                } while ContinuousClock.now < recovered
                #expect(fixture.configReads.value >= 2, "Reload must invoke the existing config-value read")
                #expect(fixture.rootRequests.value == 2)
                #expect(store.configLookupRoot?.path == ".")
                #expect(content.labels.contains("Browser"), "Rendered Config labels: \(content.labels)")
                result = .success(())
            } catch {
                result = .failure(error)
            }
            await fixture.rootGate.open()
            await fixture.gateway.shutdown()
            try result.get()
        }
    }
}

private final class ConfigLookupFixture: @unchecked Sendable {
    let revision = LockIsolated<UInt64>(1)
    let endpointAvailable = LockIsolated(true)
    let endpointGates = LockIsolated<[UInt64: GatewayConnectionSuspensionGate]>([:])
    let endpointGate = GatewayConnectionSuspensionGate()
    let rootRequested = LockIsolated(false)
    let rootRequests = LockIsolated(0)
    let configReads = LockIsolated(0)
    let healthReads = LockIsolated(0)
    let sectionRequests = LockIsolated(0)
    let rootGate = GatewayConnectionSuspensionGate()
    let valueGate = GatewayConnectionSuspensionGate()
    let gateway: GatewayConnection

    init(failFirstRoot: Bool = false, failFirstSection: Bool = false, holdValues: Bool = false) {
        let endpointAvailable = self.endpointAvailable
        let endpointGates = self.endpointGates
        let revision = self.revision
        let rootRequested = self.rootRequested
        let rootRequests = self.rootRequests
        let configReads = self.configReads
        let healthReads = self.healthReads
        let sectionRequests = self.sectionRequests
        let rootGate = self.rootGate
        let valueGate = self.valueGate
        let session = GatewayTestWebSocketSession {
            GatewayTestWebSocketTask(sendHook: { socket, message, index in
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
                switch method {
                case "health":
                    healthReads.withValue { $0 += 1 }
                    payload = #"{"ok":true}"#
                case "channels.status":
                    payload = #"""
                    {"ts":1,"channelOrder":[],"channelLabels":{},"channels":{},
                     "channelAccounts":{},"channelDefaultAccountId":{}}
                    """#
                case "config.get":
                    configReads.withValue { $0 += 1 }
                    if holdValues { await valueGate.suspend() }
                    payload = #"{"hash":"gateway-a","valid":true,"config":{"browser":{"enabled":true}}}"#
                case "config.schema.lookup":
                    if params["path"] as? String == "." {
                        rootRequests.withValue { $0 += 1 }
                        let first = rootRequested.withValue { requested in
                            defer { requested = true }
                            return !requested
                        }
                        if first { await rootGate.suspend() }
                        if first, failFirstRoot {
                            socket.emitReceiveSuccess(.string(
                                #"""
                                {"type":"res","id":"\#(id)","ok":false,
                                 "error":{"code":"UNAVAILABLE","message":"Synthetic root lookup failed"}}
                                """#))
                            return
                        }
                        payload = #"""
                        {"path":".","schema":{"type":"object"},"children":[
                         {"key":"browser","path":"browser","type":"object","hasChildren":true}]}
                        """#
                    } else {
                        let request = sectionRequests.withValue { count in
                            count += 1
                            return count
                        }
                        if failFirstSection, request == 1 {
                            socket.emitReceiveSuccess(.string(
                                #"""
                                {"type":"res","id":"\#(id)","ok":false,
                                 "error":{"code":"UNAVAILABLE","message":"Synthetic section lookup failed"}}
                                """#))
                            return
                        }
                        payload = #"""
                        {"path":"browser","schema":{"type":"object","properties":{
                         "enabled":{"type":"boolean"}}},"children":[]}
                        """#
                    }
                default: payload = #"{"ok":true}"#
                }
                socket.emitReceiveSuccess(.string(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#))
            })
        }
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                let available = endpointAvailable.value
                let selectedRevision = revision.value
                let gate = endpointGates.withValue { $0.removeValue(forKey: selectedRevision) }
                if let gate { await gate.suspend() }
                guard available else {
                    throw NSError(domain: "ConfigLookupFixture", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "Synthetic cold source unavailable",
                    ])
                }
                return .init(
                    config: (URL(string: "ws://127.0.0.1:\(33200 + selectedRevision)")!, nil, nil),
                    routeAuthority: selectedRevision,
                    revision: selectedRevision)
            },
            currentEndpointRevision: { revision.value },
            sessionBox: WebSocketSessionBox(session: session))
    }
}
