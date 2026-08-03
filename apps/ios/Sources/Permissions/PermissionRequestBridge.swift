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

    static func awaitRequest(
        _ start: @escaping @Sendable (@escaping @Sendable (Bool) -> Void) -> Void) async -> Bool
    {
        let box = Box()
        return await withTaskCancellationHandler {
            await withCheckedContinuation(isolation: nil) { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(returning: false)
                    return
                }
                guard box.install(continuation) else { return }
                Task { @MainActor in
                    guard box.canStartRequest() else { return }
                    start { granted in
                        box.resume(granted)
                    }
                }
            }
        } onCancel: {
            box.resume(false)
        }
    }
}
