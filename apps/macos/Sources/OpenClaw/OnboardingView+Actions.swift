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

    func selectRemoteGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) {
        let shouldResetGatewayState = Self.shouldResetGatewayBoundAIState(
            connectionMode: state.connectionMode,
            currentPreferredGatewayID: self.effectivePreferredGatewayID,
            persistedPreferredGatewayID: GatewayDiscoveryPreferences.preferredStableID(),
            selectedGatewayID: gateway.stableID)
        if shouldResetGatewayState {
            // The mode can remain `.remote` while the selected Gateway changes,
            // so its onChange hook alone cannot retire route-bound state.
            resetGatewayBoundAIState()
            resetRemoteProbeFeedback()
        }
        defaultsToLocalGateway = false
        preferredGatewayID = gateway.stableID
        GatewayDiscoverySelectionSupport.applyRemoteSelection(gateway: gateway, state: state)

        state.connectionMode = .remote
        MacNodeModeCoordinator.shared.setPreferredGatewayStableID(gateway.stableID, state: state)
        probeConfiguredGatewayForDashboard()
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
        // All callers (Next button, chat handoff) honor the same page gates.
        guard canAdvance else { return }
        if self.activePageIndex == self.memoryImportPageIndex,
           self.memoryImport.isFailed
        {
            self.memoryImport.dismissFailure()
            self.updateMonitoring(for: self.activePageIndex)
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

    func finish(agentDraft: SystemAgentDraft? = nil) {
        aiSetup.clearCompletedHandoffIfOwned()
        OnboardingController.markComplete()
        OnboardingController.shared.close()
        // Land people in the real conversation, not on an empty desktop: the
        // agent chat is the product, and it is verified working by now.
        if state.connectionMode != .unconfigured {
            AppNavigationActions.openChat(draft: agentDraft?.composerValue)
        }
    }

    func advancePastEmptyMemoryImportIfNeeded() {
        guard self.memoryImport.autoAdvanceRequested else { return }
        withAnimation {
            self.memoryImport.consumeAutoAdvanceRequest()
        }
        self.updateMonitoring(for: self.activePageIndex)
    }
}
