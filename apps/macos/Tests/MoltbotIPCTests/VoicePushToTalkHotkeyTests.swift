import AppKit
import Testing
@testable import Moltbot

@Suite(.serialized) struct VoicePushToTalkHotkeyTests {
    actor Counter {
        private(set) var began = 0
        private(set) var ended = 0

        func incBegin() { self.began += 1 }
        func incEnd() { self.ended += 1 }
        func snapshot() -> (began: Int, ended: Int) { (self.began, self.ended) }
    }

    @Test func beginEndFiresOncePerHold() async {
        let counter = Counter()
        let hotkey = VoicePushToTalkHotkey(
            beginAction: { await counter.incBegin() },
            endAction: { await counter.incEnd() })

        await MainActor.run {
            hotkey._testUpdateModifierState(keyCode: 61, modifierFlags: [.option])
            hotkey._testUpdateModifierState(keyCode: 61, modifierFlags: [.option])
            hotkey._testUpdateModifierState(keyCode: 61, modifierFlags: [])
        }

        for _ in 0..<50 {
            let snap = await counter.snapshot()
            if snap.began == 1, snap.ended == 1 { break }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        let snap = await counter.snapshot()
        #expect(snap.began == 1)
        #expect(snap.ended == 1)
    }
}
