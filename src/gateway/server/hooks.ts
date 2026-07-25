// Gateway hook server wiring translates external hook requests into wake events or isolated agent runs.
import { randomUUID } from "node:crypto";
import {
  resolveDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { sanitizeInboundSystemTags } from "../../auto-reply/reply/inbound-text.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { getRuntimeConfig } from "../../config/io.js";
import {
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveMainSessionKeyFromConfig,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import { resolveCronAgentSessionKey } from "../../cron/isolated-agent/session-key.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "./hooks-request-handler.js";

/**
 * Gateway hook HTTP handler factory.
 *
 * Hooks can either enqueue wake events or spawn isolated agent turns; both paths
 * sanitize external input before it reaches logs or system-event text.
 */
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

function resolveHookEventSessionKey(params: { cfg: OpenClawConfig; agentId?: string }): string {
  return params.agentId
    ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId })
    : resolveMainSessionKey(params.cfg);
}

function shouldAnnounceHookRunResult(params: {
  deliver: boolean;
  result: RunCronAgentTurnResult;
}): boolean {
  if (params.result.status !== "ok") {
    return true;
  }
  return (
    params.deliver && params.result.delivered !== true && params.result.deliveryAttempted !== true
  );
}

function resolveHookRunSummary(result: RunCronAgentTurnResult): string {
  const diagnosticsSummary =
    result.status !== "ok" ? normalizeOptionalString(result.diagnostics?.summary) : undefined;
  return (
    diagnosticsSummary ||
    normalizeOptionalString(result.summary) ||
    normalizeOptionalString(result.error) ||
    result.status
  );
}

function sanitizeHookConsoleValue(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const withoutControlChars = Array.from(normalized, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("");
  return truncateUtf16Safe(withoutControlChars.replace(/\s+/gu, " ").trim(), 500);
}

function formatHookRunWarningConsoleMessage(params: {
  status: string;
  model: string | undefined;
  summary: string;
}): string {
  const parts = [
    "hook agent run returned non-ok status",
    `status=${sanitizeHookConsoleValue(params.status) ?? "unknown"}`,
  ];
  const model = sanitizeHookConsoleValue(params.model);
  if (model) {
    parts.push(`model=${model}`);
  }
  const summary = sanitizeHookConsoleValue(params.summary);
  if (summary) {
    parts.push(`summary=${summary}`);
  }
  return parts.join(" ");
}

function createSessionKeyedHookDispatchQueue() {
  const hookAgentDispatchTails = new Map<string, Promise<void>>();

  return (sessionKey: string, operation: () => Promise<void>) => {
    const previousTail = hookAgentDispatchTails.get(sessionKey);
    const run = previousTail ? previousTail.catch(() => undefined).then(operation) : operation();
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    hookAgentDispatchTails.set(sessionKey, tail);
    // Same-session hook agent runs append to one agent session. Serializing avoids
    // optimistic lifecycle-claim races while preserving parallelism across sessions.
    void tail.finally(() => {
      if (hookAgentDispatchTails.get(sessionKey) === tail) {
        hookAgentDispatchTails.delete(sessionKey);
      }
    });
    return run;
  };
}

/** Creates the HTTP handler used by gateway hook endpoints. */
export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;
  const enqueueHookAgentDispatch = createSessionKeyedHookDispatchQueue();
  let isolatedAgentModulePromise:
    | Promise<typeof import("../../cron/isolated-agent.js")>
    | undefined;
  const loadIsolatedAgentModule = () =>
    (isolatedAgentModulePromise ??= import("../../cron/isolated-agent.js"));

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, {
      sessionKey,
    });
    if (value.mode === "now") {
      requestHeartbeat({ source: "hook", intent: "immediate", reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = value.sessionKey;
    const safeName = sanitizeInboundSystemTags(value.name);
    const jobId = randomUUID();
    const runId = randomUUID();
    const nowMs = resolveDateTimestampMs(Date.now());
    const delivery = value.deliver
      ? {
          mode: "announce" as const,
          channel: value.channel,
          to: value.to,
        }
      : { mode: "none" as const };
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: safeName,
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "at", at: resolveTimestampMsToIsoString(nowMs) },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        externalContentSource: value.externalContentSource,
      },
      delivery,
      state: { nextRunAtMs: nowMs },
    };
    let hookEventSessionKey: string | undefined;
    const reportHookFailure = (err: unknown) => {
      logHooks.warn(`hook agent failed: ${String(err)}`);
      enqueueSystemEvent(`Hook ${safeName} (error): ${String(err)}`, {
        sessionKey: hookEventSessionKey ?? resolveMainSessionKeyFromConfig(),
      });
      if (value.wakeMode === "now") {
        requestHeartbeat({
          source: "hook",
          intent: "immediate",
          reason: `hook:${jobId}:error`,
        });
      }
    };
    let dispatchCfg: OpenClawConfig;
    try {
      dispatchCfg = getRuntimeConfig();
    } catch (err) {
      // Config resolution historically failed after the hook response returned.
      // Preserve that detached failure contract while queue keys stay canonical.
      void runWithGatewayIndependentRootWorkContinuation(async () => reportHookFailure(err));
      return runId;
    }
    const agentId = value.agentId ?? resolveDefaultAgentId(dispatchCfg);
    const queueKey = resolveCronAgentSessionKey({
      sessionKey,
      agentId,
      mainKey: dispatchCfg.session?.mainKey,
      cfg: dispatchCfg,
    });
    // Queue identity is fixed when accepted; the isolated runner still receives
    // the original session expression and fresh config, preserving hook routing.
    void runWithGatewayIndependentRootWorkContinuation(() =>
      enqueueHookAgentDispatch(queueKey, async () => {
        try {
          // Agent hooks run after the HTTP response path has returned, so failure
          // handling must record a system event instead of throwing to the caller.
          const cfg = getRuntimeConfig();
          // Keep an omitted agent omitted for event routing so global session scope
          // stays global; runner identity is frozen separately via accepted agentId.
          hookEventSessionKey = resolveHookEventSessionKey({
            cfg,
            agentId: value.agentId,
          });
          const { runCronIsolatedAgentTurn } = await loadIsolatedAgentModule();
          const result = await runCronIsolatedAgentTurn({
            cfg,
            deps,
            job,
            message: value.message,
            sessionKey,
            // Isolated runs derive their lifecycle key from random jobId (or an
            // already-stable cron: key), so accepted agentId closes reload drift.
            agentId,
            lane: "cron",
          });
          const summary = resolveHookRunSummary(result);
          const prefix =
            result.status === "ok" ? `Hook ${safeName}` : `Hook ${safeName} (${result.status})`;
          const shouldAnnounce = shouldAnnounceHookRunResult({ deliver: value.deliver, result });
          if (result.status !== "ok") {
            logHooks.warn("hook agent run returned non-ok status", {
              sourcePath: value.sourcePath,
              name: safeName,
              runId,
              jobId,
              agentId: value.agentId,
              sessionKey,
              status: result.status,
              model: value.model,
              summary,
              consoleMessage: formatHookRunWarningConsoleMessage({
                status: result.status,
                model: value.model,
                summary,
              }),
            });
          }
          if (shouldAnnounce) {
            const eventSessionKey = hookEventSessionKey ?? resolveMainSessionKeyFromConfig();
            enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
              sessionKey: eventSessionKey,
            });
            if (value.wakeMode === "now") {
              requestHeartbeat({ source: "hook", intent: "immediate", reason: `hook:${jobId}` });
            }
          } else if (result.status === "ok" && !value.deliver) {
            logHooks.info("hook agent run completed without announcement", {
              sourcePath: value.sourcePath,
              name: safeName,
              runId,
              jobId,
              agentId: value.agentId,
              sessionKey,
              completedAt: new Date().toISOString(),
            });
          }
        } catch (err) {
          reportHookFailure(err);
        }
      }),
    );

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
