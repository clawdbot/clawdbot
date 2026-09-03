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
        onWake: @escaping @Sendable () -> Void,
        startEngine: () throws -> Void) rethrows
    {
        self.stop()
        let startupGate = AudioCaptureStartupInvalidationGate(
            onConfigurationChange: onConfigurationChange,
            onWake: onWake)
        self.configurationObserver = self.configurationCenter.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil)
        { _ in startupGate.receive(.configurationChange) }
        self.wakeObserver = self.wakeCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: nil)
        { _ in startupGate.receive(.wake) }
        // Arm before starting the engine so its first invalidation cannot be missed.
        // Buffer callbacks until success so a failed candidate cannot trigger recovery.
        var didStart = false
        defer {
            if !didStart {
                startupGate.cancel()
                self.stop()
            }
        }
        try startEngine()
        didStart = true
        startupGate.activate()
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

private final class AudioCaptureStartupInvalidationGate: @unchecked Sendable {
    enum Event {
        case configurationChange
        case wake
    }

    private let lock = NSLock()
    private let onConfigurationChange: @Sendable () -> Void
    private let onWake: @Sendable () -> Void
    private var active = false
    private var cancelled = false
    private var pendingConfigurationChange = false
    private var pendingWake = false

    init(
        onConfigurationChange: @escaping @Sendable () -> Void,
        onWake: @escaping @Sendable () -> Void)
    {
        self.onConfigurationChange = onConfigurationChange
        self.onWake = onWake
    }

    func receive(_ event: Event) {
        let deliver = self.lock.withLock {
            guard !self.cancelled else { return false }
            guard self.active else {
                switch event {
                case .configurationChange: self.pendingConfigurationChange = true
                case .wake: self.pendingWake = true
                }
                return false
            }
            return true
        }
        if deliver { self.deliver(event) }
    }

    func activate() {
        let pending = self.lock.withLock {
            guard !self.cancelled else { return (false, false) }
            self.active = true
            return (self.pendingConfigurationChange, self.pendingWake)
        }
        if pending.0 { self.onConfigurationChange() }
        if pending.1 { self.onWake() }
    }

    func cancel() {
        self.lock.withLock { self.cancelled = true }
    }

    private func deliver(_ event: Event) {
        switch event {
        case .configurationChange: self.onConfigurationChange()
        case .wake: self.onWake()
        }
    }
}
