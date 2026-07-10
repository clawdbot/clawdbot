import Foundation

struct ExecHostValidatedRequest {
    let command: [String]
    let displayCommand: String
    let evaluationRawCommand: String?
    let approvalSource: ExecApprovalRequestSource?
}

enum ExecHostPolicyDecision {
    case deny(ExecHostError)
    case requiresPrompt
    case allow(approvedByAsk: Bool)
}

enum ExecHostRequestEvaluator {
    static func validateRequest(_ request: ExecHostRequest) -> Result<ExecHostValidatedRequest, ExecHostError> {
        let approvalSource: ExecApprovalRequestSource?
        switch request.approvalSource {
        case nil:
            approvalSource = nil
        case "ask-fallback":
            approvalSource = .askFallback
        case "auto-review":
            approvalSource = .autoReview
        default:
            return .failure(ExecHostError(
                code: "INVALID_REQUEST",
                message: "approvalSource invalid",
                reason: "invalid"))
        }
        if approvalSource != nil, request.approvalDecision != nil {
            return .failure(ExecHostError(
                code: "INVALID_REQUEST",
                message: "approvalSource cannot be combined with explicit approval",
                reason: "invalid"))
        }
        switch self.validateCommand(command: request.command, rawCommand: request.rawCommand) {
        case let .success(validated):
            return .success(ExecHostValidatedRequest(
                command: validated.command,
                displayCommand: validated.displayCommand,
                evaluationRawCommand: validated.evaluationRawCommand,
                approvalSource: approvalSource))
        case let .failure(error):
            return .failure(error)
        }
    }

    static func validateCommand(
        command: [String],
        rawCommand: String?) -> Result<ExecHostValidatedRequest, ExecHostError>
    {
        let executable = command.first ?? ""
        let trimmedExecutable = executable.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedExecutable.isEmpty else {
            return .failure(
                ExecHostError(
                    code: "INVALID_REQUEST",
                    message: "command required",
                    reason: "invalid"))
        }
        guard executable == trimmedExecutable else {
            return .failure(
                ExecHostError(
                    code: "INVALID_REQUEST",
                    message: "executable has surrounding whitespace",
                    reason: "invalid"))
        }

        let validatedCommand = ExecSystemRunCommandValidator.resolve(
            command: command,
            rawCommand: rawCommand)
        switch validatedCommand {
        case let .ok(resolved):
            return .success(ExecHostValidatedRequest(
                command: command,
                displayCommand: resolved.displayCommand,
                evaluationRawCommand: resolved.evaluationRawCommand,
                approvalSource: nil))
        case let .invalid(message):
            return .failure(
                ExecHostError(
                    code: "INVALID_REQUEST",
                    message: message,
                    reason: "invalid"))
        }
    }

    static func evaluate(
        context: ExecApprovalEvaluation,
        approvalDecision: ExecApprovalDecision?,
        approvalSource: ExecApprovalRequestSource? = nil) -> ExecHostPolicyDecision
    {
        let security = self.effectiveSecurity(context: context, approvalSource: approvalSource)
        if security == .deny {
            return .deny(
                ExecHostError(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DISABLED: security=deny",
                    reason: "security=deny"))
        }

        if approvalDecision == .deny {
            return .deny(
                ExecHostError(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: user denied",
                    reason: "user-denied"))
        }

        if approvalSource == .autoReview, context.ask == .always {
            return .deny(
                ExecHostError(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: auto-review cannot bypass ask=always",
                    reason: "ask=always"))
        }

        let approvedByAsk = approvalDecision != nil || approvalSource == .autoReview
        let requiresPrompt = approvalSource == nil && ExecApprovalHelpers.requiresAsk(
            ask: context.ask,
            security: security,
            allowlistMatch: context.allowlistMatch,
            skillAllow: context.skillAllow) && approvalDecision == nil
        if requiresPrompt {
            return .requiresPrompt
        }

        if security == .allowlist,
           !context.allowlistAuthorizationSatisfied,
           !context.skillAllow,
           !approvedByAsk
        {
            return .deny(
                ExecHostError(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: allowlist miss",
                    reason: "allowlist-miss"))
        }

        return .allow(approvedByAsk: approvedByAsk)
    }

    static func effectiveSecurity(
        context: ExecApprovalEvaluation,
        approvalSource: ExecApprovalRequestSource?) -> ExecSecurity
    {
        approvalSource == .askFallback
            ? ExecSecurity.narrower(context.security, context.askFallback)
            : context.security
    }
}
