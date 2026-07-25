import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { sha256HexPrefix } from "./crypto-digest.js";
// Owns durable approval matching and allow-always persistence.
import { canonicalizeExecApprovalPolicyRules } from "./exec-approval-policy-snapshot.js";
import type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
import { resolveAllowAlwaysPatternEntries } from "./exec-approvals-allowlist.js";
import type { ExecCommandSegment } from "./exec-approvals-analysis.js";
import type {
  AllowAlwaysPersistenceDecision,
  AllowAlwaysPersistenceReason,
} from "./exec-approvals-contracts.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import { resolveExecApprovalsFromFileInternal } from "./exec-approvals-resolver.js";
import { replaceExecApprovalsSnapshot, updateExecApprovalsSync } from "./exec-approvals-store.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import type { ExecAuthorizationPlan } from "./exec-authorization-plan.js";
import {
  extractBindableShellWrapperInlineCommand,
  isShellWrapperInvocation,
} from "./exec-wrapper-resolution.js";
import {
  hasPosixInteractiveStartupBeforeInlineCommand,
  hasPosixLoginStartupBeforeInlineCommand,
  POSIX_INLINE_COMMAND_FLAGS,
} from "./shell-inline-command.js";

export function hasDurableExecApproval(params: {
  analysisOk: boolean;
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  return (
    hasExactCommandDurableExecApproval({
      allowlist: params.allowlist,
      commandText: params.commandText,
    }) ||
    hasSegmentDurableExecApproval({
      analysisOk: params.analysisOk,
      segmentAllowlistEntries: params.segmentAllowlistEntries,
    })
  );
}

// Digest input is the trimmed command text only. Shipped approvals files
// already hold `=command:` entries in this format; changing the input
// silently orphans every persisted exact-command grant.
function buildDurableCommandApprovalPattern(commandText: string): string {
  return `=command:${sha256HexPrefix(commandText, 16)}`;
}

function buildNodeCommandApprovalPattern(commandText: string): string {
  return `=node-command:${sha256HexPrefix(commandText, 16)}`;
}

export function hasNodeCommandAllowAlwaysMarker(params: {
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  const normalizedCommand = params.commandText?.trim();
  if (!normalizedCommand) {
    return false;
  }
  const commandPattern = buildNodeCommandApprovalPattern(normalizedCommand);
  return (params.allowlist ?? []).some(
    (entry) => entry.source === "allow-always" && entry.pattern === commandPattern,
  );
}

export function hasExactCommandDurableExecApproval(params: {
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  const normalizedCommand = params.commandText?.trim();
  if (!normalizedCommand) {
    return false;
  }
  const commandPattern = buildDurableCommandApprovalPattern(normalizedCommand);
  return (params.allowlist ?? []).some(
    (entry) =>
      entry.source === "allow-always" &&
      (entry.pattern === commandPattern ||
        (typeof entry.commandText === "string" && entry.commandText.trim() === normalizedCommand)),
  );
}

type DurableExecApprovalRequirement = "exact-command" | "segment-allowlist";

/** Callers pass whether their final, post-gate authorization depends on a durable grant. */
export function resolveDurableExecApprovalRequirement(params: {
  durableApprovalRequired: boolean;
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): DurableExecApprovalRequirement | null {
  if (!params.durableApprovalRequired) {
    return null;
  }
  return hasExactCommandDurableExecApproval({
    allowlist: params.allowlist,
    commandText: params.commandText,
  })
    ? "exact-command"
    : "segment-allowlist";
}

function hasSegmentDurableExecApproval(params: {
  analysisOk: boolean;
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
}): boolean {
  return (
    params.analysisOk &&
    params.segmentAllowlistEntries.length > 0 &&
    params.segmentAllowlistEntries.every((entry) => entry?.source === "allow-always")
  );
}

export function buildAllowlistEntryMatchKey(
  entry: Pick<ExecAllowlistEntry, "pattern" | "argPattern">,
): string {
  return JSON.stringify([entry.pattern, entry.argPattern ?? null]);
}

function buildExecApprovalPolicyRuleKey(
  entry: Pick<ExecAllowlistEntry, "pattern" | "argPattern" | "source">,
): string {
  // A JSON tuple preserves exact regex bytes without delimiter collisions.
  return JSON.stringify([entry.pattern, entry.argPattern ?? null, entry.source ?? null]);
}

function buildAllowAlwaysUpgradeRuleKey(
  rule: Pick<ExecAllowlistEntry, "pattern" | "argPattern" | "source">,
): string | null {
  if (rule.source !== undefined) {
    return null;
  }
  return buildExecApprovalPolicyRuleKey({ ...rule, source: "allow-always" });
}

/** Captures effective file policy while excluding ids and mutable usage metadata. */
export function createExecApprovalPolicySnapshot(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
}): ExecApprovalPolicySnapshot {
  // Runtime overrides are deliberately absent: the snapshot protects the
  // persisted policy that may change while a human approval is pending.
  const resolved = resolveExecApprovalsFromFileInternal({
    file: params.file,
    agentId: params.agentId,
  });
  const allowlistRulesByKey = new Map(
    resolved.allowlist.map((entry) => {
      const rule = {
        pattern: entry.pattern,
        ...(entry.argPattern !== undefined ? { argPattern: entry.argPattern } : {}),
        ...(entry.source === "allow-always" ? { source: entry.source } : {}),
      };
      return [buildExecApprovalPolicyRuleKey(rule), rule] as const;
    }),
  );
  return {
    security: resolved.agent.security,
    ask: resolved.agent.ask,
    askFallback: resolved.agent.askFallback,
    autoAllowSkills: resolved.agent.autoAllowSkills,
    allowlistRules: canonicalizeExecApprovalPolicyRules([...allowlistRulesByKey.values()]),
  };
}

export function isExecApprovalPolicySnapshotCurrent(
  expected: ExecApprovalPolicySnapshot,
  current: ExecApprovalPolicySnapshot,
): boolean {
  const currentRuleKeys = new Set(current.allowlistRules.map(buildExecApprovalPolicyRuleKey));
  return (
    expected.security === current.security &&
    expected.ask === current.ask &&
    expected.askFallback === current.askFallback &&
    expected.autoAllowSkills === current.autoAllowSkills &&
    // Concurrent operator-approved grants are additive. Preserve them while
    // accepting an in-place allow-always upgrade of the same rule. Revocations
    // and reverse source downgrades still remove an expected authority.
    expected.allowlistRules.every((rule) => {
      const key = buildExecApprovalPolicyRuleKey(rule);
      if (currentRuleKeys.has(key)) {
        return true;
      }
      const upgradedKey = buildAllowAlwaysUpgradeRuleKey(rule);
      return upgradedKey !== null && currentRuleKeys.has(upgradedKey);
    })
  );
}

function applyAllowlistEntryUpdate(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  pattern: string;
  options?: {
    argPattern?: string;
    source?: ExecAllowlistEntry["source"];
  };
}): ExecApprovalsFile | null {
  const target = params.agentId ?? DEFAULT_AGENT_ID;
  const agents = params.file.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
  const trimmed = params.pattern.trim();
  if (!trimmed) {
    return null;
  }
  const argPattern = params.options?.argPattern === "" ? undefined : params.options?.argPattern;
  const existingEntry = allowlist.find(
    (entry) => entry.pattern === trimmed && (entry.argPattern ?? undefined) === argPattern,
  );
  if (
    existingEntry &&
    (!params.options?.source || existingEntry.source === params.options.source)
  ) {
    return null;
  }
  const now = Date.now();
  const nextAllowlist = existingEntry
    ? allowlist.map((entry) =>
        entry.pattern === trimmed && (entry.argPattern ?? undefined) === argPattern
          ? {
              ...entry,
              argPattern,
              source: params.options?.source ?? entry.source,
              lastUsedAt: now,
            }
          : entry,
      )
    : [
        ...allowlist,
        {
          id: crypto.randomUUID(),
          pattern: trimmed,
          argPattern,
          source: params.options?.source,
          lastUsedAt: now,
        },
      ];
  return {
    ...params.file,
    agents: { ...agents, [target]: { ...existing, allowlist: nextAllowlist } },
  };
}

export function addAllowlistEntry(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  pattern: string,
  options?: {
    argPattern?: string;
    source?: ExecAllowlistEntry["source"];
  },
): void {
  const snapshot = updateExecApprovalsSync({
    update: (file) =>
      applyAllowlistEntryUpdate({
        file,
        agentId,
        pattern,
        options,
      }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(approvals, snapshot.file);
  }
}

export function addDurableCommandApproval(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  commandText: string,
): void {
  const normalized = commandText.trim();
  if (!normalized) {
    return;
  }
  addAllowlistEntry(approvals, agentId, buildDurableCommandApprovalPattern(normalized), {
    source: "allow-always",
  });
}

export function resolveAllowAlwaysPatternCoverage(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): {
  complete: boolean;
  patterns: ReturnType<typeof resolveAllowAlwaysPatternEntries>;
} {
  const byKey = new Map<string, ReturnType<typeof resolveAllowAlwaysPatternEntries>[number]>();
  let representedSegmentCount = 0;
  for (const segment of params.segments) {
    if (isShellWrapperInvocation(segment.argv)) {
      const segmentPatterns = resolveAllowAlwaysPatternEntries({
        segments: [segment],
        cwd: params.cwd,
        env: params.env,
        platform: params.platform,
        strictInlineEval: params.strictInlineEval,
      });
      for (const pattern of segmentPatterns) {
        byKey.set(`${pattern.pattern}\x00${pattern.argPattern ?? ""}`, pattern);
      }
      continue;
    }
    const segmentPatterns = resolveAllowAlwaysPatternEntries({
      segments: [segment],
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
    });
    if (segmentPatterns.length === 0) {
      continue;
    }
    representedSegmentCount += 1;
    for (const pattern of segmentPatterns) {
      byKey.set(`${pattern.pattern}\x00${pattern.argPattern ?? ""}`, pattern);
    }
  }
  return {
    complete: params.segments.length > 0 && representedSegmentCount === params.segments.length,
    patterns: [...byKey.values()],
  };
}

export function persistAllowAlwaysPatterns(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  commandText?: string;
  strictInlineEval?: boolean;
}): ReturnType<typeof resolveAllowAlwaysPatternEntries> {
  const coverage = resolveAllowAlwaysPatternCoverage(params);
  const commandText = params.commandText?.trim();
  persistAllowAlwaysDecision({
    approvals: params.approvals,
    agentId: params.agentId,
    decision: {
      kind: "patterns",
      patterns: coverage.patterns,
      ...(commandText && coverage.complete && coverage.patterns.length > 0 ? { commandText } : {}),
    },
  });
  return coverage.patterns;
}

function hasRuntimeShellPayload(argv: readonly string[]): boolean {
  const inlineCommand = extractBindableShellWrapperInlineCommand([...argv]);
  return Boolean(
    inlineCommand &&
    (/(?:\$[A-Za-z0-9_@*?#$!-]|\$\{|`|\$\()/u.test(inlineCommand) ||
      hasPosixInteractiveStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS) ||
      hasPosixLoginStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS)),
  );
}

function resolvePlanPersistenceState(plan: ExecAuthorizationPlan | undefined): {
  reusablePatternsAllowed: boolean;
  reasons: AllowAlwaysPersistenceReason[];
} {
  if (!plan) {
    return { reusablePatternsAllowed: true, reasons: [] };
  }
  if (!plan.ok) {
    return { reusablePatternsAllowed: false, reasons: ["unplanned"] };
  }
  const reasons = new Set<AllowAlwaysPersistenceReason>();
  let reusablePatternsAllowed = true;
  const candidates = plan.groups.flatMap((group) => group.candidates);
  for (const candidate of candidates) {
    if (candidate.trustMode === "prompt-only") {
      reasons.add("prompt-only");
    }
    if (candidate.trustMode === "exact-command") {
      // Durable `=command:` entries are command-text-only and cannot bind
      // cwd, env, or PATH, so planner exact-command candidates stay one-shot.
      reasons.add("no-reusable-pattern");
    }
    if (candidate.trustMode === "executable" && !candidate.allowAlways) {
      reasons.add("no-reusable-pattern");
    }
    reusablePatternsAllowed = reusablePatternsAllowed && candidate.allowAlways;
    if (hasRuntimeShellPayload(candidate.sourceSegment.argv)) {
      reasons.add("runtime-payload");
    }
    if (
      candidate.transport.kind === "shell-wrapper" &&
      hasRuntimeShellPayload(candidate.transport.wrapperArgv)
    ) {
      reasons.add("runtime-payload");
    }
  }
  return {
    reusablePatternsAllowed,
    reasons: [...reasons],
  };
}

export function resolveAllowAlwaysPersistenceDecision(params: {
  segments: ExecCommandSegment[];
  commandText?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
  authorizationPlan?: ExecAuthorizationPlan;
  runtimePayload?: boolean;
  preparedCoverage?: ReturnType<typeof resolveAllowAlwaysPatternCoverage> | null;
}): AllowAlwaysPersistenceDecision {
  const planPersistence = resolvePlanPersistenceState(params.authorizationPlan);
  const reasons = new Set<AllowAlwaysPersistenceReason>(planPersistence.reasons);
  if (params.runtimePayload === true) {
    reasons.add("runtime-payload");
  }
  const commandText = params.commandText?.trim();
  const hardReasons = [...reasons].filter((reason) => reason !== "no-reusable-pattern");
  if (hardReasons.length > 0) {
    return { kind: "one-shot", reasons: hardReasons };
  }

  if (params.preparedCoverage?.complete === true && params.preparedCoverage.patterns.length > 0) {
    return {
      kind: "patterns",
      patterns: params.preparedCoverage.patterns,
      ...(commandText ? { commandText } : {}),
    };
  }

  if (planPersistence.reusablePatternsAllowed) {
    const coverage = resolveAllowAlwaysPatternCoverage({
      segments: params.segments,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
    });
    if (coverage.patterns.length > 0) {
      return {
        kind: "patterns",
        patterns: coverage.patterns,
        ...(commandText && coverage.complete ? { commandText } : {}),
      };
    }
  }

  reasons.add("no-reusable-pattern");
  return { kind: "one-shot", reasons: [...reasons] };
}

export function persistAllowAlwaysDecision(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  decision: AllowAlwaysPersistenceDecision;
}): void {
  const decision = params.decision;
  if (decision.kind === "one-shot") {
    return;
  }
  const snapshot = updateExecApprovalsSync({
    update: (file) =>
      applyAllowAlwaysDecision({
        file,
        agentId: params.agentId,
        decision,
      }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(params.approvals, snapshot.file);
  }
}

export function applyAllowAlwaysDecision(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  decision: Exclude<AllowAlwaysPersistenceDecision, { kind: "one-shot" }>;
}): ExecApprovalsFile | null {
  const entries: Array<{
    pattern: string;
    argPattern?: string;
    source: "allow-always";
  }> =
    params.decision.kind === "exact-command"
      ? params.decision.commandText.trim()
        ? [
            {
              pattern: buildDurableCommandApprovalPattern(params.decision.commandText.trim()),
              source: "allow-always" as const,
            },
          ]
        : []
      : [
          ...params.decision.patterns.map((pattern) => ({
            pattern: pattern.pattern,
            argPattern: pattern.argPattern,
            source: "allow-always" as const,
          })),
          ...(params.decision.commandText?.trim()
            ? [
                {
                  pattern: buildNodeCommandApprovalPattern(params.decision.commandText.trim()),
                  source: "allow-always" as const,
                },
              ]
            : []),
        ];
  let next = params.file;
  let changed = false;
  for (const entry of entries) {
    const updated = applyAllowlistEntryUpdate({
      file: next,
      agentId: params.agentId,
      pattern: entry.pattern,
      options: { argPattern: entry.argPattern, source: entry.source },
    });
    if (updated) {
      next = updated;
      changed = true;
    }
  }
  return changed ? next : null;
}
