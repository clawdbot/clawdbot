import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI
import Testing
@testable import OpenClaw

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

    @Test func `page order omits workspace and identity steps`() {
        let order = OnboardingView.pageOrder(
            for: .local,
            showOnboardingChat: false,
            requiresCLIInstall: false)
        #expect(!order.contains(7))
        #expect(order.contains(3))
    }

    @Test func `page order omits onboarding chat when identity known`() {
        let order = OnboardingView.pageOrder(
            for: .local,
            showOnboardingChat: false,
            requiresCLIInstall: false)
        #expect(!order.contains(8))
    }

    @Test func `fresh local setup installs CLI before inference setup`() {
        let order = OnboardingView.pageOrder(
            for: .local,
            showOnboardingChat: false,
            requiresCLIInstall: true)

        #expect(order.firstIndex(of: 2) == 2)
        #expect(order.firstIndex(of: 3) == 3)
    }

    @Test func `configured local setup skips CLI install page`() {
        let order = OnboardingView.pageOrder(
            for: .local,
            showOnboardingChat: false,
            requiresCLIInstall: false)

        #expect(!order.contains(2))
    }

    @Test func `only full page chat uses compact hero`() {
        #expect(!OnboardingView.shouldUseCompactHero(
            activePageIndex: 3,
            onboardingChatPageIndex: 8))
        #expect(OnboardingView.shouldUseCompactHero(
            activePageIndex: 8,
            onboardingChatPageIndex: 8))
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
            showOnboardingChat: false,
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
