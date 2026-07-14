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

    @Test func `page order delegates setup after inference to Crestodian`() {
        let order = OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: false)
        #expect(!order.contains(4))
        #expect(!order.contains(7))
        #expect(!order.contains(8))
        #expect(order.contains(3))
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
        let previousCrestodianChat = view.crestodianState.chat
        view.aiSetup.manualKey = "route-bound"
        view.crestodianState.isPresented = true

        view.handleConnectionModeChange { pageIndex in
            monitoredPage = pageIndex
        }

        #expect(view.aiSetup.manualKey.isEmpty)
        #expect(!view.crestodianState.isPresented)
        #expect(view.crestodianState.chat !== previousCrestodianChat)
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
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults)

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            let state = AppState(preview: true)
            state.connectionMode = .remote
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName),
                crestodianDefaults: defaults)
            let priorChat = view.crestodianState.chat
            view.aiSetup.manualKey = "route-a-secret"
            view.crestodianState.isPresented = true
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
            #expect(!view.crestodianState.isPresented)
            #expect(view.crestodianState.chat !== priorChat)
            #expect(!OnboardingCrestodianResumeStore.isPending(
                for: "remote:id:gateway-b",
                defaults: defaults))
            #expect(OnboardingCrestodianResumeStore.isPending(
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
        OnboardingCrestodianResumeStore.markPending(
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
            crestodianDefaults: defaults)
        view.preferredGatewayID = "gateway-a"
        view.aiSetup.manualKey = "route-a-secret"
        view.aiSetup.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        view.aiSetup.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")
        let priorChat = view.crestodianState.chat
        view.crestodianState.isPresented = true
        view.remoteProbeState = .ok(RemoteGatewayProbeSuccess(authSource: .sharedToken))
        view.remoteAuthIssue = .tokenMismatch

        view.updateManualRemoteURL("wss://gateway-b.example.test")

        let editedRouteIdentity = OnboardingCrestodianResumeStore.selectedRouteIdentity(
            state: state,
            preferredGatewayID: view.preferredGatewayID ?? GatewayDiscoveryPreferences.preferredStableID())
        #expect(view.preferredGatewayID == nil)
        #expect(GatewayDiscoveryPreferences.preferredStableID() == nil)
        #expect(editedRouteIdentity?.hasPrefix("remote:direct:") == true)
        #expect(editedRouteIdentity != "remote:id:gateway-a")
        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults))
        #expect(!OnboardingCrestodianResumeStore.isPending(
            for: editedRouteIdentity,
            defaults: defaults))
        #expect(view.aiSetup.phase == .idle)
        #expect(!view.aiSetup.connected)
        #expect(view.aiSetup.manualKey.isEmpty)
        #expect(!view.crestodianState.isPresented)
        #expect(view.crestodianState.chat !== priorChat)
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
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults)

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            let state = AppState(preview: true)
            state.connectionMode = .remote
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName),
                crestodianDefaults: defaults)
            let priorChat = view.crestodianState.chat
            view.aiSetup.manualKey = "pending-secret"
            view.crestodianState.isPresented = true
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
            #expect(view.crestodianState.isPresented)
            #expect(view.crestodianState.chat === priorChat)
            #expect(OnboardingCrestodianResumeStore.isPending(
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
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults)
        let state = AppState(preview: true)
        state.connectionMode = .remote
        let view = OnboardingView(state: state, crestodianDefaults: defaults)
        let priorChat = view.crestodianState.chat
        view.aiSetup.manualKey = "route-a-secret"
        view.crestodianState.isPresented = true

        view.selectLocalGateway()

        #expect(state.connectionMode == .local)
        #expect(view.aiSetup.manualKey.isEmpty)
        #expect(!view.crestodianState.isPresented)
        #expect(view.crestodianState.chat !== priorChat)
        #expect(!OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults))
    }

    @Test func `same local selection preserves pending gateway setup state`() throws {
        let (defaults, suiteName) = try makeOnboardingResumeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingCrestodianResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        let state = AppState(preview: true)
        state.connectionMode = .local
        let view = OnboardingView(state: state, crestodianDefaults: defaults)
        let priorChat = view.crestodianState.chat
        view.aiSetup.manualKey = "pending-secret"
        view.crestodianState.isPresented = true

        view.selectLocalGateway()

        #expect(view.aiSetup.manualKey == "pending-secret")
        #expect(view.crestodianState.isPresented)
        #expect(view.crestodianState.chat === priorChat)
        #expect(OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `configure later preserves in flight activation lease`() throws {
        let (defaults, suiteName) = try makeOnboardingResumeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingCrestodianResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        let state = AppState(preview: true)
        state.connectionMode = .local
        let view = OnboardingView(state: state, crestodianDefaults: defaults)
        let priorChat = view.crestodianState.chat
        view.aiSetup.manualKey = "local-secret"
        view.crestodianState.isPresented = true

        view.selectUnconfiguredGateway()

        #expect(state.connectionMode == .unconfigured)
        #expect(view.aiSetup.manualKey.isEmpty)
        #expect(!view.crestodianState.isPresented)
        #expect(view.crestodianState.chat !== priorChat)
        #expect(OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
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
}
