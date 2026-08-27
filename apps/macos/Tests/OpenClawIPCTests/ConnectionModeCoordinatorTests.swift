import Testing
@testable import OpenClaw

@MainActor
struct ConnectionModeCoordinatorTests {
    @Test(arguments: [
        (AppState.ConnectionMode.unconfigured, AppState.ConnectionMode.local),
        (AppState.ConnectionMode.remote, AppState.ConnectionMode.local),
        (AppState.ConnectionMode.local, AppState.ConnectionMode.remote),
    ])
    func `newer connection mode owns transition side effects`(
        previousMode: AppState.ConnectionMode,
        nextMode: AppState.ConnectionMode)
    {
        var transition = ConnectionModeCoordinator.Transition()
        let previousGeneration = transition.begin(previousMode)
        let currentGeneration = transition.begin(nextMode)

        #expect(!transition.isCurrent(previousGeneration, mode: previousMode))
        #expect(transition.isCurrent(currentGeneration, mode: nextMode))
    }

    @Test func `reselecting the same mode invalidates its prior transition`() {
        var transition = ConnectionModeCoordinator.Transition()
        let previousGeneration = transition.begin(.remote)
        let currentGeneration = transition.begin(.remote)

        #expect(!transition.isCurrent(previousGeneration, mode: .remote))
        #expect(transition.isCurrent(currentGeneration, mode: .remote))
    }
}
