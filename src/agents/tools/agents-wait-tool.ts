import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { resolveSubagentCompletionResultText } from "../subagent-completion-result.js";
import { onSubagentRegistryPersisted } from "../subagent-registry-state.js";
import { getSubagentRunsByRunIds } from "../subagent-registry.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import { resolveSwarmConfig } from "../swarm-config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const MAX_WAIT_IDS = 1_000;

const AgentsWaitToolSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WAIT_IDS }),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

type WaitError = { runId: string; error: "not_found" | "not_owner" };
type WaitTarget = { runId: string; entry: SubagentRunRecord };

function ownsRun(entry: SubagentRunRecord, currentSessionKeys: ReadonlySet<string>): boolean {
  const owner = entry.swarmRequesterSessionKey?.trim();
  if (!owner) {
    return false;
  }
  const authorizedSessionKeys =
    entry.swarmWaitOwnerSessionKeys && entry.swarmWaitOwnerSessionKeys.length > 0
      ? entry.swarmWaitOwnerSessionKeys
      : [owner];
  return authorizedSessionKeys.some((sessionKey) => currentSessionKeys.has(sessionKey));
}

function completionResult(entry: SubagentRunRecord) {
  const completion = entry.collectorCompletion;
  if (!completion) {
    return undefined;
  }
  return {
    runId: entry.swarmRunId ?? entry.runId,
    status: completion.status,
    result: resolveSubagentCompletionResultText(entry) ?? "",
    ...(completion.structured !== undefined ? { structured: completion.structured } : {}),
    ...(completion.schemaError ? { schemaError: completion.schemaError } : {}),
    sessionKey: entry.childSessionKey,
    ...(entry.label ? { label: entry.label } : {}),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
}

export type CollectorCompletionResult = NonNullable<ReturnType<typeof completionResult>>;

/** Park one host bridge until its collector completes; registry writes wake it without polling. */
export async function waitForCollectorCompletion(params: {
  runId: string;
  currentSessionKeys: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<CollectorCompletionResult> {
  const readCompletion = (): CollectorCompletionResult | undefined => {
    const state = readWaitState([params.runId], params.currentSessionKeys);
    const error = state.errors?.[0];
    if (error) {
      throw new ToolInputError(`agents.run ${error.error}: ${error.runId}`);
    }
    return state.completed[0];
  };
  const immediate = readCompletion();
  if (immediate) {
    return immediate;
  }
  if (params.signal?.aborted) {
    throw new ToolInputError("agents.run wait aborted.");
  }
  return await new Promise<CollectorCompletionResult>((resolve, reject) => {
    let settled = false;
    const finish = (result: CollectorCompletionResult | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      params.signal?.removeEventListener("abort", onAbort);
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const check = () => {
      try {
        const completion = readCompletion();
        if (completion) {
          finish(completion);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onAbort = () => finish(new ToolInputError("agents.run wait aborted."));
    const unsubscribe = onSubagentRegistryPersisted(check);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    // Close the read/subscribe race if completion persisted between both operations.
    if (params.signal?.aborted) {
      onAbort();
    } else {
      check();
    }
  });
}

function resolveWaitTargets(ids: readonly string[], currentSessionKeys: ReadonlySet<string>) {
  const targets: WaitTarget[] = [];
  const errors: WaitError[] = [];
  const snapshot = getSubagentRunsByRunIds(ids);
  for (const runId of ids) {
    const entry = snapshot.entries.get(runId);
    if (!entry?.collect) {
      errors.push({ runId, error: "not_found" });
    } else if (!ownsRun(entry, currentSessionKeys)) {
      errors.push({ runId, error: "not_owner" });
    } else {
      targets.push({ runId, entry });
    }
  }
  return { targets, errors };
}

function readResolvedWaitState(targets: readonly WaitTarget[], errors: readonly WaitError[]) {
  const completed: Array<{
    result: NonNullable<ReturnType<typeof completionResult>>;
    completedAt: number;
    inputIndex: number;
  }> = [];
  const pending: string[] = [];
  for (const [inputIndex, { runId, entry }] of targets.entries()) {
    const result = completionResult(entry);
    if (result) {
      completed.push({
        result,
        completedAt:
          entry.completion?.capturedAt ?? entry.execution.endedAt ?? Number.MAX_SAFE_INTEGER,
        inputIndex,
      });
    } else {
      pending.push(runId);
    }
  }
  completed.sort(
    (left, right) => left.completedAt - right.completedAt || left.inputIndex - right.inputIndex,
  );
  return {
    completed: completed.map((entry) => entry.result),
    pending,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function readWaitState(ids: readonly string[], currentSessionKeys: ReadonlySet<string>) {
  const resolved = resolveWaitTargets(ids, currentSessionKeys);
  return readResolvedWaitState(resolved.targets, resolved.errors);
}

async function waitForCollector(params: {
  ids: readonly string[];
  currentSessionKeys: ReadonlySet<string>;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  const deadline = Date.now() + params.timeoutMs;
  for (;;) {
    if (params.signal?.aborted) {
      throw createAbortError("agents_wait aborted.");
    }
    // Recovery can replace a registry row while preserving its stable swarm id.
    // Re-resolve ownership and completion on every poll instead of retaining old objects.
    const state = readWaitState(params.ids, params.currentSessionKeys);
    if (state.completed.length > 0 || state.pending.length === 0 || Date.now() >= deadline) {
      return state;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const onAbort = () => finish(createAbortError("agents_wait aborted."));
      const timer = setTimeout(finish, Math.min(25, Math.max(0, deadline - Date.now())));
      params.signal?.addEventListener("abort", onAbort, { once: true });
      // Abort can race listener registration; never turn that cancellation into a successful poll.
      if (params.signal?.aborted) {
        onAbort();
      }
    });
  }
}

export function createAgentsWaitTool(opts: {
  agentSessionKey?: string;
  runSessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  const swarm = resolveSwarmConfig(opts.config, opts.agentId);
  return {
    label: "Wait for Agents",
    name: "agents_wait",
    displaySummary: "Wait for collector children.",
    description:
      "Wait for collector subagents started by sessions_spawn collect=true. Accepts many run ids; returns once any completes (completed results incl. structured output, plus pending ids), or on timeoutSeconds.",
    parameters: AgentsWaitToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as { ids: string[]; timeoutSeconds?: number };
      if (params.ids.length > MAX_WAIT_IDS) {
        throw new ToolInputError(`agents_wait supports at most ${MAX_WAIT_IDS} ids.`);
      }
      const ids = [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))];
      if (ids.length === 0) {
        throw new ToolInputError("agents_wait requires at least one non-empty run id.");
      }
      const currentSessionKeys = new Set(
        [opts.runSessionKey, opts.agentSessionKey].filter((key): key is string =>
          Boolean(key?.trim()),
        ),
      );
      const requestedTimeout =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? params.timeoutSeconds
          : 30;
      const timeoutSeconds = Math.min(Math.max(0, requestedTimeout), swarm.waitTimeoutSecondsMax);
      const result = await waitForCollector({
        ids,
        currentSessionKeys,
        timeoutMs: timeoutSeconds * 1_000,
        signal,
      });
      const noAuthorizedTargets =
        result.completed.length === 0 &&
        result.pending.length === 0 &&
        Boolean(result.errors?.length);
      return jsonResult(noAuthorizedTargets ? { ...result, success: false } : result);
    },
  };
}

const testing = {
  ownsRun,
  readResolvedWaitState,
  readWaitState,
  resolveWaitTargets,
  waitForCollector,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.agentsWaitToolTestApi")] = {
    testing,
  };
}
