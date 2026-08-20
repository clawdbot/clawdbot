import Foundation

final class AsyncTestGate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    func wait() async {
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let resumeImmediately = self.lock.withLock {
                    guard !self.isOpen, !Task.isCancelled else { return true }
                    self.waiters[id] = continuation
                    return false
                }
                if resumeImmediately {
                    continuation.resume()
                }
            }
        } onCancel: {
            let continuation = self.lock.withLock {
                self.waiters.removeValue(forKey: id)
            }
            continuation?.resume()
        }
    }

    func open() {
        let continuations = self.lock.withLock {
            self.isOpen = true
            defer { self.waiters.removeAll() }
            return Array(self.waiters.values)
        }
        for continuation in continuations {
            continuation.resume()
        }
    }
}
