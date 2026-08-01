import type { SubagentRunRecord } from "../subagent-registry.types.js";
import "./agents-wait-tool.js";

type WaitError = { runId: string; error: "not_found" | "not_owner" };
type WaitTarget = { runId: string; entry: SubagentRunRecord };
type AgentsWaitToolTestApi = {
  testing: {
    ownsRun(entry: SubagentRunRecord, currentSessionKeys: ReadonlySet<string>): boolean;
    readResolvedWaitState(targets: readonly WaitTarget[], errors: readonly WaitError[]): unknown;
    readWaitState(ids: readonly string[], currentSessionKeys: ReadonlySet<string>): unknown;
    resolveWaitTargets(
      ids: readonly string[],
      currentSessionKeys: ReadonlySet<string>,
    ): { targets: WaitTarget[]; errors: WaitError[] };
    waitForCollector(params: {
      ids: readonly string[];
      currentSessionKeys: ReadonlySet<string>;
      timeoutMs: number;
      signal?: AbortSignal;
    }): Promise<unknown>;
  };
};

function getTestApi(): AgentsWaitToolTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.agentsWaitToolTestApi")
  ] as AgentsWaitToolTestApi;
}

export const testing = getTestApi().testing;
