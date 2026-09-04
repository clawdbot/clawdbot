import Foundation

@MainActor
enum ExecHostExecutor {
    static func handle(_ request: ExecHostRequest) async -> ExecHostResponse {
        guard !Task.isCancelled else { return self.cancelledResponse() }
        let validatedRequest: ExecHostValidatedRequest
        switch ExecHostRequestEvaluator.validateRequest(request) {
        case let .success(request):
            validatedRequest = request
        case let .failure(error):
            return self.errorResponse(error)
        }
        guard let approvedCwdSnapshot = ExecCommandResolution.captureApprovalCwdSnapshot(request.cwd)
        else {
            return self.errorResponse(
                code: "UNAVAILABLE",
                message: "Working directory does not exist, is inaccessible, or is not a directory.",
                reason: "cwd-unavailable")
        }

        let effectiveCwd = approvedCwdSnapshot.path
        let context = await self.buildContext(
            request: request,
            command: validatedRequest.command,
            rawCommand: validatedRequest.evaluationRawCommand,
            displayCommand: validatedRequest.displayCommand,
            cwd: effectiveCwd)
        guard !Task.isCancelled else { return self.cancelledResponse() }
        let approvalSource = validatedRequest.approvalSource
        let security = ExecHostRequestEvaluator.effectiveSecurity(
            context: context,
            approvalSource: approvalSource)
        var explicitlyApproved = approvalSource == .autoReview ||
            request.approvalDecision == .allowOnce ||
            request.approvalDecision == .allowAlways
        var persistAllowlist = request.approvalDecision == .allowAlways

        switch ExecHostRequestEvaluator.evaluate(
            context: context,
            approvalDecision: request.approvalDecision,
            approvalSource: approvalSource)
        {
        case let .deny(error):
            return self.errorResponse(error)
        case .allow:
            break
        case .requiresPrompt:
            guard let decision = await ExecApprovalsPromptPresenter.prompt(
                ExecApprovalPromptRequest(
                    command: context.displayCommand,
                    cwd: effectiveCwd,
                    host: "node",
                    security: context.security.rawValue,
                    ask: context.ask.rawValue,
                    agentId: context.agentId,
                    resolvedPath: context.resolution?.resolvedPath,
                    sessionKey: request.sessionKey,
                    allowedDecisions: ExecApprovalPromptRequest.allowedDecisions(
                        forAsk: context.ask.rawValue,
                        allowAlwaysEligible: context.canPersistAllowAlways)),
                timeoutMs: execApprovalsSocketTimeoutMs)
            else {
                return self.errorResponse(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: approval prompt closed without decision",
                    reason: "approval-cancelled")
            }

            let followupDecision: ExecApprovalDecision
            switch decision {
            case .deny:
                followupDecision = .deny
            case .allowAlways:
                explicitlyApproved = true
                followupDecision = .allowAlways
            case .allowOnce:
                explicitlyApproved = true
                followupDecision = .allowOnce
            }
            persistAllowlist = followupDecision == .allowAlways

            switch ExecHostRequestEvaluator.evaluate(
                context: context,
                approvalDecision: followupDecision,
                approvalSource: approvalSource)
            {
            case let .deny(error):
                return self.errorResponse(error)
            case .allow:
                break
            case .requiresPrompt:
                return self.errorResponse(
                    code: "INVALID_REQUEST",
                    message: "unexpected approval state",
                    reason: "invalid")
            }
        }

        let authorizationBasis = context.authorizationBasis
        let reusableAuthorization = security == .allowlist &&
            !explicitlyApproved &&
            authorizationBasis != nil

        let executionCommand: [String]
        if reusableAuthorization {
            guard let boundCommand = context.boundCommand else {
                return self.errorResponse(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: reusable approval could not bind executable",
                    reason: "allowlist-unbound")
            }
            executionCommand = boundCommand
        } else {
            executionCommand = validatedRequest.command
        }

        if let errorResponse = await self.ensureScreenRecordingAccess(request.needsScreenRecording) {
            return errorResponse
        }

        // Awaited policy, approval, and permission work cannot revive a closed caller.
        guard !Task.isCancelled else { return self.cancelledResponse() }
        let executionCommit = ExecApprovalExecutionCommit.build(
            context: context,
            effectiveSecurity: security,
            approvalSource: approvalSource,
            explicitlyApproved: explicitlyApproved,
            persistAllowlist: persistAllowlist,
            delayedPolicySnapshot: validatedRequest.delayedPolicySnapshot)
        let timeoutSec = request.timeoutMs.flatMap { Double($0) / 1000.0 }
        let env = context.env
        if case .failure = ExecApprovalsStore.commitExecution(executionCommit) {
            return self.approvalStoreErrorResponse()
        }

        // The store commit linearizes authorization. Enqueue before the next
        // suspension so no unrelated MainActor work sits between those steps.
        let execution = Task.detached { () -> ShellExecutor.ShellResult in
            await self.runApprovedCommand(
                authorization: executionCommit.authorization,
                command: executionCommand,
                cwd: approvedCwdSnapshot,
                env: env,
                timeout: timeoutSec)
        }
        return await self.commandResponse(execution: execution)
    }

    nonisolated static func runApprovedCommand(
        authorization: ExecApprovalAuthorization,
        command: [String],
        cwd: ExecApprovalCwdSnapshot,
        env: [String: String],
        timeout: Double?) async -> ShellExecutor.ShellResult
    {
        await ShellExecutor.runDetailed(
            command: command,
            cwd: cwd.path,
            env: env,
            timeout: timeout,
            beforeSpawn: {
                // Local policy is committed, but Gateway-derived trust can retire
                // while the command waits for application launch admission.
                switch authorization {
                case let .currentPolicy(.allowlist, _, .autoAllowedSkill(snapshot)?),
                     let .askFallback(.allowlist, .autoAllowedSkill(snapshot)?):
                    guard snapshot.isCurrent else {
                        return "SYSTEM_RUN_DENIED: gateway skill trust changed; retry on the current gateway"
                    }
                default:
                    break
                }
                return ExecCommandResolution.revalidateApprovalCwdSnapshot(cwd)
                    ? nil
                    : ExecCommandResolution.approvalCwdDriftDeniedMessage
            })
    }

    private static func buildContext(
        request: ExecHostRequest,
        command: [String],
        rawCommand: String?,
        displayCommand: String,
        cwd: String) async -> ExecApprovalEvaluation
    {
        await ExecApprovalEvaluator.evaluate(
            command: command,
            rawCommand: rawCommand,
            displayCommand: displayCommand,
            cwd: cwd,
            envOverrides: request.env,
            agentId: request.agentId)
    }

    private static func approvalStoreErrorResponse() -> ExecHostResponse {
        self.errorResponse(
            code: "UNAVAILABLE",
            message: "SYSTEM_RUN_DENIED: exec approvals update unavailable",
            reason: "approval-store-unavailable")
    }

    private static func ensureScreenRecordingAccess(_ needsScreenRecording: Bool?) async -> ExecHostResponse? {
        guard needsScreenRecording == true else { return nil }
        let authorized = await PermissionManager
            .grantedStatus([.screenRecording])[.screenRecording] ?? false
        if authorized {
            return nil
        }
        return self.errorResponse(
            code: "UNAVAILABLE",
            message: "PERMISSION_MISSING: screenRecording",
            reason: "permission:screenRecording")
    }
}
