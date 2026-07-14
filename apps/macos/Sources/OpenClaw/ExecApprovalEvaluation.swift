import Foundation
import OpenClawKit

struct ExecApprovalEvaluation {
    let displayCommand: String
    let agentId: String?
    let security: ExecSecurity
    let ask: ExecAsk
    let askFallback: ExecSecurity
    let env: [String: String]
    let resolution: ExecCommandResolution?
    let allowlistResolutions: [ExecCommandResolution]
    let boundCommand: [String]?
    let allowAlwaysPatterns: [String]
    let allowlistMatches: [ExecAllowlistEntry]
    let allowlistAuthorizationSatisfied: Bool
    let allowlistSatisfied: Bool
    let allowlistMatch: ExecAllowlistEntry?
    let skillAllow: Bool
    let policySnapshot: ExecApprovalPolicySnapshot

    var canPersistAllowAlways: Bool {
        self.security == .allowlist && self.boundCommand != nil && !self.allowAlwaysPatterns.isEmpty
    }

    var authorizationBasis: ExecApprovalAuthorization.Basis? {
        if self.allowlistAuthorizationSatisfied {
            return .allowlistEntries
        }
        if self.skillAllow {
            return .autoAllowedSkill
        }
        return nil
    }
}

enum ExecApprovalRequestSource: Sendable, Equatable {
    case askFallback
    case autoReview
}

struct ExecApprovalPolicySnapshot: Sendable, Equatable {
    struct AllowlistRule: Sendable, Hashable {
        let match: ExecAllowlistEntryMatchKey
        let source: String?

        func isSatisfied(by currentRules: Set<Self>) -> Bool {
            currentRules.contains(self) ||
                (self.source == nil && currentRules.contains(Self(
                    match: self.match,
                    source: "allow-always")))
        }
    }

    let security: ExecSecurity
    let ask: ExecAsk
    let askFallback: ExecSecurity
    let autoAllowSkills: Bool
    let allowlistRules: Set<AllowlistRule>

    init(
        security: ExecSecurity,
        ask: ExecAsk,
        askFallback: ExecSecurity,
        autoAllowSkills: Bool,
        allowlist: [ExecAllowlistEntry])
    {
        self.security = security
        self.ask = ask
        self.askFallback = askFallback
        self.autoAllowSkills = autoAllowSkills
        self.allowlistRules = Set(allowlist.map { entry in
            AllowlistRule(
                match: ExecApprovalsStore.allowlistEntryMatchKey(entry),
                source: entry.source == "allow-always" ? "allow-always" : nil)
        })
    }

    init(resolved approvals: ExecApprovalsResolved) {
        self.init(
            security: approvals.agent.security,
            ask: approvals.agent.ask,
            askFallback: approvals.agent.askFallback,
            autoAllowSkills: approvals.agent.autoAllowSkills,
            allowlist: approvals.allowlist)
    }

    init(portable: OpenClawSystemRunApprovalPolicySnapshot) {
        self.init(
            security: ExecSecurity(rawValue: portable.security.rawValue)!,
            ask: ExecAsk(rawValue: portable.ask.rawValue)!,
            askFallback: ExecSecurity(rawValue: portable.askFallback.rawValue)!,
            autoAllowSkills: portable.autoAllowSkills,
            allowlist: portable.allowlistRules.map { rule in
                ExecAllowlistEntry(
                    pattern: rule.pattern,
                    source: rule.source?.rawValue,
                    argPattern: rule.argPattern)
            })
    }

    var portable: OpenClawSystemRunApprovalPolicySnapshot {
        OpenClawSystemRunApprovalPolicySnapshot(
            security: .init(rawValue: self.security.rawValue)!,
            ask: .init(rawValue: self.ask.rawValue)!,
            askFallback: .init(rawValue: self.askFallback.rawValue)!,
            autoAllowSkills: self.autoAllowSkills,
            allowlistRules: self.allowlistRules.map { rule in
                OpenClawSystemRunApprovalPolicySnapshot.Rule(
                    pattern: Self.portableString(rule.match.pattern),
                    argPattern: rule.match.argPattern.isEmpty
                        ? nil
                        : Self.portableString(rule.match.argPattern),
                    source: rule.source == "allow-always" ? .allowAlways : nil)
            })
    }

    private static func portableString(_ data: Data) -> String {
        guard let value = String(data: data, encoding: .utf8) else {
            preconditionFailure("exec approval match keys must contain UTF-8 strings")
        }
        return value
    }

    func isCurrent(_ current: Self) -> Bool {
        self.security == current.security &&
            self.ask == current.ask &&
            self.askFallback == current.askFallback &&
            self.autoAllowSkills == current.autoAllowSkills &&
            // Concurrent grants and in-place allow-always upgrades are additive.
            // Revocation and reverse source downgrade still fail closed.
            self.allowlistRules.allSatisfy { $0.isSatisfied(by: current.allowlistRules) }
    }
}

enum ExecApprovalAuthorization: Sendable {
    enum Basis: Sendable, Equatable {
        case allowlistEntries
        case autoAllowedSkill
    }

    case currentPolicy(evaluatedSecurity: ExecSecurity, evaluatedAsk: ExecAsk, basis: Basis?)
    case askFallback(evaluatedSecurity: ExecSecurity, basis: Basis?)
    case autoReview(
        evaluatedSecurity: ExecSecurity,
        policySnapshot: ExecApprovalPolicySnapshot)
    case explicitOnce(
        evaluatedSecurity: ExecSecurity,
        policySnapshot: ExecApprovalPolicySnapshot)
    case explicitAlways(
        evaluatedSecurity: ExecSecurity,
        policySnapshot: ExecApprovalPolicySnapshot,
        grants: [ExecAllowlistUse])
}

struct ExecApprovalExecutionCommit: Sendable {
    let agentId: String?
    let command: String
    let authorization: ExecApprovalAuthorization
    let uses: [ExecAllowlistUse]

    static func build(
        context: ExecApprovalEvaluation,
        effectiveSecurity: ExecSecurity,
        approvalSource: ExecApprovalRequestSource?,
        explicitlyApproved: Bool,
        persistAllowlist: Bool,
        delayedPolicySnapshot: ExecApprovalPolicySnapshot? = nil) -> ExecApprovalExecutionCommit
    {
        let uses = effectiveSecurity == .allowlist &&
            context.authorizationBasis == .allowlistEntries
            ? self.allowlistUses(context: context)
            : []
        let grants = persistAllowlist ? self.allowAlwaysGrants(context: context) : []
        let basis = effectiveSecurity == .allowlist ? context.authorizationBasis : nil
        // Forwarded decisions were evaluated before the Mac rebuilt its context.
        // Local prompt decisions have no override and bind to this evaluation.
        let policySnapshot = delayedPolicySnapshot ?? context.policySnapshot
        let authorization: ExecApprovalAuthorization = if approvalSource == .askFallback {
            .askFallback(evaluatedSecurity: effectiveSecurity, basis: basis)
        } else if approvalSource == .autoReview {
            .autoReview(
                evaluatedSecurity: effectiveSecurity,
                policySnapshot: policySnapshot)
        } else if explicitlyApproved {
            if grants.isEmpty {
                .explicitOnce(
                    evaluatedSecurity: effectiveSecurity,
                    policySnapshot: policySnapshot)
            } else {
                .explicitAlways(
                    evaluatedSecurity: effectiveSecurity,
                    policySnapshot: policySnapshot,
                    grants: grants)
            }
        } else {
            .currentPolicy(
                evaluatedSecurity: effectiveSecurity,
                evaluatedAsk: context.ask,
                basis: basis)
        }
        return ExecApprovalExecutionCommit(
            agentId: context.agentId,
            command: context.displayCommand,
            authorization: authorization,
            uses: uses)
    }

    private static func allowlistUses(context: ExecApprovalEvaluation) -> [ExecAllowlistUse] {
        var seenEntries = Set<ExecAllowlistEntryMatchKey>()
        var uses: [ExecAllowlistUse] = []
        for (idx, match) in context.allowlistMatches.enumerated() {
            if !seenEntries.insert(ExecApprovalsStore.allowlistEntryMatchKey(match)).inserted {
                continue
            }
            let resolvedPath = idx < context.allowlistResolutions.count
                ? context.allowlistResolutions[idx].resolvedRealPath ??
                context.allowlistResolutions[idx].resolvedPath
                : nil
            uses.append(ExecAllowlistUse(match: match, resolvedPath: resolvedPath))
        }
        return uses
    }

    private static func allowAlwaysGrants(context: ExecApprovalEvaluation) -> [ExecAllowlistUse] {
        guard context.canPersistAllowAlways else { return [] }
        let resolvedPath = context.allowlistResolutions.first?.resolvedRealPath ??
            context.allowlistResolutions.first?.resolvedPath
        var seenPatterns = Set<String>()
        return context.allowAlwaysPatterns.compactMap { pattern in
            guard seenPatterns.insert(pattern).inserted else { return nil }
            return ExecAllowlistUse(
                match: ExecAllowlistEntry(pattern: pattern, source: "allow-always"),
                resolvedPath: resolvedPath)
        }
    }
}

enum ExecApprovalEvaluator {
    static func evaluate(
        command: [String],
        rawCommand: String?,
        displayCommand: String? = nil,
        cwd: String?,
        envOverrides: [String: String]?,
        agentId: String?) async -> ExecApprovalEvaluation
    {
        let trimmedAgent = agentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAgentId = (trimmedAgent?.isEmpty == false) ? trimmedAgent : nil
        let approvals = ExecApprovalsStore.resolve(agentId: normalizedAgentId)
        let security = approvals.agent.security
        let ask = approvals.agent.ask
        let shellWrapper = ExecShellWrapperParser.extract(command: command, rawCommand: rawCommand).isWrapper
        let env = HostEnvSanitizer.sanitize(overrides: envOverrides, shellWrapper: shellWrapper)
        let effectiveDisplayCommand = displayCommand ??
            ExecCommandFormatter.displayString(for: command, rawCommand: rawCommand)
        let allowlistRawCommand = ExecSystemRunCommandValidator.allowlistEvaluationRawCommand(
            command: command,
            rawCommand: rawCommand)
        let allowlistResolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: allowlistRawCommand,
            cwd: cwd,
            env: env)
        let allowAlwaysPatterns = ExecCommandResolution.resolveAllowAlwaysPatterns(
            command: command,
            cwd: cwd,
            env: env,
            rawCommand: allowlistRawCommand)
        let boundCommand = ExecCommandResolution.bindForAllowlistExecution(
            command: command,
            rawCommand: allowlistRawCommand,
            resolutions: allowlistResolutions)
        let allowlistMatches = ExecAllowlistMatcher.matchAll(
            entries: approvals.allowlist,
            resolutions: allowlistResolutions)
        // Reusable trust must be executable as the same canonical path we
        // matched. Unbindable shell plans are misses so on-miss can still ask.
        let allowlistAuthorizationSatisfied =
            boundCommand != nil &&
            !allowlistResolutions.isEmpty &&
            allowlistMatches.count == allowlistResolutions.count
        let allowlistSatisfied = security == .allowlist && allowlistAuthorizationSatisfied

        let skillAllow: Bool
        if approvals.agent.autoAllowSkills, !allowlistResolutions.isEmpty {
            let bins = await SkillBinsCache.shared.currentTrust()
            skillAllow = boundCommand != nil &&
                self.isSkillAutoAllowed(allowlistResolutions, trustedBinsByName: bins)
        } else {
            skillAllow = false
        }

        return ExecApprovalEvaluation(
            displayCommand: effectiveDisplayCommand,
            agentId: normalizedAgentId,
            security: security,
            ask: ask,
            askFallback: approvals.agent.askFallback,
            env: env,
            resolution: allowlistResolutions.first,
            allowlistResolutions: allowlistResolutions,
            boundCommand: boundCommand,
            allowAlwaysPatterns: allowAlwaysPatterns,
            allowlistMatches: allowlistMatches,
            allowlistAuthorizationSatisfied: allowlistAuthorizationSatisfied,
            allowlistSatisfied: allowlistSatisfied,
            allowlistMatch: allowlistSatisfied ? allowlistMatches.first : nil,
            skillAllow: skillAllow,
            policySnapshot: ExecApprovalPolicySnapshot(resolved: approvals))
    }

    static func isSkillAutoAllowed(
        _ resolutions: [ExecCommandResolution],
        trustedBinsByName: [String: Set<String>]) -> Bool
    {
        guard !resolutions.isEmpty, !trustedBinsByName.isEmpty else { return false }
        return resolutions.allSatisfy { resolution in
            guard !ExecApprovalHelpers.patternHasPathSelector(resolution.rawExecutable) else { return false }
            guard !ExecCommandResolution.isUnsafeReusableExecutionTarget(resolution) else { return false }
            guard let executableName = SkillBinsCache.normalizeSkillBinName(resolution.executableName),
                  let resolvedPath = SkillBinsCache.normalizeResolvedPath(
                      resolution.resolvedRealPath ?? resolution.resolvedPath)
            else {
                return false
            }
            return trustedBinsByName[executableName]?.contains(resolvedPath) == true
        }
    }

    static func _testIsSkillAutoAllowed(
        _ resolutions: [ExecCommandResolution],
        trustedBinsByName: [String: Set<String>]) -> Bool
    {
        self.isSkillAutoAllowed(resolutions, trustedBinsByName: trustedBinsByName)
    }
}
