import AppKit
import Foundation
import Testing
@testable import OpenClaw

private actor DashboardWindowOwnershipAuthGate {
    private var value: String?

    func authToken() -> String? {
        self.value
    }

    func update(_ value: String) {
        self.value = value
    }
}

private actor DashboardWindowOwnershipEndpointGate {
    private var firstRequested = false
    private var firstContinuation: CheckedContinuation<Void, Never>?

    func authToken(for config: GatewayConnection.Config) async -> String? {
        if config.url.port == 60002 {
            self.firstRequested = true
            await withCheckedContinuation { continuation in
                self.firstContinuation = continuation
            }
            return "stale"
        }
        return "current"
    }

    func waitUntilFirstRequested() async {
        while !self.firstRequested {
            await Task.yield()
        }
    }

    func releaseFirst() {
        self.firstContinuation?.resume()
        self.firstContinuation = nil
    }
}

private actor DashboardWindowOwnershipPresentationGate {
    private var requested = false
    private var released = false
    private var requestCount = 0
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func waitForRelease() async {
        self.requested = true
        self.requestCount += 1
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            self.continuations.append(continuation)
        }
    }

    func waitUntilRequested() async {
        while !self.requested {
            await Task.yield()
        }
    }

    func numberOfRequests() -> Int {
        self.requestCount
    }

    func release() {
        self.released = true
        for continuation in self.continuations {
            continuation.resume()
        }
        self.continuations.removeAll()
    }
}

private struct DashboardWindowOwnershipEndpointFailure: Error {}

@MainActor
private final class DashboardWindowOwnershipTrackingWindow: NSWindow {
    var simulatesKeyWindow = false
    private(set) var foregroundRequestCount = 0

    override var isKeyWindow: Bool {
        self.simulatesKeyWindow
    }

    override func makeKeyAndOrderFront(_ sender: Any?) {
        self.foregroundRequestCount += 1
        super.makeKeyAndOrderFront(sender)
    }
}

@Suite(.serialized)
@MainActor
struct DashboardWindowOwnershipTests {
    private static let primaryGateway = DashboardGatewayEntry(
        id: "primary",
        name: "Local Gateway",
        kind: "local",
        isPrimary: true,
        canPromote: false,
        health: .ok)

    @Test func `disconnect and auth recovery preserve one native window`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=before"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "before",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        controller.show()
        let originalWindow = try #require(controller.window)
        let gate = DashboardWindowOwnershipAuthGate()
        let readyState = try GatewayEndpointState.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60002")),
            token: nil,
            password: nil,
            routeRevision: 2)
        let manager = DashboardManager._testMake(
            authTokenProvider: { _ in await gate.authToken() },
            endpointStateProvider: { readyState })
        manager._testSetController(controller)
        defer { manager.close() }

        await manager.handleEndpointState(readyState)
        let failureController = try #require(manager._testController())
        #expect(failureController !== controller)
        #expect(failureController.window === originalWindow)
        #expect(failureController.isWindowOpen)
        #expect(failureController.currentURL == URL(string: "about:blank"))

        await manager.handleEndpointState(.connecting(mode: .remote, detail: "Connecting"))
        await manager.handleEndpointState(.unavailable(mode: .remote, reason: "Unavailable"))
        #expect(manager._testController() === failureController)
        #expect(failureController.window === originalWindow)

        await gate.update("after")
        await manager._testHandleControlChannelStateChange(.connected)
        let recoveredController = try #require(manager._testController())
        #expect(recoveredController !== failureController)
        #expect(recoveredController.window === originalWindow)
        #expect(recoveredController.currentURL.absoluteString ==
            "http://127.0.0.1:60002/#token=after")
        let authScripts = recoveredController._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(authScripts.count == 1)
        #expect(authScripts[0].source.contains("after"))
        #expect(!authScripts[0].source.contains("before"))

        await manager._testHandleControlChannelStateChange(.connected)
        #expect(manager._testController() === recoveredController)
        #expect(recoveredController.window === originalWindow)
    }

    @Test func `overlapping endpoint updates cannot orphan a dashboard window`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=initial"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "initial",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        controller.show()
        let originalWindow = try #require(controller.window)
        let gate = DashboardWindowOwnershipEndpointGate()
        let manager = DashboardManager._testMake(
            authTokenProvider: { config in await gate.authToken(for: config) })
        manager._testSetController(controller)
        defer { manager.close() }

        let staleState = try GatewayEndpointState.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60002")),
            token: nil,
            password: nil,
            routeRevision: 1)
        let currentState = try GatewayEndpointState.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60003")),
            token: nil,
            password: nil,
            routeRevision: 2)

        let staleUpdate = Task { @MainActor in
            await manager.handleEndpointState(staleState)
        }
        await gate.waitUntilFirstRequested()
        await manager.handleEndpointState(currentState)
        let currentController = try #require(manager._testController())
        await gate.releaseFirst()
        await staleUpdate.value

        #expect(manager._testController() === currentController)
        #expect(currentController.window === originalWindow)
        #expect(currentController.currentURL.absoluteString ==
            "http://127.0.0.1:60003/#token=current")
        let authScripts = currentController._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(authScripts.count == 1)
        #expect(authScripts[0].source.contains("current"))
        #expect(!authScripts[0].source.contains("stale"))
    }

    @Test func `reopening after credential changes isolates the privileged document`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=before"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "before",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        controller.show()
        let originalWindow = try #require(controller.window)
        let originalDocument = controller._testDashboardWebViewIdentity
        originalWindow.orderOut(nil)
        let endpointURL = try #require(URL(string: "ws://127.0.0.1:60001/"))

        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (url: endpointURL, token: "after", password: nil),
                    routeAuthority: 2,
                    revision: 2)
            },
            gatewayEntriesProvider: { [Self.primaryGateway] })
        manager._testSetController(controller)
        defer { manager.close() }

        try await manager.show()

        let replacement = try #require(manager._testController())
        #expect(replacement !== controller)
        #expect(replacement.window === originalWindow)
        #expect(replacement._testDashboardWebViewIdentity != originalDocument)
        let authScripts = replacement._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(authScripts.count == 1)
        #expect(authScripts[0].source.contains("after"))
        #expect(!authScripts[0].source.contains("before"))
    }

    @Test func `replacing a key dashboard transfers keyboard ownership`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=before"))
        let originalWindow = DashboardWindowOwnershipTrackingWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "before",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            reusingWindow: originalWindow)
        controller.show()
        originalWindow.simulatesKeyWindow = true

        let manager = DashboardManager._testMake()
        manager._testSetController(controller)
        defer { manager.close() }

        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60002/")),
            token: "after",
            password: nil,
            routeRevision: 2))

        let replacement = try #require(manager._testController())
        let responder = try #require(originalWindow.firstResponder as? NSView)
        #expect(ObjectIdentifier(responder) == replacement._testDashboardWebViewIdentity)
    }

    @Test func `stale async presentation cannot overwrite a newer endpoint`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=initial"))
        let originalWindow = DashboardWindowOwnershipTrackingWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "initial",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            reusingWindow: originalWindow)
        controller.show()
        let staleEndpointURL = try #require(URL(string: "ws://127.0.0.1:60002/"))
        let gate = DashboardWindowOwnershipPresentationGate()
        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in
                await gate.waitForRelease()
                return GatewayConnection.EndpointSnapshot(
                    config: (url: staleEndpointURL, token: "stale", password: nil),
                    routeAuthority: 1,
                    revision: 1)
            },
            gatewayEntriesProvider: { [Self.primaryGateway] })
        manager._testSetController(controller)
        defer { manager.close() }

        let presentation = Task { @MainActor in try await manager.show() }
        await gate.waitUntilRequested()
        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60003/")),
            token: "current",
            password: nil,
            routeRevision: 2))
        let currentController = try #require(manager._testController())
        let backgroundForegroundCount = originalWindow.foregroundRequestCount
        await gate.release()
        try await presentation.value

        #expect(manager._testController() === currentController)
        #expect(currentController.window === originalWindow)
        #expect(originalWindow.foregroundRequestCount > backgroundForegroundCount)
        #expect(currentController.currentURL.absoluteString ==
            "http://127.0.0.1:60003/#token=current")
    }

    @Test func `hidden dashboard invalidates stale reopening authority`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=initial"))
        let staleEndpointURL = try #require(URL(string: "ws://127.0.0.1:60002/"))
        let currentEndpointURL = try #require(URL(string: "ws://127.0.0.1:60003/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "initial",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        controller.show()
        let originalWindow = try #require(controller.window)
        originalWindow.orderOut(nil)
        let gate = DashboardWindowOwnershipPresentationGate()
        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in
                await gate.waitForRelease()
                let request = await gate.numberOfRequests()
                let url = request == 1 ? staleEndpointURL : currentEndpointURL
                let token = request == 1 ? "stale" : "current"
                return GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: token, password: nil),
                    routeAuthority: UInt64(request),
                    revision: UInt64(request))
            },
            gatewayEntriesProvider: { [Self.primaryGateway] })
        manager._testSetController(controller)
        defer { manager.close() }

        let presentation = Task { @MainActor in try await manager.show() }
        await gate.waitUntilRequested()
        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: currentEndpointURL,
            token: "current",
            password: nil,
            routeRevision: 2))
        await gate.release()
        try await presentation.value

        let replacement = try #require(manager._testController())
        #expect(await gate.numberOfRequests() == 2)
        #expect(replacement.window === originalWindow)
        #expect(replacement.currentURL.absoluteString ==
            "http://127.0.0.1:60003/#token=current")
    }

    @Test func `superseded endpoint failure preserves a newer live dashboard`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=initial"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "initial",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        controller.show()
        let originalWindow = try #require(controller.window)
        let gate = DashboardWindowOwnershipPresentationGate()
        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in
                await gate.waitForRelease()
                throw DashboardWindowOwnershipEndpointFailure()
            },
            gatewayEntriesProvider: { [Self.primaryGateway] })
        manager._testSetController(controller)
        defer { manager.close() }

        let presentation = Task { @MainActor in try await manager.show() }
        await gate.waitUntilRequested()
        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60003/")),
            token: "current",
            password: nil,
            routeRevision: 2))
        let currentController = try #require(manager._testController())
        await gate.release()
        try await presentation.value

        #expect(manager._testController() === currentController)
        #expect(currentController.window === originalWindow)
        #expect(currentController.currentURL.absoluteString ==
            "http://127.0.0.1:60003/#token=current")
    }

    @Test func `window handoff ignores a conflicting target autosave frame`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=before"))
        let originalAutosaveName = "OpenClawDashboardWindow-Test-\(UUID().uuidString)"
        let targetAutosaveName = "OpenClawDashboardWindow-Test-\(UUID().uuidString)"
        defer {
            NSWindow.removeFrame(usingName: originalAutosaveName)
            NSWindow.removeFrame(usingName: targetAutosaveName)
        }

        let conflictingWindow = NSWindow(
            contentRect: NSRect(x: 30, y: 30, width: 1200, height: 800),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false)
        conflictingWindow.isReleasedWhenClosed = false
        conflictingWindow.saveFrame(usingName: targetAutosaveName)
        conflictingWindow.close()

        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "before",
                password: nil),
            windowAutosaveName: originalAutosaveName)
        controller.show()
        let originalWindow = try #require(controller.window)
        let originalFrame = originalWindow.frame
        let transferredWindow = try #require(controller.detachWindowForReplacement())
        let replacement = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "after",
                password: nil),
            windowAutosaveName: targetAutosaveName,
            reusingWindow: transferredWindow)
        defer { replacement.closeDashboard() }

        #expect(replacement.window === originalWindow)
        #expect(originalWindow.frame == originalFrame)
    }

    @Test func `concurrent explicit opens share one presentation owner`() async throws {
        let endpointURL = try #require(URL(string: "ws://127.0.0.1:60004/"))
        let gate = DashboardWindowOwnershipPresentationGate()
        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in
                await gate.waitForRelease()
                return GatewayConnection.EndpointSnapshot(
                    config: (url: endpointURL, token: "shared", password: nil),
                    routeAuthority: 1,
                    revision: 1)
            },
            gatewayEntriesProvider: { [Self.primaryGateway] })
        defer { manager.close() }

        let firstPresentation = Task { @MainActor in try await manager.show() }
        await gate.waitUntilRequested()
        let secondPresentation = Task { @MainActor in try await manager.show() }
        await Task.yield()

        #expect(await gate.numberOfRequests() == 1)
        await gate.release()
        try await firstPresentation.value
        try await secondPresentation.value

        let controller = try #require(manager._testController())
        #expect(controller.isWindowOpen)
        #expect(controller.currentURL.absoluteString ==
            "http://127.0.0.1:60004/#token=shared")
    }
}
