import Foundation

extension ExecHostExecutor {
    static func commandResponse(
        execution: Task<ShellExecutor.ShellResult, Never>) async -> ExecHostResponse
    {
        let result = await execution.value
        if let preflightError = result.preflightError {
            return self.errorResponse(
                code: "UNAVAILABLE",
                message: preflightError,
                reason: "approval-required")
        }
        let payload = ExecHostRunResult(
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            success: result.success,
            stdout: ExecHostOutputLimiter.truncate(result.stdout),
            stderr: ExecHostOutputLimiter.truncate(result.stderr),
            error: result.errorMessage)
        return self.successResponse(payload)
    }

    static func errorResponse(_ error: ExecHostError) -> ExecHostResponse {
        ExecHostResponse(
            type: "response",
            id: UUID().uuidString,
            ok: false,
            payload: nil,
            error: error)
    }

    static func errorResponse(
        code: String,
        message: String,
        reason: String?) -> ExecHostResponse
    {
        ExecHostResponse(
            type: "exec-res",
            id: UUID().uuidString,
            ok: false,
            payload: nil,
            error: ExecHostError(code: code, message: message, reason: reason))
    }

    static func successResponse(_ payload: ExecHostRunResult) -> ExecHostResponse {
        ExecHostResponse(
            type: "exec-res",
            id: UUID().uuidString,
            ok: true,
            payload: payload,
            error: nil)
    }
}
