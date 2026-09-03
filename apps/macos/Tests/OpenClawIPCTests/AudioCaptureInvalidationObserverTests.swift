import AppKit
import AVFoundation
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AudioCaptureInvalidationObserverTests {
    @Test func observesEngineChangesAndWorkspaceWakeUntilStopped() {
        let configurationCenter = NotificationCenter()
        let wakeCenter = NotificationCenter()
        let engine = AVAudioEngine()
        let configurationRecorder = InvalidationRecorder()
        let wakeRecorder = InvalidationRecorder()
        let observer = AudioCaptureInvalidationObserver(
            configurationCenter: configurationCenter,
            wakeCenter: wakeCenter)

        observer.start(
            engine: engine,
            onConfigurationChange: { configurationRecorder.record() },
            onWake: { wakeRecorder.record() },
            startEngine: {
                configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: engine)
                wakeCenter.post(name: NSWorkspace.didWakeNotification, object: NSObject())
            })
        #expect(configurationRecorder.count == 1)
        #expect(wakeRecorder.count == 1)

        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: engine)
        wakeCenter.post(name: NSWorkspace.didWakeNotification, object: NSObject())
        #expect(configurationRecorder.count == 2)
        #expect(wakeRecorder.count == 2)

        observer.stop()
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: engine)
        wakeCenter.post(name: NSWorkspace.didWakeNotification, object: NSObject())
        #expect(configurationRecorder.count == 2)
        #expect(wakeRecorder.count == 2)
    }

    @Test func ignoresOtherEngines() {
        let configurationCenter = NotificationCenter()
        let wakeCenter = NotificationCenter()
        let observedEngine = AVAudioEngine()
        let recorder = InvalidationRecorder()
        let observer = AudioCaptureInvalidationObserver(
            configurationCenter: configurationCenter,
            wakeCenter: wakeCenter)

        observer.start(
            engine: observedEngine,
            onConfigurationChange: { recorder.record() },
            onWake: {},
            startEngine: {})
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: AVAudioEngine())
        #expect(recorder.count == 0)
    }

    @Test func retiresObserversWhenEngineStartFails() {
        let configurationCenter = NotificationCenter()
        let wakeCenter = NotificationCenter()
        let engine = AVAudioEngine()
        let configurationRecorder = InvalidationRecorder()
        let wakeRecorder = InvalidationRecorder()
        let observer = AudioCaptureInvalidationObserver(
            configurationCenter: configurationCenter,
            wakeCenter: wakeCenter)

        #expect(throws: InvalidationStartError.self) {
            try observer.start(
                engine: engine,
                onConfigurationChange: { configurationRecorder.record() },
                onWake: { wakeRecorder.record() },
                startEngine: {
                    configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: engine)
                    wakeCenter.post(name: NSWorkspace.didWakeNotification, object: NSObject())
                    throw InvalidationStartError.failed
                })
        }
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: engine)
        wakeCenter.post(name: NSWorkspace.didWakeNotification, object: NSObject())
        #expect(configurationRecorder.count == 0)
        #expect(wakeRecorder.count == 0)
    }
}

private enum InvalidationStartError: Error {
    case failed
}

private final class InvalidationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    var count: Int {
        self.lock.withLock { self.value }
    }

    func record() {
        self.lock.withLock { self.value += 1 }
    }
}
