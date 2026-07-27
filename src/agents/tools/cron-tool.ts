/**
 * cron built-in tool.
 *
 * Manages scheduled jobs, wake/run actions, delivery context, and reminder-style payload normalization.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { getRuntimeConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveCronCreationDelivery } from "../../cron/delivery-context.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import type { CronDelivery } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { recordCronNextCheckProposal } from "../../infra/agent-events.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { isRecord } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { CRON_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { normalizeToolName } from "../tool-policy.js";
import { setToolTerminalPresentation } from "../tool-terminal-presentation.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNonNegativeIntegerParam,
  readStringParam,
} from "./common.js";
import {
  canonicalizeCronToolObject,
  hasCronCreateSignal,
  isEmptyRecoveredCronPatch,
  recoverCronObjectFromFlatParams,
} from "./cron-tool-canonicalize.js";
import {
  buildReminderContextLines,
  REMINDER_CONTEXT_MARKER,
  stripExistingContext,
} from "./cron-tool-context.js";
import { capCronJobToolsAllowOnCreate } from "./cron-tool-creator-cap.js";
import { assertCronPacingInput, createCronToolSchema } from "./cron-tool-schema.js";
import { assertNoCronShellExecution, updateCronJobFromAgentTool } from "./cron-tool-write.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolCallerScope,
  CronToolDeps,
  CronToolOptions,
} from "./cron-tool.types.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

export type { CronCreatorToolAllowlistEntry } from "./cron-tool.types.js";

function isMissingOrEmptyObject(value: unknown): boolean {
  return !value || (isRecord(value) && Object.keys(value).length === 0);
}

export function replaceWithEffectiveCronCreatorToolAllowlist<T extends { name: string }>(
  target: CronCreatorToolAllowlistEntry[],
  tools: readonly T[],
  toolMeta?: (tool: T) => { pluginId?: string } | undefined,
): void {
  target.length = 0;
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = normalizeToolName(tool.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const meta = toolMeta?.(tool);
    const pluginId =
      typeof meta?.pluginId === "string" ? normalizeToolName(meta.pluginId) : undefined;
    target.push(pluginId ? { name, pluginId } : { name });
  }
}

function readCronJobIdParam(params: Record<string, unknown>) {
  return readStringParam(params, "jobId") ?? readStringParam(params, "id");
}

function resolveCronToolCallerScope(
  opts: CronToolOptions | undefined,
  cfg: OpenClawConfig,
): CronToolCallerScope | undefined {
  const sessionKey = opts?.agentSessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  return {
    kind: "agentTool",
    agentId: resolveSessionAgentId({ sessionKey, config: cfg }),
  };
}

function readCronToolAgentId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? normalizeAgentId(value) : undefined;
}

function readAgentIdFromCronToolSessionRef(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? parseAgentSessionKey(value.trim())?.agentId
    : undefined;
}

function readAgentIdFromCronToolSessionTarget(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("session:")) {
    return undefined;
  }
  return readAgentIdFromCronToolSessionRef(trimmed.slice("session:".length));
}

function assertCronToolAgentFieldMatchesScope(params: {
  value: unknown;
  field: string;
  callerScope: CronToolCallerScope;
}): void {
  if (params.value === undefined) {
    return;
  }
  const agentId = readCronToolAgentId(params.value);
  if (agentId && agentId === params.callerScope.agentId) {
    return;
  }
  throw new Error(`${params.field} must match the calling agent`);
}

function assertCronToolSessionRefsMatchScope(
  value: Record<string, unknown>,
  callerScope: CronToolCallerScope,
): void {
  const sessionAgentId = readAgentIdFromCronToolSessionRef(value.sessionKey);
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== callerScope.agentId) {
    throw new Error("cron sessionKey must match the calling agent");
  }
  const sessionTargetAgentId = readAgentIdFromCronToolSessionTarget(value.sessionTarget);
  if (sessionTargetAgentId && normalizeAgentId(sessionTargetAgentId) !== callerScope.agentId) {
    throw new Error("cron sessionTarget must match the calling agent");
  }
}

const CRON_SELF_REMOVE_SCOPE_ERROR = "Cron tool is restricted to the current cron job.";

function readCronSelfRemoveOnlyJobId(opts: CronToolOptions | undefined) {
  return opts?.selfRemoveOnlyJobId?.trim() || undefined;
}

function isCronSelfIntrospectionAction(action: string) {
  return action === "status" || action === "list";
}

function assertCronSelfRemoveScope(
  opts: CronToolOptions | undefined,
  action: string,
  params: Record<string, unknown>,
) {
  const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
  if (!selfRemoveOnlyJobId || isCronSelfIntrospectionAction(action)) {
    return;
  }
  if (action === "next_check") {
    const id = readCronJobIdParam(params);
    if (!id || id === selfRemoveOnlyJobId) {
      return;
    }
  }
  if (action === "get" || action === "remove" || action === "runs") {
    const id = readCronJobIdParam(params);
    if (id && id === selfRemoveOnlyJobId) {
      return;
    }
  }
  throw new Error(CRON_SELF_REMOVE_SCOPE_ERROR);
}

function filterCronDeliveryPreviewsByJobId(previews: unknown, jobId: string): unknown {
  if (!isRecord(previews)) {
    return previews;
  }
  if (!Object.hasOwn(previews, jobId)) {
    return {};
  }
  return { [jobId]: previews[jobId] };
}

function filterCronListResultToJobId(result: unknown, jobId: string): unknown {
  if (!isRecord(result) || !Array.isArray(result.jobs)) {
    return result;
  }
  const jobs = result.jobs.filter((job) => isRecord(job) && job.id === jobId);
  return {
    ...result,
    jobs,
    total: jobs.length,
    offset: 0,
    limit: jobs.length,
    hasMore: false,
    nextOffset: null,
    ...(Object.hasOwn(result, "deliveryPreviews")
      ? { deliveryPreviews: filterCronDeliveryPreviewsByJobId(result.deliveryPreviews, jobId) }
      : {}),
  };
}

function filterCronStatusResultForSelfScope(result: unknown): unknown {
  return { enabled: isRecord(result) && result.enabled === true };
}

function formatCronTerminalPresentation(
  params: unknown,
  result: unknown,
): { text: string } | undefined {
  if (!isRecord(params) || !isRecord(result) || !isRecord(result.details)) {
    return undefined;
  }
  switch (params.action) {
    case "status": {
      const enabled = result.details.enabled === true ? "yes" : "no";
      return { text: `Cron scheduler status.\nEnabled: ${enabled}` };
    }
    case "list": {
      const total =
        typeof result.details.total === "number" &&
        Number.isFinite(result.details.total) &&
        result.details.total >= 0
          ? Math.floor(result.details.total)
          : undefined;
      const count =
        total ?? (Array.isArray(result.details.jobs) ? result.details.jobs.length : undefined);
      return count === undefined
        ? { text: "Cron jobs listed." }
        : { text: `Cron jobs listed.\nCount: ${count}` };
    }
    case "get":
      return { text: "Cron job loaded." };
    case "runs": {
      const entries = Array.isArray(result.details.entries)
        ? result.details.entries.length
        : undefined;
      return entries === undefined
        ? { text: "Cron run history loaded." }
        : { text: `Cron run history loaded.\nCount: ${entries}` };
    }
    default:
      return undefined;
  }
}

function cronListResultHasJob(result: unknown, jobId: string): boolean {
  return (
    isRecord(result) &&
    Array.isArray(result.jobs) &&
    result.jobs.some((job) => isRecord(job) && job.id === jobId)
  );
}

function readCronListNextOffset(result: unknown, currentOffset: number): number | undefined {
  if (!isRecord(result) || result.hasMore !== true || typeof result.nextOffset !== "number") {
    return undefined;
  }
  const nextOffset = Math.floor(result.nextOffset);
  return Number.isFinite(nextOffset) && nextOffset > currentOffset ? nextOffset : undefined;
}

function isOlderGatewayWithoutCompactCronList(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("invalid cron.list params") &&
    error.message.includes("unexpected property 'compact'")
  );
}

export function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  const tool: AnyAgentTool = {
    label: "Cron",
    name: "cron",
    displaySummary: CRON_TOOL_DISPLAY_SUMMARY,
    description: `Gateway scheduler: reminders, delayed self-wakeups, loops, recurring work, event watchers. Never exec sleep/poll as timer.

ACTIONS: status | list [includeDisabled] | get jobId | add job | update jobId patch | remove jobId | run jobId (runMode "force"=now) | runs jobId = history | next_check in:"30m" (own paced run only) | wake text mode?:"now"|"next-heartbeat"(default) nudges a caller-owned lane (sessionKey/agentId to pick another).

ADD: {name?,schedule,payload,sessionTarget?,pacing?,trigger?,delivery?,enabled?}. Required: schedule+payload.

SCHEDULE:
- {kind:"at",at:"ISO-8601"} one-shot; no tz=UTC; auto-deletes after run.
- {kind:"every",everyMs}.
- {kind:"cron",expr,tz?:"IANA"}: expr is wall time in tz; never pre-convert to UTC; no tz=gateway host local. 18:00 Shanghai => {expr:"0 18 * * *",tz:"Asia/Shanghai"}.
- {kind:"stream",command:[argv],mode?:"line"|"match",match?}: fires on supervised process output; needs cron.triggers.enabled.

TARGET+PAYLOAD:
- "current" (agentTurn default) = this conversation: run carries this chat's context, result lands here. Self-wakeup/"continue later"/loop = at|every + agentTurn + current.
- "isolated" = fresh detached session (shows in \`openclaw tasks\`); standalone background work.
- "main" = heartbeat lane; payload {kind:"systemEvent",text} (systemEvent default target).
- "session:<key>" = named session.
- agentTurn {kind:"agentTurn",message,model?,thinking?,timeoutSeconds?}; timeoutSeconds 0=none.
- script {kind:"script",script,timeoutSeconds?,toolBudget?}: main|isolated only; needs cron.triggers.enabled.

PACED LOOP: recurring job + pacing{min?,max?} durations ("15m","4h"; at least one). Inside its run, job calls next_check in:"<dur>" to set the next delay (clamped to bounds, measured from run end; failed runs keep normal backoff). Adaptive polling: tighten when active, back off when quiet.

TRIGGER (condition watcher on every/cron): {script,once?}; needs cron.triggers.enabled — if off, say so; never model-poll instead. Quiet headless check, no model; 30s/5 tool calls/16KB state. Read frozen trigger.state, return json({fire,message?,state?}) with NEW state; dedupe via state, never memory. fire:false saves state only. fire:true runs payload; message is that run's entire context — self-contained. Fire on failures/timeouts too; success-only watchers look healthy when broken. Script stays read-only; actions belong in payload. once:true disables after first fire. Code Mode: await tools.call("exec",{command:"..."}).

DELIVERY {mode:"none"|"announce"|"webhook",channel?,to?,threadId?,bestEffort?}: where detached run output goes. Omitted=announce (current=>this chat; isolated=>last route; set channel/to for a specific chat — no messaging tool inside the run). Silent watcher=>mode:"none". webhook posts finished-run event to URL in \`to\`.

Job wakeMode (main jobs): "now"(default)|"next-heartbeat". Restricted cron-run sessions: self status/list/get/runs/remove + own next_check only. failureAlert {...}|false disables. jobId canonical (id=compat). contextMessages 0-10 embeds recent chat lines into reminder text.`,
    parameters: createCronToolSchema(),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      assertCronSelfRemoveScope(opts, action, params);
      const parsedGatewayOpts = readGatewayCallOptions(params);
      const gatewayOpts: GatewayCallOptions = {
        ...parsedGatewayOpts,
        timeoutMs: parsedGatewayOpts.timeoutMs ?? 60_000,
      };
      const runtimeConfig = getRuntimeConfig();
      const callerScope = resolveCronToolCallerScope(opts, runtimeConfig);
      const callerIdentity =
        callerScope && opts?.agentSessionKey?.trim()
          ? {
              agentId: callerScope.agentId,
              sessionKey: opts.agentSessionKey.trim(),
              turnSourceAccountId: opts.agentAccountId,
              ...(readCronSelfRemoveOnlyJobId(opts)
                ? { cronSelfManagementJobId: readCronSelfRemoveOnlyJobId(opts) }
                : {}),
            }
          : undefined;

      return await withGatewayToolCallerIdentity(callerIdentity, async () => {
        switch (action) {
          case "status": {
            const result = await callGateway("cron.status", gatewayOpts, {});
            return jsonResult(
              readCronSelfRemoveOnlyJobId(opts)
                ? filterCronStatusResultForSelfScope(result)
                : result,
            );
          }
          case "list": {
            const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
            const explicitAgentId = readCronToolAgentId(params.agentId);
            if (callerScope && explicitAgentId && explicitAgentId !== callerScope.agentId) {
              throw new Error("cron list agentId must match the calling agent");
            }
            const listAgentId = callerScope?.agentId ?? explicitAgentId;
            const includeDisabled = Boolean(params.includeDisabled);
            let offset = 0;
            let result: unknown;
            let shouldContinue = true;
            let useCompactList = true;
            while (shouldContinue) {
              try {
                result = await callGateway("cron.list", gatewayOpts, {
                  includeDisabled,
                  ...(useCompactList ? { compact: true } : {}),
                  ...(listAgentId ? { agentId: listAgentId } : {}),
                  ...(selfRemoveOnlyJobId ? { limit: 200, offset } : {}),
                });
              } catch (error) {
                if (!useCompactList || !isOlderGatewayWithoutCompactCronList(error)) {
                  throw error;
                }
                // Protocol v4 gateways predating compact reject the additive field.
                // Retry without it for mixed-version correctness; remove at the next protocol break.
                useCompactList = false;
                continue;
              }
              if (!selfRemoveOnlyJobId || cronListResultHasJob(result, selfRemoveOnlyJobId)) {
                shouldContinue = false;
              } else {
                const nextOffset = readCronListNextOffset(result, offset);
                if (nextOffset === undefined) {
                  shouldContinue = false;
                } else {
                  offset = nextOffset;
                }
              }
            }
            return jsonResult(
              selfRemoveOnlyJobId
                ? filterCronListResultToJobId(result, selfRemoveOnlyJobId)
                : result,
            );
          }
          case "get": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }
            return jsonResult(
              await callGateway("cron.get", gatewayOpts, {
                id,
              }),
            );
          }
          case "add": {
            // Flat-params recovery: non-frontier models (e.g. Grok) sometimes flatten
            // job properties to the top level alongside `action` instead of nesting
            // them inside `job`. When `params.job` is missing or empty, reconstruct
            // a synthetic job object from any recognised top-level job fields.
            // See: https://github.com/openclaw/openclaw/issues/11310
            if (isMissingOrEmptyObject(params.job)) {
              const synthetic = recoverCronObjectFromFlatParams(params);
              // Only use the synthetic job if at least one meaningful field is present
              // (schedule, payload, message, or text are the minimum signals that the
              // LLM intended to create a job).
              if (synthetic.found && hasCronCreateSignal(synthetic.value)) {
                params.job = synthetic.value;
              }
            }

            if (!params.job || typeof params.job !== "object") {
              throw new Error("job required");
            }
            const canonicalJob = canonicalizeCronToolObject(params.job as Record<string, unknown>);
            assertNoCronShellExecution(canonicalJob);
            assertCronDeliveryInputNonBlankFields(canonicalJob.delivery);
            assertCronPacingInput(canonicalJob.pacing, { nullableClears: false });
            if (
              typeof canonicalJob.declarationKey === "string" &&
              canonicalJob.declarationKey.trim().length === 0
            ) {
              throw new Error("declarationKey must be a non-empty string");
            }
            if (
              typeof canonicalJob.displayName === "string" &&
              canonicalJob.displayName.trim().length === 0
            ) {
              throw new Error("displayName must be a non-empty string");
            }
            const enabledExplicit = typeof canonicalJob.enabled === "boolean";
            const job =
              normalizeCronJobCreate(canonicalJob, {
                sessionContext: { sessionKey: opts?.agentSessionKey },
              }) ?? canonicalJob;
            if (
              typeof job.declarationKey === "string" &&
              job.declarationKey.length > 0 &&
              !enabledExplicit
            ) {
              delete job.enabled;
            }
            capCronJobToolsAllowOnCreate(job, opts?.creatorToolAllowlist);
            if (job && typeof job === "object") {
              const { mainKey, alias } = resolveMainSessionAlias(runtimeConfig);
              const resolvedSessionKey = opts?.agentSessionKey
                ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
                : undefined;
              if (callerScope) {
                assertCronToolAgentFieldMatchesScope({
                  value: (job as { agentId?: unknown }).agentId,
                  field: "cron job agentId",
                  callerScope,
                });
                (job as { agentId?: string }).agentId = callerScope.agentId;
                assertCronToolSessionRefsMatchScope(job as Record<string, unknown>, callerScope);
              }
              const sessionTarget = normalizeLowercaseStringOrEmpty(
                (job as { sessionTarget?: unknown }).sessionTarget,
              );
              if (!("sessionKey" in job) && resolvedSessionKey && sessionTarget !== "isolated") {
                (job as { sessionKey?: string }).sessionKey = resolvedSessionKey;
              }
            }

            if (
              (opts?.agentSessionKey || opts?.currentDeliveryContext) &&
              job &&
              typeof job === "object" &&
              "payload" in job &&
              (job as { payload?: { kind?: string } }).payload?.kind === "agentTurn"
            ) {
              const deliveryValue = (job as { delivery?: unknown }).delivery;
              const delivery = isRecord(deliveryValue) ? deliveryValue : undefined;
              const modeRaw = typeof delivery?.mode === "string" ? delivery.mode : "";
              const mode = normalizeLowercaseStringOrEmpty(modeRaw);
              if (mode === "webhook") {
                const webhookUrl = normalizeHttpWebhookUrl(delivery?.to);
                if (!webhookUrl) {
                  throw new Error(
                    'delivery.mode="webhook" requires delivery.to to be a valid http(s) URL',
                  );
                }
                if (delivery) {
                  delivery.to = webhookUrl;
                }
              }

              const hasTarget =
                (typeof delivery?.channel === "string" && delivery.channel.trim()) ||
                (typeof delivery?.to === "string" && delivery.to.trim());
              const shouldInfer =
                (deliveryValue == null || delivery) &&
                (mode === "" || mode === "announce") &&
                !hasTarget;
              if (shouldInfer) {
                const inferred = resolveCronCreationDelivery({
                  cfg: runtimeConfig,
                  currentDeliveryContext: opts.currentDeliveryContext,
                  agentSessionKey: opts.agentSessionKey,
                });
                if (inferred) {
                  (job as { delivery?: unknown }).delivery = {
                    ...inferred,
                    ...delivery,
                  } satisfies CronDelivery;
                }
              }
            }

            const contextMessages = readNonNegativeIntegerParam(params, "contextMessages") ?? 0;
            if (
              job &&
              typeof job === "object" &&
              "payload" in job &&
              (job as { payload?: { kind?: string; text?: string } }).payload?.kind ===
                "systemEvent"
            ) {
              const payload = (job as { payload: { kind: string; text: string } }).payload;
              if (typeof payload.text === "string" && payload.text.trim()) {
                const contextLines = await buildReminderContextLines({
                  agentSessionKey: opts?.agentSessionKey,
                  gatewayOpts,
                  contextMessages,
                  callGatewayTool: callGateway,
                });
                if (contextLines.length > 0) {
                  const baseText = stripExistingContext(payload.text);
                  payload.text = `${baseText}${REMINDER_CONTEXT_MARKER}${contextLines.join("\n")}`;
                }
              }
            }
            return jsonResult(
              await callGateway("cron.add", gatewayOpts, {
                ...job,
              }),
            );
          }
          case "update": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }

            // Flat-params recovery for patch
            let recoveredFlatPatch = false;
            if (isMissingOrEmptyObject(params.patch)) {
              const synthetic = recoverCronObjectFromFlatParams(params);
              if (synthetic.found) {
                params.patch = synthetic.value;
                recoveredFlatPatch = true;
              }
            }

            if (!params.patch || typeof params.patch !== "object") {
              throw new Error("patch required");
            }
            const canonicalPatch = canonicalizeCronToolObject(
              params.patch as Record<string, unknown>,
            );
            assertNoCronShellExecution(canonicalPatch);
            assertCronDeliveryInputNonBlankFields(canonicalPatch.delivery);
            assertCronPacingInput(canonicalPatch.pacing, { nullableClears: true });
            if (
              typeof canonicalPatch.displayName === "string" &&
              canonicalPatch.displayName.trim().length === 0
            ) {
              throw new Error("displayName must be a non-empty string or null");
            }
            const patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;
            if (recoveredFlatPatch && isEmptyRecoveredCronPatch(patch)) {
              throw new Error("patch required");
            }
            if (callerScope && "agentId" in patch) {
              throw new Error("cron patch agentId cannot be changed by the agent cron tool");
            }
            if (callerScope) {
              assertCronToolSessionRefsMatchScope(patch, callerScope);
            }
            return jsonResult(
              await updateCronJobFromAgentTool({
                id,
                patch,
                creatorToolAllowlist: opts?.creatorToolAllowlist,
                gatewayOpts,
                callGateway,
              }),
            );
          }
          case "remove": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }
            return jsonResult(
              await callGateway("cron.remove", gatewayOpts, {
                id,
              }),
            );
          }
          case "run": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }
            const runMode =
              params.runMode === "due" || params.runMode === "force" ? params.runMode : "due";
            return jsonResult(
              await callGateway("cron.run", gatewayOpts, {
                id,
                mode: runMode,
              }),
            );
          }
          case "runs": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }
            return jsonResult(
              await callGateway("cron.runs", gatewayOpts, {
                id,
              }),
            );
          }
          case "next_check": {
            const jobId = readCronSelfRemoveOnlyJobId(opts);
            const runId = opts?.runId?.trim();
            if (!jobId || !runId) {
              throw new Error("cron next_check is only available to the currently running job");
            }
            const rawDuration = readStringParam(params, "in", { required: true });
            let delayMs: number;
            try {
              delayMs = parseDurationMs(rawDuration);
            } catch {
              throw new Error("cron next_check in must be a positive duration");
            }
            if (delayMs <= 0) {
              throw new Error("cron next_check in must be a positive duration");
            }
            recordCronNextCheckProposal(runId, jobId, delayMs);
            return jsonResult({ ok: true, delayMs });
          }
          case "wake": {
            const text = readStringParam(params, "text", { required: true });
            const mode =
              params.mode === "now" || params.mode === "next-heartbeat"
                ? params.mode
                : "next-heartbeat";
            // Resolve the calling agent's session key into the internal form
            // the cron service routes by (mirrors the `add` action above).
            // Without this, the wake gateway call goes through with no session
            // key and the system event lands on the heartbeat / main default
            // rather than the originating conversation lane. Closes the
            // upstream half of openclaw/openclaw#46886 (#64556 — agentId/
            // sessionKey silently ignored for `action: "wake"`). Explicit
            // params on the tool call still take precedence over the inferred
            // value, so call sites can wake a different session owned by the
            // calling agent.
            const cfg = getRuntimeConfig();
            const { mainKey, alias } = resolveMainSessionAlias(cfg);
            const explicitSessionKey = readStringParam(params, "sessionKey");
            const explicitAgentId = readStringParam(params, "agentId");
            if (callerScope) {
              assertCronToolAgentFieldMatchesScope({
                value: explicitAgentId,
                field: "wake agentId",
                callerScope,
              });
              assertCronToolSessionRefsMatchScope({ sessionKey: explicitSessionKey }, callerScope);
            }
            const inferredSessionKey = opts?.agentSessionKey
              ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
              : undefined;
            const inferredAgentId = opts?.agentSessionKey
              ? resolveSessionAgentId({ sessionKey: opts.agentSessionKey, config: cfg })
              : undefined;
            const sessionKey = explicitSessionKey ?? inferredSessionKey;
            // When a caller supplies an explicit cross-agent sessionKey without
            // an explicit agentId, the gateway target resolver treats agentId as
            // authoritative — pairing the caller's inferred agentId with a
            // foreign session key would canonicalize the wake back to the
            // caller's main lane. Derive the agentId from the explicit canonical
            // session key instead; only fall through to the inferred
            // caller-agent when no explicit sessionKey was supplied.
            const agentIdFromExplicitSessionKey = explicitSessionKey
              ? parseAgentSessionKey(explicitSessionKey)?.agentId
              : undefined;
            // A contradictory explicit pair (agentId X + a sessionKey owned by
            // agent Y) is ambiguous: the gateway target resolver treats agentId
            // as authoritative and would silently canonicalize the wake onto a
            // session under X that the caller never named. Reject instead of
            // guessing one canonical owner.
            if (
              explicitAgentId &&
              agentIdFromExplicitSessionKey &&
              normalizeLowercaseStringOrEmpty(explicitAgentId) !==
                normalizeLowercaseStringOrEmpty(agentIdFromExplicitSessionKey)
            ) {
              throw new Error(
                `wake agentId "${explicitAgentId}" contradicts the agent that owns sessionKey ` +
                  `("${agentIdFromExplicitSessionKey}"); pass a single canonical wake target`,
              );
            }
            const agentId =
              callerScope?.agentId ??
              explicitAgentId ??
              (explicitSessionKey ? agentIdFromExplicitSessionKey : inferredAgentId);
            return jsonResult(
              await callGateway(
                "wake",
                gatewayOpts,
                {
                  mode,
                  text,
                  ...(sessionKey ? { sessionKey } : {}),
                  ...(agentId ? { agentId } : {}),
                },
                { expectFinal: false },
              ),
            );
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      });
    },
  };
  return setToolTerminalPresentation(tool, formatCronTerminalPresentation);
}
