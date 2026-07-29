import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  PluginHookSkillEvaluationFinding,
  PluginHookSkillProposalEvaluateResult,
  PluginHookSkillProposalEvaluationOutcome,
} from "../../plugins/hook-types.js";
import {
  createSkillProposalEvent,
  dispatchSkillProposalChanged,
  hasSkillProposalEvaluators,
  normalizeSkillProposalCorrelationId,
  runSkillProposalEvaluators,
} from "./plugin-hooks.js";
import { buildSkillProposalEvaluationBundles } from "./proposal-bundle.js";
import { readRequiredProposal } from "./service-query.js";
import {
  hashSkillProposalContent,
  readProposalSupportFiles,
  readSkillProposalEvents,
  recordSkillProposalEvaluation,
  withSkillProposalTargetLock,
} from "./store.js";
import type {
  SkillProposalEvaluateInput,
  SkillProposalEvaluateResult,
  SkillProposalEventsListInput,
  SkillProposalEventsListResult,
} from "./types.js";

const MAX_EVALUATION_OUTCOMES = 64;
const MAX_EVALUATION_FINDINGS = 200;
const MAX_EVALUATION_METRICS = 64;

export async function evaluateSkillProposal(
  input: SkillProposalEvaluateInput,
): Promise<SkillProposalEvaluateResult> {
  const correlationId = normalizeSkillProposalCorrelationId(input.correlationId);
  const shouldRunEvaluators = hasSkillProposalEvaluators();
  const initial = await readRequiredProposal(
    input.proposalId,
    input.workspaceDir,
    input.env,
    input.agentId,
  );
  const snapshot = await withSkillProposalTargetLock(
    initial.record,
    async () => {
      const read = await readRequiredProposal(
        input.proposalId,
        input.workspaceDir,
        input.env,
        input.agentId,
      );
      if (read.record.status !== "pending") {
        throw new Error(
          `Only pending proposals can be evaluated. Current status: ${read.record.status}.`,
        );
      }
      assertExpectedRevisionHash(read.revisionHash, input.expectedRevisionHash);
      if (hashSkillProposalContent(read.content) !== read.record.draftHash) {
        throw new Error("Proposal draft changed without updating proposal metadata.");
      }
      const supportFiles = await readProposalSupportFiles(read.record, storeOptions(input.env));
      return {
        read,
        bundles: shouldRunEvaluators
          ? await buildSkillProposalEvaluationBundles({
              proposal: read,
              supportFiles,
            })
          : undefined,
      };
    },
    storeOptions(input.env),
  );
  const { read, bundles } = snapshot;
  const startedAt = new Date().toISOString();
  const rawOutcomes = bundles
    ? await runSkillProposalEvaluators(
        {
          proposal: {
            id: read.record.id,
            kind: read.record.kind,
            revision: read.record.proposedVersion,
            revisionSha256: read.revisionHash,
            ...(read.record.target.currentContentHash
              ? { targetCurrentSha256: read.record.target.currentContentHash }
              : {}),
          },
          skill: {
            name: read.record.target.skillName,
            skillKey: read.record.target.skillKey,
            description: read.record.description,
            ...(read.record.target.source ? { source: read.record.target.source } : {}),
          },
          candidate: bundles.candidate,
          ...(bundles.baseline ? { baseline: bundles.baseline } : {}),
          reason: input.trigger === "apply" ? "apply" : "manual",
        },
        {
          workspaceDir: input.workspaceDir,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        },
      )
    : [];
  const completedAt = new Date().toISOString();
  const evaluation = {
    id: randomUUID(),
    proposedVersion: read.record.proposedVersion,
    revisionHash: read.revisionHash,
    trigger: input.trigger ?? ("manual" as const),
    startedAt,
    completedAt,
    ...(correlationId ? { correlationId } : {}),
    outcomes: normalizeEvaluationOutcomes(rawOutcomes),
  };
  const pendingRecord = { ...read.record, evaluation };
  const eventInput = createSkillProposalEvent({
    record: pendingRecord,
    type: "evaluation_completed",
    actor: input.agentId ? { type: "agent", id: input.agentId } : { type: "gateway" },
    ...(correlationId ? { correlationId } : {}),
    occurredAt: completedAt,
    payload: {
      evaluationId: evaluation.id,
      trigger: evaluation.trigger,
      outcomeCount: evaluation.outcomes.length,
    },
  });
  const stored = await withSkillProposalTargetLock(
    read.record,
    async () => {
      const current = await readRequiredProposal(
        input.proposalId,
        input.workspaceDir,
        input.env,
        input.agentId,
      );
      if (
        current.record.status !== "pending" ||
        current.record.proposedVersion !== read.record.proposedVersion ||
        current.revisionHash !== read.revisionHash ||
        hashSkillProposalContent(current.content) !== current.record.draftHash
      ) {
        throw new Error(`Skill proposal ${read.record.id} changed while evaluation was running.`);
      }
      try {
        await readProposalSupportFiles(current.record, storeOptions(input.env));
      } catch {
        throw new Error(`Skill proposal ${read.record.id} changed while evaluation was running.`);
      }
      return recordSkillProposalEvaluation({
        proposalId: read.record.id,
        expectedProposedVersion: read.record.proposedVersion,
        expectedRevisionHash: read.revisionHash,
        evaluation,
        event: eventInput,
        store: storeOptions(input.env),
      });
    },
    storeOptions(input.env),
  );
  await dispatchSkillProposalChanged({
    event: stored.event,
    record: stored.record,
    workspaceDir: input.workspaceDir,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    evaluations: evaluation.outcomes,
  });
  return { record: stored.record, evaluation };
}

export function listSkillProposalEvents(
  input: SkillProposalEventsListInput,
): SkillProposalEventsListResult {
  return readSkillProposalEvents(input, storeOptions(input.env));
}

export function assertExpectedRevisionHash(actual: string, expected?: string): void {
  const normalized = normalizeOptionalString(expected);
  if (normalized && normalized !== actual) {
    throw new Error(
      `Skill proposal revision changed (expected ${normalized}, current ${actual}); reload and retry.`,
    );
  }
}

function normalizeEvaluationOutcomes(
  outcomes: readonly PluginHookSkillProposalEvaluationOutcome[],
): PluginHookSkillProposalEvaluationOutcome[] {
  if (outcomes.length > MAX_EVALUATION_OUTCOMES) {
    throw new Error(
      `Skill proposal evaluation returned more than ${MAX_EVALUATION_OUTCOMES} outcomes.`,
    );
  }
  return outcomes.map((outcome) => {
    const evaluatorId = boundedRequired(outcome.evaluatorId, 128, outcome.pluginId);
    const pluginId = boundedRequired(outcome.pluginId, 128, "unknown-plugin");
    const attribution = {
      evaluatorId,
      pluginId,
      ...(outcome.pluginVersion
        ? { pluginVersion: boundedRequired(outcome.pluginVersion, 128, "unknown") }
        : {}),
    };
    if (outcome.status === "skipped") {
      return { ...attribution, status: "skipped" };
    }
    if (outcome.status === "error") {
      return {
        ...attribution,
        status: "error",
        error: boundedRequired(outcome.error, 2_000, "Evaluator failed."),
      };
    }
    const result = normalizeEvaluationResult(outcome.result);
    return result
      ? { ...attribution, status: "completed", result }
      : {
          ...attribution,
          status: "error",
          error: "Evaluator returned an invalid result.",
        };
  });
}

function normalizeEvaluationResult(
  result: PluginHookSkillProposalEvaluateResult,
): PluginHookSkillProposalEvaluateResult | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const findings = normalizeFindings(result.findings);
  const metrics = normalizeMetrics(result.metrics);
  if (result.findings !== undefined && !findings) {
    return null;
  }
  if (result.metrics !== undefined && !metrics) {
    return null;
  }
  if (result.decision !== undefined && !["pass", "revise", "block"].includes(result.decision)) {
    return null;
  }
  return {
    ...(result.summary ? { summary: boundedRequired(result.summary, 8_000, "") } : {}),
    ...(findings ? { findings } : {}),
    ...(metrics ? { metrics } : {}),
    ...(result.evaluatorVersion
      ? { evaluatorVersion: boundedRequired(result.evaluatorVersion, 128, "") }
      : {}),
    ...(result.mode ? { mode: boundedRequired(result.mode, 128, "") } : {}),
    ...(result.decision ? { decision: result.decision } : {}),
    ...(result.decisionReason
      ? { decisionReason: boundedRequired(result.decisionReason, 2_000, "") }
      : {}),
  };
}

function normalizeFindings(
  findings: PluginHookSkillEvaluationFinding[] | undefined,
): PluginHookSkillEvaluationFinding[] | undefined {
  if (findings === undefined) {
    return undefined;
  }
  if (!Array.isArray(findings) || findings.length > MAX_EVALUATION_FINDINGS) {
    return undefined;
  }
  const normalized: PluginHookSkillEvaluationFinding[] = [];
  for (const finding of findings) {
    if (
      !finding ||
      typeof finding !== "object" ||
      !["info", "warn", "critical"].includes(finding.severity) ||
      !finding.ruleId ||
      !finding.message ||
      (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || finding.line < 1))
    ) {
      return undefined;
    }
    normalized.push({
      ruleId: boundedRequired(finding.ruleId, 256, "unknown"),
      severity: finding.severity,
      message: boundedRequired(finding.message, 4_000, "Invalid finding."),
      ...(finding.file ? { file: boundedRequired(finding.file, 1_024, "") } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
    });
  }
  return normalized;
}

function normalizeMetrics(
  metrics: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (metrics === undefined) {
    return undefined;
  }
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    return undefined;
  }
  const entries = Object.entries(metrics);
  if (entries.length > MAX_EVALUATION_METRICS) {
    return undefined;
  }
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (
      !key ||
      key.length > 128 ||
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      return undefined;
    }
    normalized[key] = typeof value === "string" ? value.slice(0, 4_000) : value;
  }
  return normalized;
}

function boundedRequired(value: string, maxLength: number, fallback: string): string {
  const normalized = normalizeOptionalString(value) ?? fallback;
  return normalized.slice(0, maxLength);
}

function storeOptions(env?: NodeJS.ProcessEnv) {
  return env ? { env } : {};
}
