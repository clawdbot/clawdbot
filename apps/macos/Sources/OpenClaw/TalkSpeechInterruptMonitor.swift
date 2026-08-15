import AppKit
import OSLog

/// Monitors right Option key (keyCode 61) to interrupt Talk Mode speech.
/// Independent of Push-to-Talk — active whenever Talk Mode is enabled.
final class TalkSpeechInterruptMonitor: @unchecked Sendable {
    static let shared = TalkSpeechInterruptMonitor()

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.interrupt")
    private var globalMonitor: Any?
    private var localMonitor: Any?

    func setEnabled(_ enabled: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if enabled {
                self.startMonitoring()
            } else {
                self.stopMonitoring()
            }
        }
    }

    private func startMonitoring() {
        guard self.globalMonitor == nil, self.localMonitor == nil else { return }
        self.globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlags(keyCode: event.keyCode, modifierFlags: event.modifierFlags)
        }
        self.localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlags(keyCode: event.keyCode, modifierFlags: event.modifierFlags)
            return event
        }
        self.logger.info("talk interrupt monitor started")
    }

    private func stopMonitoring() {
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
            self.localMonitor = nil
        }
        self.logger.info("talk interrupt monitor stopped")
    }

    private func handleFlags(keyCode: UInt16, modifierFlags: NSEvent.ModifierFlags) {
        // Right Option key down (keyCode 61).
        guard keyCode == 61, modifierFlags.contains(.option) else { return }
        Task { @MainActor in
            guard TalkModeController.shared.phase == .speaking else { return }
            self.logger.info("right option — interrupting talk mode speech")
            TalkModeController.shared.stopSpeaking(reason: .userTap)
        }
    }
}
