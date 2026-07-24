import Foundation

final class ExecHostReplayGuard: @unchecked Sendable {
    /// Requests are accepted within a ±10 second timestamp window. Retain
    /// consumed nonces for twice that span so every otherwise-fresh replay fails.
    private static let retentionMs = 20000

    private let lock = NSLock()
    private var consumedNonces: [String: Int] = [:]

    func consume(nonce: String, nowMs: Int) -> Bool {
        guard !nonce.isEmpty else { return false }
        return self.lock.withLock {
            let cutoff = nowMs - Self.retentionMs
            self.consumedNonces = self.consumedNonces.filter { $0.value >= cutoff }
            guard self.consumedNonces[nonce] == nil else { return false }
            self.consumedNonces[nonce] = nowMs
            return true
        }
    }
}
