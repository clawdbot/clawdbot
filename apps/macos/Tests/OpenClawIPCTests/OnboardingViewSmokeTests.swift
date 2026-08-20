import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawIPC
import OpenClawKit
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
    @Test func `discovered gateway summary uses localized runtime strings`() {
        #expect(
            OnboardingView.remoteChoiceSubtitle(discoveredGatewayCount: 1) ==
                "1 gateway found on your network — click to choose it.")
        #expect(
            OnboardingView.remoteChoiceSubtitle(discoveredGatewayCount: 2) ==
                "2 gateways found on your network — click to choose one.")
    }

    @Test func `foreign local listener is not advertised as attachable`() {
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "p2380"])
        let foreign = OnboardingView.LocalGatewayProbe(
            port: profile.defaultGatewayPort,
            pid: 1402,
            command: "node",
            profile: profile,
            managedServicePID: 2380)
        let managed = OnboardingView.LocalGatewayProbe(
            port: profile.defaultGatewayPort,
            pid: 2380,
            command: "node",
            profile: profile,
            managedServicePID: 2380)
        let inactiveUnexpected = OnboardingView.LocalGatewayProbe(
            port: 18789,
            pid: 3301,
            command: "python",
            profile: AppProfile(environment: [:]),
            managedServicePID: nil)

        #expect(foreign.subtitle ==
            "Port 55636 already in use (node pid 1402). Choose a different Gateway port for profile p2380.")
        #expect(managed.subtitle == "Existing gateway detected (node pid 2380). Will attach.")
        #expect(inactiveUnexpected.subtitle == "Port 18789 already in use (python pid 3301). Will attach.")
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

    @Test func `configured flows end at AI setup and hand off to the dashboard`() {
        // Everything after working inference (memory import, permissions,
        // channels, hatch) belongs to the dashboard custodian onboarding.
        #expect(OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: true) == [0, 1, 2, 3])
        #expect(OnboardingView.pageOrder(
            for: .local,
            requiresCLIInstall: false) == [0, 1, 3])
        #expect(OnboardingView.pageOrder(
            for: .remote,
            requiresCLIInstall: true) == [0, 1, 2, 3])
        #expect(OnboardingView.pageOrder(
            for: .remote,
            requiresCLIInstall: false) == [0, 1, 3])
    }

    @Test func `set up later keeps the native ready page`() {
        #expect(OnboardingView.pageOrder(
            for: .unconfigured,
            requiresCLIInstall: false) == [0, 1, 9])
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
        #expect(OnboardingView.shouldAutoInstallCLI(
            onCLIPage: order.contains(2),
            visible: true,
            statusKnown: true,
            executableReady: false,
            installed: false,
            installing: false))
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
            visible: true,
            statusKnown: false,
            executableReady: false,
            installed: false,
            installing: false))
        #expect(OnboardingView.shouldAutoInstallCLI(
            onCLIPage: true,
            visible: true,
            statusKnown: true,
            executableReady: false,
            installed: false,
            installing: false))
        #expect(!OnboardingView.shouldAutoInstallCLI(
            onCLIPage: true,
            visible: false,
            statusKnown: true,
            executableReady: false,
            installed: false,
            installing: false))
        #expect(!OnboardingView.shouldAutoInstallCLI(
            onCLIPage: true,
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

    @Test func `later gateway readiness revises a pinned CLI activation failure`() {
        #expect(OnboardingView.shouldReviseCLIActivationFailure(
            gatewayStatus: .running(details: "pid 4242"),
            isLocal: true,
            executableReady: true,
            installed: false))
        #expect(OnboardingView.shouldReviseCLIActivationFailure(
            gatewayStatus: .attachedExisting(details: "pid 4242"),
            isLocal: true,
            executableReady: true,
            installed: false))
        #expect(!OnboardingView.shouldReviseCLIActivationFailure(
            gatewayStatus: .failed("still unavailable"),
            isLocal: true,
            executableReady: true,
            installed: false))
        #expect(!OnboardingView.shouldReviseCLIActivationFailure(
            gatewayStatus: .running(details: nil),
            isLocal: false,
            executableReady: true,
            installed: false))
    }

    @Test func `gateway start failure message retains the concrete reason`() {
        #expect(
            OnboardingView.gatewayStartFailureMessage(
                prefix: "OpenClaw was installed, but the Gateway did not start. Retry setup.",
                reason: "launchd disabled") ==
                "OpenClaw was installed, but the Gateway did not start. Retry setup. (launchd disabled)")
        #expect(
            OnboardingView.gatewayStartFailureMessage(
                prefix: "OpenClaw was installed, but the Gateway did not start. Retry setup.",
                reason: nil) ==
                "OpenClaw was installed, but the Gateway did not start. Retry setup.")
        #expect(
            OnboardingView.gatewayStartFailureMessage(
                prefix: "OpenClaw was installed, but the Gateway did not start. Retry setup.",
                reason: "") ==
                "OpenClaw was installed, but the Gateway did not start. Retry setup.")
    }

    @Test func `connection mode change restarts full page monitoring`() {
        let state = AppState(preview: true)
        let view = OnboardingView(state: state)
        var monitoredPage: Int?
        view.aiSetup.manualKey = "route-bound"

        view.handleConnectionModeChange { pageIndex in
            monitoredPage = pageIndex
        }

        #expect(view.aiSetup.manualKey.isEmpty)
        #expect(monitoredPage == view.activePageIndex)
    }

    @Test func `gateway route reset keeps the AI page blocking until inference verifies`() throws {
        let order = OnboardingView.pageOrder(
            for: .remote,
            requiresCLIInstall: false)
        let aiCursor = try #require(order.firstIndex(of: 3))
        let resetCursor = OnboardingView.pageCursorAfterGatewayReset(
            currentPage: order.count - 1,
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
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName),
                systemAgentDefaults: defaults)
            view.aiSetup.manualKey = "route-a-secret"
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
        view.remoteProbeState = .ok(
            view.remoteGatewayProbeInput,
            RemoteGatewayProbeSuccess(authSource: .sharedToken))
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
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName),
                systemAgentDefaults: defaults)
            view.aiSetup.manualKey = "pending-secret"
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
        view.aiSetup.manualKey = "route-a-secret"

        view.selectLocalGateway()

        #expect(state.connectionMode == .local)
        #expect(view.aiSetup.manualKey.isEmpty)
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
        view.aiSetup.manualKey = "pending-secret"

        view.selectLocalGateway()

        #expect(view.aiSetup.manualKey == "pending-secret")
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `configure later preserves in flight activation lease`() throws {
        let (defaults, suiteName) = try makeOnboardingResumeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingSystemAgentResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        let state = AppState(preview: true)
        state.connectionMode = .local
        let view = OnboardingView(state: state, systemAgentDefaults: defaults)
        view.aiSetup.manualKey = "local-secret"

        view.selectUnconfiguredGateway()

        #expect(state.connectionMode == .unconfigured)
        #expect(view.aiSetup.manualKey.isEmpty)
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
}
