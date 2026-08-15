// Resolves per-agent runtime limits from config.
import os from "node:os";
import type { OpenClawConfig } from "./types.js";

const MIN_AGENT_MAX_CONCURRENT = 8;
const MAX_AGENT_MAX_CONCURRENT = 16;
let defaultAgentMaxConcurrent: number | undefined;

function resolveDefaultAgentMaxConcurrent(): number {
  if (defaultAgentMaxConcurrent === undefined) {
    // Prefer the quota-aware count on modern Node; retain the CPU-list fallback
    // for runtimes where availableParallelism is absent.
    const availableParallelism =
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    defaultAgentMaxConcurrent = Math.min(
      MAX_AGENT_MAX_CONCURRENT,
      Math.max(MIN_AGENT_MAX_CONCURRENT, availableParallelism),
    );
  }
  return defaultAgentMaxConcurrent;
}

/** Default maximum concurrent child-agent runs across subagent execution. */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
/** Default maximum direct children a single agent run may spawn. */
export const DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT = 5;
/** Default age before completed subagent state is archived. */
export const DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES = 60;
// Keep depth-1 subagents as leaves unless config explicitly opts into nesting.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;

/** Resolves top-level agent concurrency, flooring finite values and clamping to at least one. */
export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return resolveDefaultAgentMaxConcurrent();
}

/** Resolves subagent concurrency, flooring finite values and clamping to at least one. */
export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}
