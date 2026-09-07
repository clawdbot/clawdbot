import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { SkillTelemetrySource } from "../types.js";

const MAX_TRACKED_SKILL_USAGE_RUNS = 1024;

export type RunSkillUsage = Readonly<{
  name: string;
  source: SkillTelemetrySource;
  activation: "command" | "read";
  skillFile?: string;
}>;

const skillUsageByRun = new Map<string, Map<string, RunSkillUsage>>();
type RunSkillUsageInstance = Readonly<{ instanceId: string; runId: string }>;
const workspaceSkillUsageByAuthority = new WeakMap<
  AgentRunDelegatedAuthority,
  Map<string, RunSkillUsage>
>();

function runSkillUsageKey(usage: RunSkillUsage): string {
  return `${usage.source}\u0000${usage.name}\u0000${usage.activation}`;
}

/** Records the skills the foreground run demonstrably invoked or read. */
export function recordRunSkillUsage(
  params: RunSkillUsage & {
    runId?: string;
    operationalRunInstance?: RunSkillUsageInstance;
  },
): void {
  const runId = params.runId ?? params.operationalRunInstance?.runId;
  if (!runId) {
    return;
  }
  const usage = skillUsageByRun.get(runId) ?? new Map<string, RunSkillUsage>();
  const record = {
    name: params.name,
    source: params.source,
    activation: params.activation,
    ...(params.skillFile ? { skillFile: params.skillFile } : {}),
  };
  usage.set(runSkillUsageKey(record), record);
  skillUsageByRun.set(runId, usage);
  pruneMapToMaxSize(skillUsageByRun, MAX_TRACKED_SKILL_USAGE_RUNS);

  const operationalRunInstance = params.operationalRunInstance;
  const delegatedAuthority = operationalRunInstance
    ? getActiveAgentRunDelegatedAuthority(operationalRunInstance)
    : undefined;
  if (
    record.source !== "workspace" ||
    !record.skillFile ||
    !operationalRunInstance ||
    operationalRunInstance.runId !== runId ||
    !delegatedAuthority
  ) {
    return;
  }
  const authorityUsage = workspaceSkillUsageByAuthority.get(delegatedAuthority) ?? new Map();
  if (!authorityUsage.has(record.skillFile)) {
    authorityUsage.set(record.skillFile, record);
  }
  workspaceSkillUsageByAuthority.set(delegatedAuthority, authorityUsage);
}

/** Binds one used workspace skill to the exact delegated authority that admitted it. */
export function bindWorkspaceSkillUsage(params: {
  operationalRunInstance: RunSkillUsageInstance | undefined;
  skillFile: string;
}): (() => boolean) | undefined {
  const operationalRunInstance = params.operationalRunInstance;
  const delegatedAuthority = operationalRunInstance
    ? getActiveAgentRunDelegatedAuthority(operationalRunInstance)
    : undefined;
  if (!delegatedAuthority) {
    return undefined;
  }
  const usage = workspaceSkillUsageByAuthority.get(delegatedAuthority)?.get(params.skillFile);
  if (!usage) {
    return undefined;
  }
  return () =>
    getActiveAgentRunDelegatedAuthority(delegatedAuthority.operationalRunInstance) ===
      delegatedAuthority &&
    validateAgentRunDelegatedAuthority(delegatedAuthority) &&
    workspaceSkillUsageByAuthority.get(delegatedAuthority)?.get(params.skillFile) === usage;
}

/** Transfers one completed run's usage receipt to its terminal side effects. */
export function consumeRunSkillUsage(runId: string | undefined): RunSkillUsage[] {
  if (!runId) {
    return [];
  }
  const usage = skillUsageByRun.get(runId);
  discardRunSkillUsage(runId);
  return usage ? [...usage.values()] : [];
}

/** Revokes any usage receipts that remain when the logical run settles. */
export function discardRunSkillUsage(runId: string | undefined): void {
  if (runId) {
    skillUsageByRun.delete(runId);
  }
}

/** Revokes only the repair receipts owned by one exact admitted execution. */
export function discardRunWorkspaceSkillUsage(
  operationalRunInstance: RunSkillUsageInstance | undefined,
): void {
  const delegatedAuthority = operationalRunInstance
    ? getActiveAgentRunDelegatedAuthority(operationalRunInstance)
    : undefined;
  if (delegatedAuthority) {
    workspaceSkillUsageByAuthority.delete(delegatedAuthority);
  }
}

/** Revokes both telemetry and exact-authority receipts for one execution. */
export function discardRunSkillUsageForOperationalRun(
  operationalRunInstance: RunSkillUsageInstance,
): void {
  discardRunSkillUsage(operationalRunInstance.runId);
  discardRunWorkspaceSkillUsage(operationalRunInstance);
}
