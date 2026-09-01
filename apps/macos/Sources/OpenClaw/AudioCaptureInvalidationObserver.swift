import AppKit
import AVFoundation
import Foundation

final class AudioCaptureInvalidationObserver {
    private let configurationCenter: NotificationCenter
    private let wakeCenter: NotificationCenter
    private var configurationObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?

    init(
        configurationCenter: NotificationCenter = .default,
        wakeCenter: NotificationCenter)
    {
        self.configurationCenter = configurationCenter
        self.wakeCenter = wakeCenter
    }

    deinit {
        self.stop()
    }

    func start(
        engine: AVAudioEngine,
        onConfigurationChange: @escaping @Sendable () -> Void,
        onWake: @escaping @Sendable () -> Void)
    {
        self.stop()
        self.configurationObserver = self.configurationCenter.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil)
        { _ in onConfigurationChange() }
        self.wakeObserver = self.wakeCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: nil)
        { _ in onWake() }
    }

    func stop() {
        if let configurationObserver {
            self.configurationCenter.removeObserver(configurationObserver)
        }
        if let wakeObserver {
            self.wakeCenter.removeObserver(wakeObserver)
        }
        self.configurationObserver = nil
        self.wakeObserver = nil
    }
}
