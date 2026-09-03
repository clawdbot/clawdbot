import Foundation
import OpenClawDiscovery
import SwiftUI

extension OnboardingView {
    func selectLocalGateway() {
        if state.connectionMode != .local {
            resetGatewayBoundAIState()
        }
        defaultsToLocalGateway = false
        state.connectionMode = .local
        preferredGatewayID = nil
        showAdvancedConnection = false
        showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
        probeConfiguredGatewayForDashboard()
    }

    func selectUnconfiguredGateway() {
        resetGatewayBoundAIState()
        defaultsToLocalGateway = false
        state.connectionMode = .unconfigured
        preferredGatewayID = nil
        showAdvancedConnection = false
        showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func handleRemoteSelection() {
        defaultsToLocalGateway = false
        state.connectionMode = .remote
        showRemoteChoices.toggle()
    }

    func selectRemoteGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) {
        guard let setupInput = GatewayDiscoverySelectionSupport.requestSetupCode(for: gateway) else { return }
        Task { @MainActor in
            do {
                let route = try await GatewayDiscoveryPairing.authenticate(setupInput: setupInput)
                guard self.completeRemoteGatewaySelection(gateway, route: route) else {
                    throw GatewayDiscoveryPairingError.configSaveFailed
                }
            } catch {
                GatewayDiscoverySelectionSupport.presentError(error)
            }
        }
    }

    @discardableResult
    func completeRemoteGatewaySelection(
        _ gateway: GatewayDiscoveryModel.DiscoveredGateway,
        route: AuthenticatedGatewayRoute) -> Bool
    {
        let previousFingerprint = GatewayDiscoveryPreferences.authenticatedTLSFingerprint()
        let shouldResetGatewayState = Self.shouldResetGatewayBoundAIState(
            connectionMode: state.connectionMode,
            currentPreferredGatewayID: self.effectivePreferredGatewayID,
            persistedPreferredGatewayID: GatewayDiscoveryPreferences.preferredStableID(),
            selectedGatewayID: gateway.stableID) ||
            (previousFingerprint != nil && previousFingerprint != route.tlsFingerprint)
        guard GatewayDiscoverySelectionSupport.applyAuthenticatedSelection(
            stableID: gateway.stableID,
            route: route,
            state: state)
        else { return false }
        if shouldResetGatewayState {
            resetGatewayBoundAIState()
            resetRemoteProbeFeedback()
        }
        defaultsToLocalGateway = false
        preferredGatewayID = gateway.stableID
        probeConfiguredGatewayForDashboard()
        return true
    }

    static func shouldResetGatewayBoundAIState(
        connectionMode: AppState.ConnectionMode,
        currentPreferredGatewayID: String?,
        persistedPreferredGatewayID: String?,
        selectedGatewayID: String) -> Bool
    {
        let currentGatewayID = Self.normalizedGatewayID(currentPreferredGatewayID) ??
            Self.normalizedGatewayID(persistedPreferredGatewayID)
        return connectionMode != .remote || currentGatewayID != Self.normalizedGatewayID(selectedGatewayID)
    }

    private static func normalizedGatewayID(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    var effectivePreferredGatewayID: String? {
        let persisted = Self.normalizedGatewayID(GatewayDiscoveryPreferences.preferredStableID())
        guard let local = Self.normalizedGatewayID(preferredGatewayID) else {
            return persisted
        }
        // Config-watcher endpoint changes clear the persisted owner. Ignore the
        // stale @State copy until the view's next render catches up.
        return local == persisted ? local : persisted
    }

    func openSettings(tab: SettingsTab) {
        AppNavigationActions.openSettings(tab: tab)
    }

    func handleBack() {
        withAnimation {
            self.currentPage = max(0, self.currentPage - 1)
        }
    }

    func handleNext() {
        guard canAdvance else { return }
        let remoteDecision = Self.remoteGatewayAdvanceDecision(
            connectionMode: state.connectionMode,
            activePageIndex: activePageIndex,
            connectionPageIndex: connectionPageIndex,
            authIssue: remoteAuthIssue,
            probeState: remoteProbeState,
            input: remoteGatewayProbeInput)
        guard remoteDecision.canAdvance else {
            if remoteDecision.shouldProbe {
                Task { await self.probeRemoteConnection(advanceOnSuccess: true) }
            }
            return
        }
        self.commitRecommendedConnectionIfNeeded(for: activePageIndex)
        if currentPage < pageCount - 1 {
            withAnimation { self.currentPage += 1 }
        } else {
            self.finish()
        }
    }

    func commitRecommendedConnectionIfNeeded(for pageIndex: Int) {
        if pageIndex == connectionPageIndex,
           defaultsToLocalGateway,
           state.connectionMode == .unconfigured
        {
            self.selectLocalGateway()
        }
    }

    @discardableResult
    func finish() -> Bool {
        guard !finishState.didFinish else { return false }
        finishState.didFinish = true
        aiSetup.clearCompletedHandoffIfOwned()
        OnboardingController.markComplete()
        OnboardingController.shared.close()
        guard state.connectionMode != .unconfigured else { return true }
        // Fresh activation hands off to the dashboard's custodian onboarding, which
        // owns the remaining first-run steps (memory import, channels, permissions,
        // hatch). A live-verified pre-existing setup reopens the normal dashboard.
        dashboardHandoffOpener(aiSetup.verifiedExistingInference ? .dashboard : .custodianOnboarding)
        return true
    }
}
