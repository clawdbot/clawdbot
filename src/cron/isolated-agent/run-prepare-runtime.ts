/** Lazy preparation runtimes and session lifecycle helpers for cron runs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { HEARTBEAT_TOKEN } from "../../auto-reply/tokens.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
} from "../types.js";
import type { MutableCronSession } from "./run-session-state.js";
import { logWarn } from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";

export type RunCronAgentTurnParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  onLaneWait?: (info?: { waiting?: boolean }) => void;
  sessionKey: string;
  agentId?: string;
  lane?: string;
};

export function resolveCronAgentTurnMessage(input: RunCronAgentTurnParams): string {
  if (input.job.payload.kind === "agentTurn") {
    return input.job.payload.message;
  }
  return input.message;
}

export type WithRunSession = (
  result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
) => RunCronAgentTurnResult;

const sessionAccessorRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/session-accessor.js"),
);
const cronExternalContentRuntimeLoader = createLazyImportLoader(
  () => import("./run-external-content.runtime.js"),
);
const cronAuthProfileRuntimeLoader = createLazyImportLoader(
  () => import("./run-auth-profile.runtime.js"),
);
const cronModelPreflightRuntimeLoader = createLazyImportLoader(
  () => import("./model-preflight.runtime.js"),
);
const runtimePluginsLoader = createLazyImportLoader(
  () => import("../../plugins/runtime-plugins.runtime.js"),
);

export async function loadSessionAccessorRuntime() {
  return await sessionAccessorRuntimeLoader.load();
}

export async function loadCronExternalContentRuntime() {
  return await cronExternalContentRuntimeLoader.load();
}

export async function loadCronAuthProfileRuntime() {
  return await cronAuthProfileRuntimeLoader.load();
}

export async function loadCronModelPreflightRuntime() {
  return await cronModelPreflightRuntimeLoader.load();
}

export async function loadRuntimePlugins() {
  return await runtimePluginsLoader.load();
}

export function hasConfiguredAuthProfiles(cfg: OpenClawConfig): boolean {
  return (
    Boolean(cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) ||
    Boolean(cfg.auth?.order && Object.keys(cfg.auth.order).length > 0)
  );
}

export async function retireRolledCronSessionMcpRuntime(params: {
  job: CronJob;
  cronSession: MutableCronSession;
}) {
  if (params.job.sessionTarget === "isolated") {
    return;
  }
  const previousSessionId = normalizeOptionalString(params.cronSession.previousSessionId);
  const currentSessionId = normalizeOptionalString(params.cronSession.sessionEntry.sessionId);
  if (!previousSessionId || previousSessionId === currentSessionId) {
    return;
  }
  await retireSessionMcpRuntime({
    sessionId: previousSessionId,
    reason: "cron-session-rollover",
    onError: (error, sessionId) => {
      logWarn(
        `[cron:${params.job.id}] Failed to dispose retired bundle MCP runtime for session ${sessionId}: ${String(error)}`,
      );
    },
  });
}

export function appendCronUnattendedRunPreamble(
  commandBody: string,
  opts: { externalHook: boolean },
) {
  const core = `This is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have. Your final reply is the deliverable — not a plan, an acknowledgement, or a request for input. If nothing needs doing, reply exactly ${HEARTBEAT_TOKEN}. If something failed, state plainly what failed and what you tried — the scheduler owns retries and failure alerts.`;
  const trustedExtra =
    " Where the job's own instructions conflict with this preamble, the job's instructions win (a question or plan the job explicitly requests is a valid deliverable). If this job is no longer needed, you may remove it with the automations tool.";
  return `${commandBody}\n\n${core}${opts.externalHook ? "" : trustedExtra}`;
}
