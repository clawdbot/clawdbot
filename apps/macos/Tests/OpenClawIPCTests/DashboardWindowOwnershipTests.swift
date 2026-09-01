import AppKit
import Foundation
import OpenClawKit
import Testing
import WebKit
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
    private let firstURL: URL
    private var firstRequested = false
    private var firstContinuation: CheckedContinuation<Void, Never>?

    init(firstURL: URL) {
        self.firstURL = firstURL
    }

    func authToken(for config: GatewayConnection.Config) async -> String? {
        if config.url == self.firstURL {
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
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let url = server.url("/#token=before")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "before",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        let originalWindow = try #require(controller.window)
        let gate = DashboardWindowOwnershipAuthGate()
        let readyState = GatewayEndpointState.ready(
            mode: .remote,
            url: replacementServer.websocketURL(""),
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
            replacementServer.url("/#token=after").absoluteString)
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
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let currentServer = try await DashboardHTTPFixture.start()
        defer { currentServer.stop() }
        let url = server.url("/#token=initial")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "initial",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        let originalWindow = try #require(controller.window)
        let gate = DashboardWindowOwnershipEndpointGate(firstURL: replacementServer.websocketURL(""))
        let manager = DashboardManager._testMake(
            authTokenProvider: { config in await gate.authToken(for: config) })
        manager._testSetController(controller)
        defer { manager.close() }

        let staleState = GatewayEndpointState.ready(
            mode: .remote,
            url: replacementServer.websocketURL(""),
            token: nil,
            password: nil,
            routeRevision: 1)
        let currentState = GatewayEndpointState.ready(
            mode: .remote,
            url: currentServer.websocketURL(""),
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
            currentServer.url("/#token=current").absoluteString)
        let authScripts = currentController._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(authScripts.count == 1)
        #expect(authScripts[0].source.contains("current"))
        #expect(!authScripts[0].source.contains("stale"))
    }

    @Test func `reopening after credential changes isolates the privileged document`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let url = server.url("/#token=before")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "before",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        let originalWindow = try #require(controller.window)
        let originalDocument = controller._testDashboardWebViewIdentity
        originalWindow.orderOut(nil)
        let endpointURL = server.websocketURL("/")

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
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let url = server.url("/#token=before")
        let originalWindow = DashboardWindowOwnershipTrackingWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "before",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            reusingWindow: originalWindow,
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        originalWindow.simulatesKeyWindow = true

        let manager = DashboardManager._testMake()
        manager._testSetController(controller)
        defer { manager.close() }

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: replacementServer.websocketURL("/"),
            token: "after",
            password: nil,
            routeRevision: 2))

        let replacement = try #require(manager._testController())
        let responder = try #require(originalWindow.firstResponder as? NSView)
        #expect(ObjectIdentifier(responder) == replacement._testDashboardWebViewIdentity)
    }

    @Test func `stale async presentation cannot overwrite a newer endpoint`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let currentServer = try await DashboardHTTPFixture.start()
        defer { currentServer.stop() }
        let url = server.url("/#token=initial")
        let originalWindow = DashboardWindowOwnershipTrackingWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "initial",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            reusingWindow: originalWindow,
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        let staleEndpointURL = replacementServer.websocketURL("/")
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
        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: currentServer.websocketURL("/"),
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
            currentServer.url("/#token=current").absoluteString)
    }

    @Test func `hidden dashboard invalidates stale reopening authority`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let currentServer = try await DashboardHTTPFixture.start()
        defer { currentServer.stop() }
        let url = server.url("/#token=initial")
        let staleEndpointURL = replacementServer.websocketURL("/")
        let currentEndpointURL = currentServer.websocketURL("/")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "initial",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
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
            currentServer.url("/#token=current").absoluteString)
    }

    @Test func `superseded endpoint failure preserves a newer live dashboard`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let currentServer = try await DashboardHTTPFixture.start()
        defer { currentServer.stop() }
        let url = server.url("/#token=initial")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "initial",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
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
        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: currentServer.websocketURL("/"),
            token: "current",
            password: nil,
            routeRevision: 2))
        let currentController = try #require(manager._testController())
        await gate.release()
        try await presentation.value

        #expect(manager._testController() === currentController)
        #expect(currentController.window === originalWindow)
        #expect(currentController.currentURL.absoluteString ==
            currentServer.url("/#token=current").absoluteString)
    }

    @Test func `window handoff ignores a conflicting target autosave frame`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let url = server.url("/#token=before")
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
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "before",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: originalAutosaveName,
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        let originalWindow = try #require(controller.window)
        let originalFrame = originalWindow.frame
        let transferredWindow = try #require(controller.detachWindowForReplacement())
        let replacement = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "after",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: targetAutosaveName,
            reusingWindow: transferredWindow,
            requestBrowserProfileImportOffer: { _ in false })
        defer { replacement.closeDashboard() }

        #expect(replacement.window === originalWindow)
        #expect(originalWindow.frame == originalFrame)
    }

    @Test func `concurrent explicit opens share one presentation owner`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let dataStore = WKWebsiteDataStore.nonPersistent()
        let endpointURL = server.websocketURL("/")
        let gate = DashboardWindowOwnershipPresentationGate()
        let probes = AsyncStream<DashboardRouteProbePurpose>.makeStream()
        defer { probes.continuation.finish() }
        let manager = DashboardManager._testMake(
            websiteDataStore: dataStore,
            routeProbe: { probes.continuation.yield($0) },
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
            server.url("/#token=shared").absoluteString)
        try await self.expectPresentationProbe(from: probes.stream)

        let autosaveName = try #require(controller.window?.frameAutosaveName)
        #expect(autosaveName.hasPrefix("OpenClawDashboardWindow-Test-"))
        #expect(controller._testDashboardDataStore === dataStore)
        #expect(!controller._testDashboardDataStore.isPersistent)
        controller._testOpenLinkBrowser(server.url("/reader/first"))
        #expect(controller._testLinkBrowserDataStore === dataStore)

        await manager.handleEndpointState(.connecting(mode: .remote, detail: "Reconnecting"))
        let failure = try #require(manager._testController())
        #expect(failure !== controller)
        #expect(failure._testDashboardDataStore === dataStore)
        #expect(failure.window?.frameAutosaveName == autosaveName)

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: endpointURL,
            token: "recovered",
            password: nil,
            routeRevision: 2))
        let recovered = try #require(manager._testController())
        #expect(recovered !== failure)
        #expect(recovered._testDashboardDataStore === dataStore)
        #expect(recovered.window?.frameAutosaveName == autosaveName)
        recovered._testOpenLinkBrowser(server.url("/reader/recovered"))
        #expect(recovered._testLinkBrowserDataStore === dataStore)
    }

    @Test func `configured presentation uses its owned health probe`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        let config = """
        {"gateway":{"remote":{"transport":"direct","url":"\(server.websocketURL())","token":"configured"}}}
        """
        try Data(config.utf8).write(to: URL(fileURLWithPath: configPath))
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_TOKEN": nil,
            "OPENCLAW_GATEWAY_PASSWORD": nil,
        ]) {
            let state = AppStateStore.shared
            let originalMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = originalMode }
            let probes = AsyncStream<DashboardRouteProbePurpose>.makeStream()
            defer { probes.continuation.finish() }
            let manager = DashboardManager._testMake(
                routeProbe: { probes.continuation.yield($0) },
                gatewayEntriesProvider: { [Self.primaryGateway] })
            defer { manager.close() }

            #expect(manager.showConfiguredWindowIfPossible())
            let controller = try #require(manager._testController())
            #expect(controller.isWindowOpen)
            #expect(controller.currentURL.absoluteString ==
                server.url("/#token=configured").absoluteString)
            try await self.expectPresentationProbe(from: probes.stream)
        }
    }

    private func expectPresentationProbe(from probes: AsyncStream<DashboardRouteProbePurpose>) async throws {
        let purpose = try await AsyncTimeout.withTimeout(
            seconds: 3,
            onTimeout: { NSError(domain: "DashboardPresentationProbe", code: 1) },
            operation: { await probes.first(where: { _ in true }) })
        #expect(purpose == .presentation)
    }
}
