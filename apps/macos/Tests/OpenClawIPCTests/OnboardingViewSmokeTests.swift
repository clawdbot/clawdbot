import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawIPC
import OpenClawKit
import SwiftUI
import Testing
@testable import OpenClaw

private struct OnboardingStoredGatewayPreference {
    let stableID: String?
    let routeBinding: String?
}

private func captureOnboardingGatewayPreference() -> OnboardingStoredGatewayPreference {
    OnboardingStoredGatewayPreference(
        stableID: GatewayDiscoveryPreferences.preferredStableID(),
        routeBinding: GatewayDiscoveryPreferences.preferredRouteBinding())
}

private func restoreOnboardingGatewayPreference(_ preference: OnboardingStoredGatewayPreference) {
    GatewayDiscoveryPreferences.setPreferredStableID(
        preference.stableID,
        routeBinding: preference.routeBinding)
}

private func makeOnboardingResumeDefaults() throws -> (UserDefaults, String) {
    let suiteName = "OnboardingViewSmokeTests.\(UUID().uuidString)"
    return try (#require(UserDefaults(suiteName: suiteName)), suiteName)
}

@Suite(.serialized)
@MainActor
struct OnboardingViewSmokeTests {
    @Test func `onboarding view builds body`() {
        let state = AppState(preview: true)
        let view = OnboardingView(
            state: state,
            permissionMonitor: PermissionMonitor.shared,
            discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))
        _ = view.body
    }

    @Test func `onboarding window resizes vertically and gives the page the extra height`() {
        #expect(OnboardingController.windowStyleMask.contains(.resizable))

        let baseline = OnboardingView.contentHeight(
            for: OnboardingView.windowHeight,
            usesCompactHero: false)
        let taller = OnboardingView.contentHeight(
            for: OnboardingView.windowHeight + 200,
            usesCompactHero: false)

        #expect(taller - baseline == 200)
    }

    @Test func `onboarding window fits within a short visible screen`() {
        let visibleFrame = NSRect(x: 0, y: 78, width: 1600, height: 626)
        let frame = OnboardingController.initialWindowFrame(visibleFrame: visibleFrame)

        #expect(frame.height == visibleFrame.height)
        #expect(frame.minY == visibleFrame.minY)
        #expect(frame.maxY == visibleFrame.maxY)
    }

    @Test func `short onboarding window keeps a usable scrollable page`() {
        let short = OnboardingView.contentHeight(for: 626, usesCompactHero: false)
        let preferred = OnboardingView.contentHeight(
            for: OnboardingView.windowHeight,
            usesCompactHero: false)

        #expect(short == 409)
        #expect(short < preferred)
    }

    @Test func `permissions page scrolls when the onboarding window is short`() throws {
        let state = AppState(preview: true)
        let view = OnboardingView(state: state)
        let hosting = NSHostingView(rootView: view.permissionsPage())
        let contentHeight = OnboardingView.contentHeight(
            for: OnboardingView.minimumWindowHeight,
            usesCompactHero: false)
        hosting.frame = NSRect(
            x: 0,
            y: 0,
            width: OnboardingView.windowWidth,
            height: contentHeight)
        hosting.layoutSubtreeIfNeeded()

        let scrollView = try #require(Self.firstDescendant(of: NSScrollView.self, in: hosting))
        #expect(contentHeight == 303)
        #expect(scrollView.documentView != nil)
    }

    @Test func `local page order includes memory import only while eligible`() {
        let configuredOrder = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: false,
            memoryImportEligible: true)
        let freshOrder = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: true,
            memoryImportEligible: true)
        let resolvedEmptyOrder = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: false,
            memoryImportEligible: false)

        #expect(configuredOrder == [0, 1, 3, 4, 5, 9])
        #expect(freshOrder == [0, 1, 2, 3, 4, 5, 9])
        #expect(resolvedEmptyOrder == [0, 1, 3, 5, 9])
        #expect(!configuredOrder.contains(7))
        #expect(!configuredOrder.contains(8))
    }

    @Test func `remote and unconfigured page orders never include memory import`() {
        #expect(OnboardingView.pageOrder(
            for: .remote,
            requiresCLIInstall: true,
            memoryImportEligible: true) == [0, 1, 2, 3, 5, 9])
        #expect(OnboardingView.pageOrder(
            for: .remote,
            requiresCLIInstall: false,
            memoryImportEligible: true) == [0, 1, 3, 5, 9])
        #expect(OnboardingView.pageOrder(
            for: .unconfigured,
            requiresCLIInstall: false,
            memoryImportEligible: true) == [0, 1, 9])
    }

    @Test func `memory page inclusion follows local model eligibility`() {
        let withMemory = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: false,
            memoryImportEligible: true)

        #expect(OnboardingView.shouldIncludeMemoryImportPage(
            for: .local,
            modelEligible: true))
        #expect(!OnboardingView.shouldIncludeMemoryImportPage(
            for: .local,
            modelEligible: false))
        #expect(!OnboardingView.shouldIncludeMemoryImportPage(
            for: .remote,
            modelEligible: true))
        let withoutMemory = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: false,
            memoryImportEligible: false)
        #expect(withMemory.prefix(3) == withoutMemory.prefix(3))
        #expect(!withoutMemory.contains(4))
    }

    @Test func `memory page removal preserves the active logical page`() throws {
        let previousOrder = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: false,
            memoryImportEligible: true)
        let newOrder = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: false,
            memoryImportEligible: false)
        let aiCursor = try #require(previousOrder.firstIndex(of: 3))
        let memoryCursor = try #require(previousOrder.firstIndex(of: 4))
        let permissionsCursor = try #require(previousOrder.firstIndex(of: 5))
        let readyCursor = try #require(previousOrder.firstIndex(of: 9))
        let newPermissionsCursor = try #require(newOrder.firstIndex(of: 5))
        let newReadyCursor = try #require(newOrder.firstIndex(of: 9))

        #expect(OnboardingView.reconciledPageCursor(
            currentPage: aiCursor,
            previousOrder: previousOrder,
            newOrder: newOrder) == aiCursor)
        #expect(OnboardingView.reconciledPageCursor(
            currentPage: memoryCursor,
            previousOrder: previousOrder,
            newOrder: newOrder) == newPermissionsCursor)
        #expect(OnboardingView.reconciledPageCursor(
            currentPage: permissionsCursor,
            previousOrder: previousOrder,
            newOrder: newOrder) == newPermissionsCursor)
        #expect(OnboardingView.reconciledPageCursor(
            currentPage: readyCursor,
            previousOrder: previousOrder,
            newOrder: newOrder) == newReadyCursor)
    }

    @Test func `fresh local setup installs CLI before inference setup`() {
        let order = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: true)

        #expect(order.firstIndex(of: 2) == 2)
        #expect(order.firstIndex(of: 3) == 3)
    }

    @Test func `configured local setup skips CLI install page`() {
        let order = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: false)

        #expect(!order.contains(2))
    }

    @Test func `fresh remote setup installs CLI for the Mac node worker`() {
        let order = OnboardingView.pageOrder(
            for: .remote,
            requiresCLIInstall: true)

        #expect(order.contains(2))
        #expect(!OnboardingView.shouldActivateLocalGateway(afterCLIInstallFor: .remote))
        #expect(OnboardingView.shouldActivateLocalGateway(afterCLIInstallFor: .local))
    }

    @Test func `fresh onboarding defaults to this Mac`() {
        let state = AppState(preview: true)
        state.onboardingSeen = false
        state.connectionMode = .unconfigured
        let view = OnboardingView(state: state)

        #expect(view.selectedConnectionMode == .local)
        #expect(view.isConnectionSelectionBlocking)
        #expect(state.connectionMode == .unconfigured)
    }

    @Test func `reopened onboarding preserves configure later selection`() {
        let state = AppState(preview: true)
        state.onboardingSeen = true
        state.connectionMode = .unconfigured
        let view = OnboardingView(state: state)

        #expect(view.selectedConnectionMode == .unconfigured)
        #expect(!view.isConnectionSelectionBlocking)
        #expect(state.connectionMode == .unconfigured)
    }

    @Test func `advancing from recommended this Mac commits local mode`() {
        let state = AppState(preview: true)
        state.onboardingSeen = false
        state.connectionMode = .unconfigured
        let view = OnboardingView(state: state)

        view.commitRecommendedConnectionIfNeeded(for: view.connectionPageIndex)

        #expect(state.connectionMode == .local)
    }

    @Test func `automatic CLI setup waits for the initial status probe`() {
        #expect(!OnboardingView.shouldAutoInstallCLI(
            onCLIPage: true,
            isLocal: true,
            visible: true,
            statusKnown: false,
            executableReady: false,
            installed: false,
            installing: false))
        #expect(OnboardingView.shouldAutoInstallCLI(
            onCLIPage: true,
            isLocal: true,
            visible: true,
            statusKnown: true,
            executableReady: false,
            installed: false,
            installing: false))
        #expect(!OnboardingView.shouldAutoInstallCLI(
            onCLIPage: true,
            isLocal: true,
            visible: false,
            statusKnown: true,
            executableReady: false,
            installed: false,
            installing: false))
        #expect(!OnboardingView.shouldAutoInstallCLI(
            onCLIPage: true,
            isLocal: true,
            visible: true,
            statusKnown: true,
            executableReady: true,
            installed: false,
            installing: false))
    }

    @Test func `detected CLI starts its gateway after this Mac is selected`() {
        #expect(!OnboardingView.shouldStartExistingCLIActivation(
            isLocal: false,
            executableReady: true,
            installing: false))
        #expect(OnboardingView.shouldStartExistingCLIActivation(
            isLocal: true,
            executableReady: true,
            installing: false))
        #expect(!OnboardingView.shouldStartExistingCLIActivation(
            isLocal: true,
            executableReady: true,
            installing: true))
    }

    @Test func `connection mode change restarts full page monitoring`() {
        let state = AppState(preview: true)
        let view = OnboardingView(state: state)
        var monitoredPage: Int?
        let previousSystemAgentChat = view.systemAgentState.chat
        view.aiSetup.manualKey = "route-bound"
        view.systemAgentState.isPresented = true

        view.handleConnectionModeChange { pageIndex in
            monitoredPage = pageIndex
        }

        #expect(view.aiSetup.manualKey.isEmpty)
        #expect(!view.systemAgentState.isPresented)
        #expect(view.systemAgentState.chat !== previousSystemAgentChat)
        #expect(monitoredPage == view.activePageIndex)
    }

    @Test func `gateway route reset returns later pages to inference setup`() throws {
        let order = OnboardingView.pageOrder(
            for: .remote,
            requiresCLIInstall: false)
        let permissionsCursor = try #require(order.firstIndex(of: 5))
        let aiCursor = try #require(order.firstIndex(of: 3))
        let resetCursor = OnboardingView.pageCursorAfterGatewayReset(
            currentPage: permissionsCursor,
            pageOrder: order,
            aiPageIndex: 3)

        #expect(resetCursor == aiCursor)
        #expect(OnboardingView.shouldBlockAISetup(
            currentPage: resetCursor,
            pageOrder: order,
            aiPageIndex: 3,
            connectionMode: .remote,
            connected: false))
    }

    @Test func `select remote gateway clears stale ssh target when endpoint unresolved`() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host:2222"
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))
            let gateway = GatewayDiscoveryModel.DiscoveredGateway(
                displayName: "Unresolved",
                serviceHost: nil,
                servicePort: nil,
                lanHost: "txt-host.local",
                tailnetDns: "txt-host.ts.net",
                sshPort: 22,
                gatewayPort: 18789,
                cliPath: "/tmp/openclaw",
                stableID: UUID().uuidString,
                debugID: UUID().uuidString,
                isLocal: false)

            view.selectRemoteGateway(gateway)
            #expect(state.remoteTarget.isEmpty)
        }
    }

    @Test func `different remote selection resets UI but preserves prior activation lease`() async throws {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path
        let previousGatewayPreference = captureOnboardingGatewayPreference()
        let (defaults, suiteName) = try makeOnboardingResumeDefaults()
        defer {
            restoreOnboardingGatewayPreference(previousGatewayPreference)
            defaults.removePersistentDomain(forName: suiteName)
        }
        GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults)

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            let state = AppState(preview: true)
            state.connectionMode = .remote
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName),
                systemAgentDefaults: defaults)
            let priorChat = view.systemAgentState.chat
            view.aiSetup.manualKey = "route-a-secret"
            view.systemAgentState.isPresented = true
            let gateway = GatewayDiscoveryModel.DiscoveredGateway(
                displayName: "Gateway B",
                serviceHost: nil,
                servicePort: nil,
                lanHost: "gateway-b.local",
                tailnetDns: "gateway-b.ts.net",
                sshPort: 22,
                gatewayPort: 18789,
                cliPath: "/tmp/openclaw",
                stableID: "gateway-b",
                debugID: "gateway-b",
                isLocal: false)

            view.selectRemoteGateway(gateway)

            #expect(state.connectionMode == .remote)
            #expect(view.aiSetup.manualKey.isEmpty)
            #expect(!view.systemAgentState.isPresented)
            #expect(view.systemAgentState.chat !== priorChat)
            #expect(!OnboardingSystemAgentResumeStore.isPending(
                for: "remote:id:gateway-b",
                defaults: defaults))
            #expect(OnboardingSystemAgentResumeStore.isPending(
                for: "remote:id:gateway-a",
                defaults: defaults))
        }
    }

    @Test func `manual remote endpoint edit clears stale discovery identity`() throws {
        let previousGatewayPreference = captureOnboardingGatewayPreference()
        let (defaults, suiteName) = try makeOnboardingResumeDefaults()
        defer {
            restoreOnboardingGatewayPreference(previousGatewayPreference)
            defaults.removePersistentDomain(forName: suiteName)
        }
        GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults)
        let state = AppState(preview: true)
        state.connectionMode = .remote
        state.remoteTransport = .direct
        state.remoteUrl = "wss://gateway-a.example.test"
        let gatewaySession = GatewayTestWebSocketSession()
        let gatewayURL = try #require(URL(string: "wss://gateway-a.example.test"))
        let gateway = GatewayConnection(
            configProvider: { (url: gatewayURL, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: gatewaySession))
        let view = OnboardingView(
            state: state,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults)
        view.preferredGatewayID = "gateway-a"
        view.aiSetup.manualKey = "route-a-secret"
        view.aiSetup.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        view.aiSetup.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")
        let priorChat = view.systemAgentState.chat
        view.systemAgentState.isPresented = true
        view.remoteProbeState = .ok(RemoteGatewayProbeSuccess(authSource: .sharedToken))
        view.remoteAuthIssue = .tokenMismatch

        view.updateManualRemoteURL("wss://gateway-b.example.test")

        let editedRouteIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity(
            state: state,
            preferredGatewayID: view.preferredGatewayID ?? GatewayDiscoveryPreferences.preferredStableID())
        #expect(view.preferredGatewayID == nil)
        #expect(GatewayDiscoveryPreferences.preferredStableID() == nil)
        #expect(editedRouteIdentity?.hasPrefix("remote:direct:") == true)
        #expect(editedRouteIdentity != "remote:id:gateway-a")
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults))
        #expect(!OnboardingSystemAgentResumeStore.isPending(
            for: editedRouteIdentity,
            defaults: defaults))
        #expect(view.aiSetup.phase == .idle)
        #expect(!view.aiSetup.connected)
        #expect(view.aiSetup.manualKey.isEmpty)
        #expect(!view.systemAgentState.isPresented)
        #expect(view.systemAgentState.chat !== priorChat)
        #expect(view.remoteProbeState == .idle)
        #expect(view.remoteAuthIssue == nil)
        #expect(gatewaySession.snapshotMakeCount() == 0)
    }

    @Test func `same persisted remote selection preserves pending gateway setup state`() async throws {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path
        let previousGatewayPreference = captureOnboardingGatewayPreference()
        let (defaults, suiteName) = try makeOnboardingResumeDefaults()
        defer {
            restoreOnboardingGatewayPreference(previousGatewayPreference)
            defaults.removePersistentDomain(forName: suiteName)
        }
        GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults)

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            let state = AppState(preview: true)
            state.connectionMode = .remote
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName),
                systemAgentDefaults: defaults)
            let priorChat = view.systemAgentState.chat
            view.aiSetup.manualKey = "pending-secret"
            view.systemAgentState.isPresented = true
            let gateway = GatewayDiscoveryModel.DiscoveredGateway(
                displayName: "Gateway A",
                serviceHost: nil,
                servicePort: nil,
                lanHost: "gateway-a.local",
                tailnetDns: "gateway-a.ts.net",
                sshPort: 22,
                gatewayPort: 18789,
                cliPath: "/tmp/openclaw",
                stableID: "gateway-a",
                debugID: "gateway-a",
                isLocal: false)

            view.selectRemoteGateway(gateway)

            #expect(view.aiSetup.manualKey == "pending-secret")
            #expect(view.systemAgentState.isPresented)
            #expect(view.systemAgentState.chat === priorChat)
            #expect(OnboardingSystemAgentResumeStore.isPending(
                for: "remote:id:gateway-a",
                defaults: defaults))
        }
    }

    @Test func `remote to local selection preserves prior activation lease`() throws {
        let previousGatewayPreference = captureOnboardingGatewayPreference()
        let (defaults, suiteName) = try makeOnboardingResumeDefaults()
        defer {
            restoreOnboardingGatewayPreference(previousGatewayPreference)
            defaults.removePersistentDomain(forName: suiteName)
        }
        GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults)
        let state = AppState(preview: true)
        state.connectionMode = .remote
        let view = OnboardingView(state: state, systemAgentDefaults: defaults)
        let priorChat = view.systemAgentState.chat
        view.aiSetup.manualKey = "route-a-secret"
        view.systemAgentState.isPresented = true

        view.selectLocalGateway()

        #expect(state.connectionMode == .local)
        #expect(view.aiSetup.manualKey.isEmpty)
        #expect(!view.systemAgentState.isPresented)
        #expect(view.systemAgentState.chat !== priorChat)
        #expect(!OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
        #expect(OnboardingSystemAgentResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults))
    }

    @Test func `same local selection preserves pending gateway setup state`() throws {
        let (defaults, suiteName) = try makeOnboardingResumeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingSystemAgentResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        let state = AppState(preview: true)
        state.connectionMode = .local
        let view = OnboardingView(state: state, systemAgentDefaults: defaults)
        let priorChat = view.systemAgentState.chat
        view.aiSetup.manualKey = "pending-secret"
        view.systemAgentState.isPresented = true

        view.selectLocalGateway()

        #expect(view.aiSetup.manualKey == "pending-secret")
        #expect(view.systemAgentState.isPresented)
        #expect(view.systemAgentState.chat === priorChat)
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `configure later preserves in flight activation lease`() throws {
        let (defaults, suiteName) = try makeOnboardingResumeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingSystemAgentResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        let state = AppState(preview: true)
        state.connectionMode = .local
        let view = OnboardingView(state: state, systemAgentDefaults: defaults)
        let priorChat = view.systemAgentState.chat
        view.aiSetup.manualKey = "local-secret"
        view.systemAgentState.isPresented = true

        view.selectUnconfiguredGateway()

        #expect(state.connectionMode == .unconfigured)
        #expect(view.aiSetup.manualKey.isEmpty)
        #expect(!view.systemAgentState.isPresented)
        #expect(view.systemAgentState.chat !== priorChat)
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test
    func `permission list covers every capability in importance order`() {
        #expect(Set(Capability.importanceOrdered) == Set(Capability.allCases))
        #expect(Capability.importanceOrdered.count == Capability.allCases.count)
        // App control and context capture lead; location stays last.
        #expect(Capability.importanceOrdered.first == .appleScript)
        #expect(Array(Capability.importanceOrdered.prefix(3))
            == [.appleScript, .accessibility, .screenRecording])
        #expect(Capability.importanceOrdered.last == Capability.location)
    }

    private static func firstDescendant<T: NSView>(of type: T.Type, in view: NSView) -> T? {
        if let match = view as? T { return match }
        for child in view.subviews {
            if let match = self.firstDescendant(of: type, in: child) { return match }
        }
        return nil
    }
}
