import OSLog

extension GatewayNodeSession {
    static func invokeWithTimeout(
        request: BridgeInvokeRequest,
        timeoutMs: Int?,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        onOperationSettled: (@Sendable () async -> Void)? = nil) async -> BridgeInvokeResponse
    {
        let timeoutLogger = Logger(subsystem: "ai.openclaw", category: "node.gateway")
        let timeout = timeoutMs.map { min(max(0, $0), Self.maxInvokeTimeoutMs) } ?? Self.defaultInvokeTimeoutMs
        guard timeout > 0 else {
            let response = await onInvoke(request)
            await onOperationSettled?()
            return response
        }

        // Keep the wrapper detached: this nonthrowing API historically lets the invoke/timeout
        // race settle even when its caller is cancelled.
        let response = await Task.detached {
            await (try? AsyncTimeout.withTimeoutMs(
                timeoutMs: timeout,
                onTimeout: {
                    timeoutLogger.info("node invoke timeout fired id=\(request.id, privacy: .public)")
                    return CancellationError()
                },
                operation: {
                    let response = await onInvoke(request)
                    await onOperationSettled?()
                    return response
                })) ?? BridgeInvokeResponse(
                id: request.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "node invoke timed out"))
        }.value
        timeoutLogger
            .info("node invoke race resolved id=\(request.id, privacy: .public) ok=\(response.ok, privacy: .public)")
        return response
    }
}
