import AppKit
import Foundation
import OSLog

@MainActor
final class TerminationSignalWatcher {
    static let shared = TerminationSignalWatcher()

    private let logger = Logger(subsystem: "bot.molt", category: "lifecycle")
    private var sources: [DispatchSourceSignal] = []
    private var terminationRequested = false

    func start() {
        guard self.sources.isEmpty else { return }
        self.install(SIGTERM)
        self.install(SIGINT)
    }

    func stop() {
        for s in self.sources {
            s.cancel()
        }
        self.sources.removeAll(keepingCapacity: false)
        self.terminationRequested = false
    }

    private func install(_ sig: Int32) {
        // Make sure the default action doesn't kill the process before we can gracefully shut down.
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { [weak self] in
            self?.handle(sig)
        }
        source.resume()
        self.sources.append(source)
    }

    private func handle(_ sig: Int32) {
        guard !self.terminationRequested else { return }
        self.terminationRequested = true

        self.logger.info("received signal \(sig, privacy: .public); terminating")
        // Ensure any pairing prompt can't accidentally approve during shutdown.
        NodePairingApprovalPrompter.shared.stop()
        DevicePairingApprovalPrompter.shared.stop()
        NSApp.terminate(nil)

        // Safety net: don't hang forever if something blocks termination.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            exit(0)
        }
    }
}
