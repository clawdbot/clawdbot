import Testing
@testable import OpenClaw

@MainActor
struct VoiceWakeEnablementTests {
    @Test(arguments: [false, true])
    func `cancelled requests preserve the current voice wake setting`(_ enabled: Bool) async {
        await TestIsolation.withIsolatedState(defaults: [swabbleEnabledKey: false]) {
            let state = AppState(preview: true)
            state.swabbleEnabled = !enabled
            let request = Task { @MainActor in
                withUnsafeCurrentTask { $0?.cancel() }
                await state.setVoiceWakeEnabled(enabled)
            }
            await request.value
            #expect(state.swabbleEnabled == !enabled)
        }
    }
}
