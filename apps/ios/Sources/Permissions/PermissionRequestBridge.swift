import Foundation

enum PermissionRequestBridge {
    final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Bool, Never>?
        private var hasResumed = false

        func install(_ continuation: CheckedContinuation<Bool, Never>) -> Bool {
            self.lock.lock()
            if self.hasResumed {
                self.lock.unlock()
                continuation.resume(returning: false)
                return false
            }
            self.continuation = continuation
            self.lock.unlock()
            return true
        }

        func resume(_ value: Bool) {
            self.lock.lock()
            guard !self.hasResumed else {
                self.lock.unlock()
                return
            }
            self.hasResumed = true
            let continuation = self.continuation
            self.continuation = nil
            self.lock.unlock()
            continuation?.resume(returning: value)
        }

        func canStartRequest() -> Bool {
            self.lock.lock()
            let canStart = !self.hasResumed
            self.lock.unlock()
            return canStart
        }
    }

    @MainActor static func awaitRequest(
        isCurrent: @escaping @MainActor @Sendable () -> Bool = { true },
        _ start: @escaping @MainActor @Sendable (@escaping @Sendable (Bool) -> Void) -> Void) async -> Bool
    {
        let box = Box()
        let granted = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard box.install(continuation) else { return }
                // Privileged actions require current owner-held authority after awaited work and before side effects.
                // Keep this check and OS initiation synchronous on the main actor.
                guard box.canStartRequest(), !Task.isCancelled, isCurrent() else {
                    box.resume(false)
                    return
                }
                start { granted in
                    box.resume(granted)
                }
            }
        } onCancel: {
            box.resume(false)
        }
        return !Task.isCancelled && isCurrent() && granted
    }
}
