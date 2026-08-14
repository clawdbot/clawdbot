import Foundation

enum GatewayAutostartPolicy {
    static func shouldStartGateway(mode: AppState.ConnectionMode, paused: Bool) -> Bool {
        mode == .local && !paused
    }

    @MainActor
    static func activateGatewayForRecovery(
        mode: AppState.ConnectionMode = AppStateStore.shared.connectionMode,
        paused: Bool = AppStateStore.shared.isPaused,
        activate: @MainActor () -> Void = { GatewayProcessManager.shared.setActive(true) }) -> Bool
    {
        guard self.shouldStartGateway(mode: mode, paused: paused) else { return false }
        activate()
        return true
    }

    static func shouldEnsureLaunchAgent(
        mode: AppState.ConnectionMode,
        paused: Bool) -> Bool
    {
        self.shouldStartGateway(mode: mode, paused: paused)
    }
}
