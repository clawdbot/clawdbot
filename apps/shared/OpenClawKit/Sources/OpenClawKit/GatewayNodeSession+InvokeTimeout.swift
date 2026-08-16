import Foundation
import OSLog

extension GatewayNodeSession {
    static func invokeWithTimeout(
        request: BridgeInvokeRequest,
        timeoutMs: Int?,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        onOperationSettled: (@Sendable () async -> Void)? = nil) async -> BridgeInvokeResponse
    {
        let timeoutLogger = Logger(subsystem: "ai.openclaw", category: "node.gateway")
        let timeout: Int = {
            if let timeoutMs {
                return min(max(0, timeoutMs), Self.maxInvokeTimeoutMs)
            }
            return Self.defaultInvokeTimeoutMs
        }()
        guard timeout > 0 else {
            let response = await onInvoke(request)
            await onOperationSettled?()
            return response
        }

        // Use an explicit latch so timeouts win even if onInvoke blocks (e.g., permission prompts).
        final class InvokeLatch: @unchecked Sendable {
            private let lock = NSLock()
            private var continuation: CheckedContinuation<BridgeInvokeResponse, Never>?
            private var resumed = false

            func setContinuation(_ continuation: CheckedContinuation<BridgeInvokeResponse, Never>) {
                self.lock.lock()
                defer { self.lock.unlock() }
                self.continuation = continuation
            }

            func resume(_ response: BridgeInvokeResponse) {
                let cont: CheckedContinuation<BridgeInvokeResponse, Never>?
                self.lock.lock()
                if self.resumed {
                    self.lock.unlock()
                    return
                }
                self.resumed = true
                cont = self.continuation
                self.continuation = nil
                self.lock.unlock()
                cont?.resume(returning: response)
            }
        }

        let latch = InvokeLatch()
        var onInvokeTask: Task<Void, Never>?
        var timeoutTask: Task<Void, Never>?
        defer {
            onInvokeTask?.cancel()
            timeoutTask?.cancel()
        }
        let response = await withCheckedContinuation { (cont: CheckedContinuation<BridgeInvokeResponse, Never>) in
            latch.setContinuation(cont)
            onInvokeTask = Task.detached {
                let result = await onInvoke(request)
                await onOperationSettled?()
                latch.resume(result)
            }
            timeoutTask = Task.detached {
                do {
                    try await Task.sleep(nanoseconds: UInt64(timeout) * 1_000_000)
                } catch {
                    // Expected when invoke finishes first and cancels the timeout task.
                    return
                }
                guard !Task.isCancelled else { return }
                timeoutLogger.info("node invoke timeout fired id=\(request.id, privacy: .public)")
                latch.resume(BridgeInvokeResponse(
                    id: request.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "node invoke timed out")))
            }
        }
        timeoutLogger
            .info("node invoke race resolved id=\(request.id, privacy: .public) ok=\(response.ok, privacy: .public)")
        return response
    }
}
