import AppKit
import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

@MainActor
private final class DashboardNotificationAlertCapture: NSObject {
    private(set) var textValues: [String] = []

    @objc func captureAndAbortModal() {
        if let contentView = NSApp.modalWindow?.contentView {
            self.textValues = Self.textValues(in: contentView)
        }
        NSApp.abortModal()
    }

    private static func textValues(in view: NSView) -> [String] {
        let current = (view as? NSTextField).map { [$0.stringValue] } ?? []
        return current + view.subviews.flatMap { self.textValues(in: $0) }
    }
}

private struct DashboardNotificationEndpointFailure: Error {}

@MainActor
extension DashboardWindowOwnershipTests {
    @Test func `localized background session failure title`() async throws {
        let probeKey = "OPENCLAW_LOCALIZED_GATEWAY_ERROR_PROBE"
        if ProcessInfo.processInfo.environment[probeKey] != "1" {
            let arguments = ProcessInfo.processInfo.arguments
            let bundleFlagIndex = try #require(arguments.firstIndex(of: "--test-bundle-path"))
            let bundlePathIndex = arguments.index(after: bundleFlagIndex)
            let testBundlePath = try #require(
                arguments.indices.contains(bundlePathIndex) ? arguments[bundlePathIndex] : nil)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: arguments[0])
            process.arguments = [
                "--test-bundle-path", testBundlePath,
                "--testing-library", "swift-testing",
                "--filter", "localized background session failure title",
            ]
            var environment = ProcessInfo.processInfo.environment
            environment[probeKey] = "1"
            process.environment = environment
            let output = Pipe()
            process.standardOutput = output
            process.standardError = output
            try process.run()
            process.waitUntilExit()
            let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            #expect(process.terminationStatus == 0, Comment(rawValue: text))
            #expect(text.contains("\(probeKey)=ok"), Comment(rawValue: text))
            return
        }

        let defaults = UserDefaults.standard
        let argumentDomain = UserDefaults.argumentDomain
        let previousArguments = defaults.volatileDomain(forName: argumentDomain)
        var localizedArguments = previousArguments
        localizedArguments["NSDoubleLocalizedStrings"] = true
        defaults.setVolatileDomain(localizedArguments, forName: argumentDomain)
        defer { defaults.setVolatileDomain(previousArguments, forName: argumentDomain) }

        _ = NSApplication.shared
        let expectedTitle = String(localized: "Could Not Open Background Session")
        #expect(expectedTitle == "Could Not Open Background Session Could Not Open Background Session")
        let manager = DashboardManager._testMake(
            primaryEndpointProvider: { _ in throw DashboardNotificationEndpointFailure() })
        defer { manager.close() }
        let capture = DashboardNotificationAlertCapture()
        let timer = Timer(
            timeInterval: 0.01,
            target: capture,
            selector: #selector(DashboardNotificationAlertCapture.captureAndAbortModal),
            userInfo: nil,
            repeats: false)
        RunLoop.main.add(timer, forMode: .modalPanel)

        let sourceURL = try #require(URL(string: "https://gateway.example"))
        try await manager.openBackgroundSession(
            self.completion(), target: .primary, sourceURL: sourceURL)

        #expect(capture.textValues.contains(expectedTitle))
        print("\(probeKey)=ok")
    }

    @Test func `background completion restores a failed dashboard before navigating`() async throws {
        try await self.withNotificationDashboard { server, manager in
            try await manager.show()
            let controller = try #require(manager._testController())
            try await self.waitForDashboard(controller, path: "/")
            let window = try #require(controller.window)

            controller.webView(controller.webView, didFail: nil, withError: URLError(.networkConnectionLost))
            #expect(!controller.canDeliverNativeCommands)
            try await manager.openBackgroundSession(
                self.completion(), target: .primary, sourceURL: server.url())

            let restored = try #require(manager._testController())
            #expect(restored.window === window)
            #expect(restored.canDeliverNativeCommands)
            try await self.waitForDashboard(restored, path: "/chat/main/dashboard/completed")
            #expect(restored._testPendingNativeNavigation == nil)
        }
    }

    @Test(arguments: ["new-session", "window-close", "manager-close"])
    func `pending notification click cannot supersede newer window intent`(_ action: String) async throws {
        let gate = DashboardWindowOwnershipPresentationGate(released: true)
        try await self.withNotificationDashboard(gate: gate) { server, manager in
            try await manager.show()
            let controller = try #require(manager._testController())
            try await self.waitForDashboard(controller, path: "/")
            await gate.hold()

            let click = Task { @MainActor in
                try await manager.openBackgroundSession(
                    self.completion(), target: .primary, sourceURL: server.url())
            }
            await gate.waitUntilRequested()
            switch action {
            case "new-session": manager.dispatchNativeCommand(.newSession)
            case "window-close": controller.window?.performClose(nil)
            default: manager.close()
            }
            let generation = controller._testNavigationGeneration
            await gate.release()
            try await click.value

            #expect(controller._testPendingNativeNavigation == nil)
            #expect(controller._testNavigationGeneration == generation)
            #expect(controller.currentURL.path == "/")
            #expect(manager._testController() === controller)
            #expect(controller.isWindowOpen == (action == "new-session"))
        }
    }

    @Test func `notification clicked after window close reopens its exact session`() async throws {
        try await self.withNotificationDashboard { server, manager in
            try await manager.show()
            let controller = try #require(manager._testController())
            try await self.waitForDashboard(controller, path: "/")
            let window = try #require(controller.window)
            window.performClose(nil)
            #expect(!controller.isWindowOpen)

            try await manager.openBackgroundSession(
                self.completion(), target: .primary, sourceURL: server.url())

            let reopened = try #require(manager._testController())
            #expect(reopened.window === window)
            #expect(reopened.isWindowOpen)
            try await self.waitForDashboard(reopened, path: "/chat/main/dashboard/completed")
        }
    }

    @Test func `profile notification survives unrelated primary endpoint updates`() async throws {
        let gate = DashboardWindowOwnershipPresentationGate(released: true)
        try await self.withNotificationDashboard(gate: gate) { server, manager in
            let target = DashboardGatewayTarget.profile("background")
            await manager._testOpenWindow(for: target)
            let controller = try #require(manager._testAuxiliaryWindows().first?.controller)
            try await self.waitForDashboard(controller, path: "/")
            await gate.hold()

            let click = Task { @MainActor in
                try await manager.openBackgroundSession(
                    self.completion(), target: target, sourceURL: server.url())
            }
            await gate.waitUntilRequested()
            await manager.handleEndpointState(.connecting(mode: .remote, detail: "Connecting"))
            await gate.release()
            try await click.value

            try await self.waitForDashboard(controller, path: "/chat/main/dashboard/completed")
            #expect(manager._testAuxiliaryWindows().first?.controller === controller)
        }
    }

    @Test func `older queued command replay does not cancel a newer notification click`() async throws {
        let gate = DashboardWindowOwnershipPresentationGate(released: true)
        try await self.withNotificationDashboard(gate: gate) { server, manager in
            try await manager.show()
            let controller = try #require(manager._testController())
            try await self.waitForDashboard(controller, path: "/")
            controller.webView(controller.webView, didCommit: nil)
            controller.dispatchNativeCommand(.newSession)
            #expect(controller._testPendingNativeCommands == [.newSession])
            await gate.hold()

            let click = Task { @MainActor in
                try await manager.openBackgroundSession(
                    self.completion(), target: .primary, sourceURL: server.url())
            }
            await gate.waitUntilRequested()
            controller.webView(controller.webView, didFinish: nil)
            #expect(controller._testPendingNativeCommands.isEmpty)
            await gate.release()
            try await click.value

            try await self.waitForDashboard(controller, path: "/chat/main/dashboard/completed")
        }
    }

    @Test(arguments: ["same", "refreshed", "refreshed-close", "new-window-close"])
    func `older manager command replay does not cancel a newer notification click`(_ scenario: String) async throws {
        try await TestIsolation.withIsolatedState {
            let server = try await DashboardHTTPFixture.start(
                html: """
                <html><body><script>
                window.commandEvents = [];
                window.addEventListener('openclaw:native-new-session', () => window.commandEvents.push('new-session'));
                window.addEventListener('openclaw:native-toggle-search', event => {
                  event.preventDefault(); window.commandEvents.push('toggle');
                });
                window.addEventListener('openclaw:native-navigate', event => {
                  event.preventDefault(); history.pushState({}, '', event.detail.path);
                });
                </script></body></html>
                """,
                contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
            defer { server.stop() }
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = previousMode }
            let primaryGate = DashboardWindowOwnershipPresentationGate(released: true)
            let notificationGate = DashboardWindowOwnershipPresentationGate()
            let endpointURL = server.websocketURL()
            let manager = DashboardManager._testMake(
                primaryEndpointProvider: { _ in
                    let request = await primaryGate.waitForRelease()
                    if request == (scenario == "new-window-close" ? 2 : 3) {
                        await notificationGate.waitForRelease()
                    }
                    return GatewayConnection.EndpointSnapshot(
                        config: (
                            url: endpointURL,
                            token: request == 1 || scenario == "same" ? "before" : "after",
                            password: nil),
                        routeAuthority: nil)
                },
                gatewayEntriesProvider: { [Self.primaryGateway] })
            defer { manager.close() }
            if scenario != "new-window-close" {
                try await manager.show()
                let controller = try #require(manager._testController())
                try await self.waitForDashboard(controller, path: "/")
                controller.window?.performClose(nil)
            }
            let originalWindow = manager._testController()?.window
            await primaryGate.hold()
            manager.dispatchNativeCommand(.newSession)
            manager.dispatchNativeCommand(.commandPalette)
            manager.dispatchNativeCommand(.commandPalette)
            await primaryGate.waitUntilRequested()

            let click = Task { @MainActor in
                try await manager.openBackgroundSession(
                    self.completion(), target: .primary, sourceURL: server.url())
            }
            while await primaryGate.numberOfRequests() < (scenario == "new-window-close" ? 2 : 3) {
                await Task.yield()
            }
            await primaryGate.release()
            await notificationGate.waitUntilRequested()
            let reopened = try await self.waitForQueuedToggles(manager)
            let window = try #require(reopened.window)
            if let originalWindow { #expect(window === originalWindow) }
            let commands = try await reopened.webView.evaluateJavaScript("window.commandEvents") as? [String]
            #expect(commands == ["toggle", "toggle"])
            if scenario.hasSuffix("-close") {
                window.performClose(nil)
            }
            await notificationGate.release()
            try await click.value

            let current = try #require(manager._testController())
            #expect(current.window === window)
            if scenario.hasSuffix("-close") {
                #expect(!current.isWindowOpen)
                #expect(current.webView.url?.path == "/")
            } else {
                try await self.waitForDashboard(current, path: "/chat/main/dashboard/completed")
            }
        }
    }

    @Test(arguments: ["same-close", "other-open"])
    func `manual window admission retires only its target notification`(_ action: String) async throws {
        try await TestIsolation.withIsolatedState {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = previousMode }
            let gate = DashboardWindowOwnershipPresentationGate()
            let endpointURL = server.websocketURL()
            let endpoint = GatewayConnection.EndpointSnapshot(
                config: (url: endpointURL, token: "synthetic", password: nil), routeAuthority: nil)
            let manager = DashboardManager._testMake(
                primaryEndpointProvider: { _ in endpoint },
                profileEndpointProvider: { _ in
                    if await gate.numberOfRequests() == 0 { await gate.waitForRelease() }
                    return endpoint
                },
                gatewayEntriesProvider: {
                    [Self.primaryGateway, DashboardGatewayEntry(
                        id: "profile:background",
                        name: "Background",
                        kind: "remote",
                        isPrimary: false,
                        canPromote: false,
                        health: .ok)]
                })
            defer { manager.close() }
            let target = DashboardGatewayTarget.profile("background")
            let click = Task { @MainActor in
                try await manager.openBackgroundSession(self.completion(), target: target, sourceURL: server.url())
            }
            await gate.waitUntilRequested()
            manager.openOrFocusDashboard(for: action == "other-open" ? .primary : target)
            let deadline = ContinuousClock.now + .seconds(5)
            while manager._testController() == nil, manager._testAuxiliaryWindows().isEmpty,
                  ContinuousClock.now < deadline
            {
                try await Task.sleep(for: .milliseconds(10))
            }
            let opened = try #require(manager._testController() ?? manager._testAuxiliaryWindows().first?.controller)
            try await self.waitForDashboard(opened, path: "/")
            if action == "same-close" { opened.window?.performClose(nil) }
            await gate.release()
            try await click.value

            if action == "same-close" {
                #expect(manager._testAuxiliaryWindows().isEmpty)
            } else {
                let completed = try #require(manager._testAuxiliaryWindows().first?.controller)
                try await self.waitForDashboard(completed, path: "/chat/main/dashboard/completed")
                #expect(opened.webView.url?.path == "/")
            }
        }
    }

    @Test func `command palette remote recovery preserves pending notification navigation`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        let config = """
        {"gateway":{"remote":{"transport":"direct","url":"\(server.websocketURL())","token":"synthetic"}}}
        """
        try Data(config.utf8).write(to: URL(fileURLWithPath: configPath))
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_TOKEN": nil,
            "OPENCLAW_GATEWAY_PASSWORD": nil,
        ]) {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = previousMode }
            let requests = DashboardWindowOwnershipPresentationGate(released: true)
            let notificationGate = DashboardWindowOwnershipPresentationGate()
            let recoveryGate = DashboardWindowOwnershipPresentationGate()
            let manager = DashboardManager._testMake(
                primaryEndpointProvider: { _ in
                    let request = await requests.waitForRelease()
                    if request == 2 { await notificationGate.waitForRelease() }
                    if request == 3 { await recoveryGate.waitForRelease() }
                    return GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "synthetic", password: nil),
                        routeAuthority: nil)
                },
                gatewayEntriesProvider: { [Self.primaryGateway] })
            defer { manager.close() }
            try await manager.show()
            let controller = try #require(manager._testController())
            try await self.waitForDashboard(controller, path: "/")
            let window = try #require(controller.window)
            window.performClose(nil)
            let click = Task { @MainActor in
                try await manager.openBackgroundSession(self.completion(), target: .primary, sourceURL: server.url())
            }
            await notificationGate.waitUntilRequested()
            do {
                manager.dispatchNativeCommand(.commandPalette)
                await recoveryGate.waitUntilRequested()
                #expect(controller.isWindowOpen)
                await notificationGate.release()
                try await click.value
                #expect(controller._testPendingNativeNavigation?.path == "/chat/main/dashboard/completed")
            } catch {
                click.cancel()
                await notificationGate.release()
                await recoveryGate.release()
                _ = try? await click.value
                throw error
            }
            await recoveryGate.release()
            let deadline = ContinuousClock.now + .seconds(5)
            while (window.windowController as? DashboardWindowController)?.pendingGatewaySwitch != nil,
                  ContinuousClock.now < deadline
            {
                try await Task.sleep(for: .milliseconds(10))
            }
            let restored = try #require(window.windowController as? DashboardWindowController)
            #expect(manager._testController() === restored)
            try await self.waitForDashboard(restored, path: "/chat/main/dashboard/completed")
        }
    }

    @Test func `notification retains its native window when unrelated window moves forward`() async throws {
        let gate = DashboardWindowOwnershipPresentationGate(released: true)
        try await self.withNotificationDashboard(gate: gate) { server, manager in
            try await manager.show()
            let main = try #require(manager._testController())
            await manager._testOpenWindow(for: .primary)
            let clicked = try #require(manager._testAuxiliaryWindows().first?.controller)
            await manager._testOpenWindow(for: .profile("background"))
            let other = try #require(manager._testAuxiliaryWindows().first { $0.target != .primary }?.controller)
            try await self.waitForDashboard(main, path: "/")
            try await self.waitForDashboard(clicked, path: "/")
            try await self.waitForDashboard(other, path: "/")
            let windows = [main, clicked, other].compactMap(\.window)
            await gate.hold()
            let click = Task { @MainActor in
                // Focus and admission are one UI action; yielding between them lets
                // unrelated AppKit tests choose the window before this click starts.
                clicked.show()
                #expect(NSApp.orderedWindows.first(where: { windows.contains($0) }) === clicked.window)
                #expect(windows.first(where: \.isKeyWindow).map { $0 === clicked.window } ?? true)
                try await manager.openBackgroundSession(self.completion(), target: .primary, sourceURL: server.url())
            }
            await gate.waitUntilRequested()
            do {
                other.show()
                try #require(NSApp.orderedWindows.first(where: { windows.contains($0) }) === other.window)
                try #require(windows.first(where: \.isKeyWindow).map { $0 === other.window } ?? true)
            } catch {
                click.cancel()
                await gate.release()
                _ = try? await click.value
                throw error
            }
            await gate.release()
            try await click.value

            try await self.waitForDashboard(clicked, path: "/chat/main/dashboard/completed")
            #expect(main.webView.url?.path == "/")
            #expect(other.webView.url?.path == "/")
        }
    }

    @Test(arguments: ["endpoint", "credentials"])
    func `configured replacement fences a click suspended in authentication`(_ change: String) async throws {
        let server = try await DashboardHTTPFixture.start()
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { server.stop()
            replacementServer.stop()
        }
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        func writeConfig(url: URL, token: String) throws {
            let config = """
            {"gateway":{"remote":{"transport":"direct","url":"\(url)","token":"\(token)"}}}
            """
            try Data(config.utf8).write(to: URL(fileURLWithPath: configPath))
        }
        try writeConfig(url: server.websocketURL(), token: "before")
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_TOKEN": nil,
            "OPENCLAW_GATEWAY_PASSWORD": nil,
        ]) {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = previousMode }
            let gate = DashboardWindowOwnershipPresentationGate()
            let authRequests = DashboardWindowOwnershipPresentationGate(released: true)
            let manager = DashboardManager._testMake(
                authTokenProvider: { config in
                    if await authRequests.waitForRelease() == 2 {
                        await gate.waitForRelease()
                    }
                    return config.token
                },
                gatewayEntriesProvider: { [Self.primaryGateway] })
            defer { manager.close() }
            try await manager.show()
            let original = try #require(manager._testController())
            try await self.waitForDashboard(original, path: "/")
            let window = try #require(original.window)
            window.performClose(nil)
            let click = Task { @MainActor in
                try await manager.openBackgroundSession(self.completion(), target: .primary, sourceURL: server.url())
            }
            await gate.waitUntilRequested()
            let replacement: DashboardWindowController
            let nextURL = change == "endpoint" ? replacementServer.websocketURL() : server.websocketURL()
            let nextToken = change == "credentials" ? "after" : "before"
            do {
                try writeConfig(url: nextURL, token: nextToken)
                manager.dispatchNativeCommand(.commandPalette)
                let deadline = ContinuousClock.now + .seconds(5)
                while manager._testController() === original, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                replacement = try #require(manager._testController())
                try #require(replacement !== original)
                try #require(replacement.window === window)
                try await self.waitForDashboard(replacement, path: "/")
            } catch {
                click.cancel()
                await gate.release()
                _ = try? await click.value
                throw error
            }
            await gate.release()
            try await click.value

            let current = try #require(manager._testController())
            #expect(current === replacement)
            #expect(current.auth.gatewayUrl == nextURL.absoluteString)
            #expect(current.auth.token == nextToken)
            #expect(current.webView.url?.path == "/")
        }
    }

    private func withNotificationDashboard(
        gate: DashboardWindowOwnershipPresentationGate? = nil,
        _ body: @MainActor (DashboardHTTPFixture, DashboardManager) async throws -> Void) async throws
    {
        // These cases address configured Primary. An unconfigured app correctly
        // opens the sole saved profile instead, which is a different window owner.
        try await TestIsolation.withIsolatedState(defaults: [connectionModeKey: "local"]) {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .local
            defer { state.connectionMode = previousMode }
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let endpointURL = server.websocketURL()
            let manager = DashboardManager._testMake(
                primaryEndpointProvider: { _ in
                    await gate?.waitForRelease()
                    return GatewayConnection.EndpointSnapshot(
                        config: (url: endpointURL, token: "synthetic", password: nil),
                        routeAuthority: nil)
                },
                profileEndpointProvider: { _ in
                    await gate?.waitForRelease()
                    return GatewayConnection.EndpointSnapshot(
                        config: (url: endpointURL, token: "synthetic", password: nil),
                        routeAuthority: nil)
                },
                gatewayEntriesProvider: {
                    [Self.primaryGateway, DashboardGatewayEntry(
                        id: "profile:background",
                        name: "Background",
                        kind: "remote",
                        isPrimary: false,
                        canPromote: false,
                        health: .ok)]
                })
            defer { manager.close() }
            try await body(server, manager)
        }
    }

    private func waitForQueuedToggles(_ manager: DashboardManager) async throws -> DashboardWindowController {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if let controller = manager._testController(), controller.isWindowOpen,
               let commands = try? await controller.webView.evaluateJavaScript("window.commandEvents") as? [String],
               commands.filter({ $0 == "toggle" }).count == 2
            {
                return controller
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw URLError(.timedOut)
    }

    private func completion() throws -> DashboardBackgroundSessionCompletion {
        try #require(DashboardBackgroundSessionCompletion(body: [
            "runId": "synthetic-run", "path": "/chat/main/dashboard/completed",
        ]))
    }

    private func waitForDashboard(_ controller: DashboardWindowController, path: String) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        // Check readiness even when the main actor resumes after the deadline.
        while !controller.canDeliverNativeCommands || controller.webView.isLoading ||
            controller.webView.url?.path != path,
            ContinuousClock.now < deadline
        {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(controller.canDeliverNativeCommands)
        try #require(!controller.webView.isLoading)
        try #require(controller.webView.url?.path == path)
    }
}
