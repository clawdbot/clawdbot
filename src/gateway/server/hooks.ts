import { randomUUID } from "node:crypto";
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
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { type HookAgentDispatchPayload, type HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "./hooks-request-handler.js";

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

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey, trusted: false });
    if (value.mode === "now") {
      requestHeartbeat({ source: "hook", intent: "immediate", reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = value.sessionKey;
    const safeName = sanitizeInboundSystemTags(value.name);
    const jobId = randomUUID();
    const runId = randomUUID();
    const now = Date.now();
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
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
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
      state: { nextRunAtMs: now },
    };

    let hookEventSessionKey: string | undefined;
    void (async () => {
      try {
        const cfg = getRuntimeConfig();
        hookEventSessionKey = resolveHookEventSessionKey({
          cfg,
          agentId: value.agentId,
        });
        const { runCronIsolatedAgentTurn } = await import("../../cron/isolated-agent.js");
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
        });
        const summary =
          normalizeOptionalString(result.summary) ||
          normalizeOptionalString(result.error) ||
          result.status;
        const prefix =
          result.status === "ok" ? `Hook ${safeName}` : `Hook ${safeName} (${result.status})`;
        const shouldAnnounce = shouldAnnounceHookRunResult({ deliver: value.deliver, result });
        if (shouldAnnounce) {
          const eventSessionKey = hookEventSessionKey ?? resolveMainSessionKeyFromConfig();
          enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
            sessionKey: eventSessionKey,
            trusted: false,
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
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${safeName} (error): ${String(err)}`, {
          sessionKey: hookEventSessionKey ?? resolveMainSessionKeyFromConfig(),
          trusted: false,
        });
        if (value.wakeMode === "now") {
          requestHeartbeat({
            source: "hook",
            intent: "immediate",
            reason: `hook:${jobId}:error`,
          });
        }
      }
    })();

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
