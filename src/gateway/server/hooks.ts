// Gateway hook server wiring translates external hook requests into wake events or isolated agent runs.
import { randomUUID } from "node:crypto";
import {
  resolveDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { getRuntimeConfig } from "../../config/io.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveMainSessionKeyFromConfig,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  CronAgentAdmissionDisposition,
  RunCronAgentTurnResult,
} from "../../cron/isolated-agent/run.types.js";
import { resolveCronAgentSessionKey } from "../../cron/isolated-agent/session-key.js";
import type { CronJob } from "../../cron/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { validateExplicitMessageAccountSelection } from "../../infra/outbound/message-account-selection.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "../hooks.js";
import {
  createHooksRequestHandler,
  type HookAgentDispatchResult,
  type HookClientIpConfig,
} from "./hooks-request-handler.js";

/**
 * Gateway hook HTTP handler factory.
 *
 * Hooks can either enqueue wake events or spawn isolated agent turns.
 */
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AGENT_START_ADMISSION_TIMEOUT_MS = 15_000;
const HOOK_AGENT_START_ADMISSION_TIMEOUT_ERROR =
  "hook agent run did not start before admission timeout";
const HOOK_AGENT_SESSION_CONFLICT_ERROR =
  "hook agent run was rejected because the target session changed";
const HOOK_AGENT_PREPARATION_ERROR = "hook agent run failed before entering the agent runner";

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

function createHookAdmissionFailure(params: {
  runId: string;
  disposition?: CronAgentAdmissionDisposition;
  statusCode?: 409 | 502 | 503;
}): HookAgentDispatchResult {
  const statusCode = params.statusCode ?? (params.disposition === "session-conflict" ? 409 : 502);
  return {
    ok: false,
    statusCode,
    error:
      statusCode === 409
        ? HOOK_AGENT_SESSION_CONFLICT_ERROR
        : statusCode === 503
          ? HOOK_AGENT_START_ADMISSION_TIMEOUT_ERROR
          : HOOK_AGENT_PREPARATION_ERROR,
    runId: params.runId,
  };
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

function validateHookAgentDeliveryAccount(params: {
  cfg: OpenClawConfig;
  value: HookAgentDispatchPayload;
}): HookAgentDispatchPayload {
  // Mapped hooks can defer partial/last targets to cron and cannot select an account.
  // Bind only direct hook announces whose destination is already complete.
  if (
    params.value.delivery.mode !== "announce" ||
    params.value.delivery.channel === "last" ||
    !params.value.delivery.to
  ) {
    return params.value;
  }
  const accountId = params.value.delivery.accountId
    ? validateExplicitMessageAccountSelection({
        cfg: params.cfg,
        channel: params.value.delivery.channel,
        accountId: params.value.delivery.accountId,
      })
    : (() => {
        const plugin = resolveOutboundChannelPlugin({
          channel: params.value.delivery.channel,
          cfg: params.cfg,
        });
        if (!plugin) {
          throw new Error(`Channel ${params.value.delivery.channel} is unavailable.`);
        }
        return resolveChannelDefaultAccountId({ plugin, cfg: params.cfg });
      })();
  if (!accountId) {
    throw new Error(`Channel ${params.value.delivery.channel} did not resolve an account.`);
  }
  return {
    ...params.value,
    accountId,
    delivery: { ...params.value.delivery, accountId },
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
  agentStartAdmissionTimeoutMs?: number;
}) {
  const {
    deps,
    getHooksConfig,
    getClientIpConfig,
    bindHost,
    port,
    logHooks,
    agentStartAdmissionTimeoutMs = HOOK_AGENT_START_ADMISSION_TIMEOUT_MS,
  } = params;
  const enqueueHookAgentDispatch = createSessionKeyedHookDispatchQueue();
  let isolatedAgentModulePromise:
    | Promise<typeof import("../../cron/isolated-agent.js")>
    | undefined;
  const loadIsolatedAgentModule = () =>
    (isolatedAgentModulePromise ??= import("../../cron/isolated-agent.js"));

  const dispatchWakeHook = (value: {
    text: string;
    mode: "now" | "next-heartbeat";
    agentId?: string;
    sessionKey?: string;
  }) => {
    const targeted = Boolean(value.agentId || value.sessionKey);
    // A targeted wake must enqueue and wake the same canonical store key;
    // otherwise the heartbeat runs for one agent while its event waits elsewhere.
    const target = targeted
      ? (() => {
          const cfg = getRuntimeConfig();
          const agentId = value.agentId ?? resolveDefaultAgentId(cfg);
          if (cfg.session?.scope === "global") {
            return {
              eventSessionKey: "global",
              heartbeatTarget: { agentId },
            };
          }
          const eventSessionKey = canonicalizeMainSessionAlias({
            cfg,
            agentId,
            sessionKey: value.sessionKey
              ? toAgentStoreSessionKey({
                  agentId,
                  requestKey: value.sessionKey,
                  mainKey: cfg.session?.mainKey,
                })
              : resolveAgentMainSessionKey({ cfg, agentId }),
          });
          return {
            eventSessionKey,
            heartbeatTarget: { agentId, sessionKey: eventSessionKey },
          };
        })()
      : undefined;
    const sessionKey = target?.eventSessionKey ?? resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, {
      sessionKey,
    });
    if (value.mode === "now") {
      requestHeartbeat({
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        ...target?.heartbeatTarget,
      });
    }
  };

  const dispatchAgentHook = async (
    value: HookAgentDispatchPayload,
  ): Promise<HookAgentDispatchResult> => {
    const sessionKey = value.sessionKey;
    // A hook name is a single-line label: it lands in logs, in cron job `name` fields,
    // and inside prompt-bound system-event text. Reuse the console sanitizer so control
    // characters and line breaks cannot reshape any of those surfaces.
    const safeName = sanitizeHookConsoleValue(value.name) ?? "Hook";
    const jobId = randomUUID();
    const runId = randomUUID();
    const nowMs = resolveDateTimestampMs(Date.now());
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: safeName,
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "at", at: resolveTimestampMsToIsoString(nowMs) },
      sessionTarget: value.sessionMode === "persistent" ? `session:${sessionKey}` : "isolated",
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
      delivery: value.delivery,
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
      void runWithGatewayIndependentRootWorkContinuation(async () => reportHookFailure(err));
      return createHookAdmissionFailure({ runId });
    }
    let acceptedValue: HookAgentDispatchPayload;
    try {
      acceptedValue = validateHookAgentDeliveryAccount({ cfg: dispatchCfg, value });
      job.delivery = acceptedValue.delivery;
    } catch (err) {
      return {
        ok: false,
        statusCode: 400,
        error: formatErrorMessage(err),
        runId,
      };
    }
    const agentId = acceptedValue.agentId ?? resolveDefaultAgentId(dispatchCfg);
    const queueKey = resolveCronAgentSessionKey({
      sessionKey,
      agentId,
      mainKey: dispatchCfg.session?.mainKey,
      cfg: dispatchCfg,
    });
    let settleAdmission!: (result: HookAgentDispatchResult) => void;
    let admissionSettled = false;
    let admissionTimedOut = false;
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    const admission = new Promise<HookAgentDispatchResult>((resolve) => {
      settleAdmission = (result) => {
        if (admissionSettled) {
          return;
        }
        admissionSettled = true;
        if (admissionTimer) {
          clearTimeout(admissionTimer);
          admissionTimer = undefined;
        }
        resolve(result);
      };
    });
    const admissionTimeoutError = new Error(HOOK_AGENT_START_ADMISSION_TIMEOUT_ERROR);
    const startupAbortController = new AbortController();
    admissionTimer = setTimeout(() => {
      admissionTimedOut = true;
      startupAbortController.abort(admissionTimeoutError);
      settleAdmission(
        createHookAdmissionFailure({
          runId,
          statusCode: 503,
        }),
      );
    }, agentStartAdmissionTimeoutMs);
    admissionTimer.unref?.();

    // Queue identity is fixed when accepted; the isolated runner still receives
    // the original session expression and fresh config, preserving hook routing.
    void runWithGatewayIndependentRootWorkContinuation(() =>
      enqueueHookAgentDispatch(queueKey, async () => {
        // The admission deadline starts before this same-session queue. Expired
        // work must never enter cron preparation after an HTTP 503 was returned.
        if (startupAbortController.signal.aborted) {
          return;
        }
        try {
          const cfg = getRuntimeConfig();
          try {
            validateHookAgentDeliveryAccount({ cfg, value: acceptedValue });
          } catch (err) {
            settleAdmission({
              ok: false,
              statusCode: 400,
              error: formatErrorMessage(err),
              runId,
            });
            return;
          }
          // Keep an omitted agent omitted for event routing so global session scope
          // stays global; runner identity is frozen separately via accepted agentId.
          hookEventSessionKey = resolveHookEventSessionKey({
            cfg,
            agentId: acceptedValue.agentId,
          });
          const { runCronIsolatedAgentTurn } = await loadIsolatedAgentModule();
          // Lazy module loading is the last Gateway-owned async boundary before
          // cron preparation, so recheck the deadline after it settles.
          if (startupAbortController.signal.aborted) {
            return;
          }
          const result = await runCronIsolatedAgentTurn({
            cfg,
            deps,
            job,
            message: acceptedValue.message,
            sessionKey,
            // Isolated runs derive their lifecycle key from random jobId (or an
            // already-stable cron: key), so accepted agentId closes reload drift.
            agentId,
            lane: "cron",
            abortSignal: startupAbortController.signal,
            onExecutionStarted: () => {
              // Existing runner-entry callbacks are the final owner-boundary fence:
              // a deadline that wins this race prevents the runner call itself.
              startupAbortController.signal.throwIfAborted();
              settleAdmission({ ok: true, runId });
            },
          });
          if (admissionTimedOut) {
            return;
          }
          const summary = resolveHookRunSummary(result);
          if (!admissionSettled) {
            settleAdmission(
              result.status === "ok" || result.executionStarted === true
                ? { ok: true, runId }
                : createHookAdmissionFailure({
                    runId,
                    disposition: result.admissionDisposition,
                  }),
            );
          }
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
          if (admissionTimedOut) {
            return;
          }
          settleAdmission(createHookAdmissionFailure({ runId }));
          reportHookFailure(err);
        }
      }),
    ).catch((err: unknown) => {
      if (admissionTimedOut) {
        return;
      }
      settleAdmission(createHookAdmissionFailure({ runId }));
      reportHookFailure(err);
    });

    return await admission;
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
