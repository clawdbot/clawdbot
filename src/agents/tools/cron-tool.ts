/**
 * cron built-in tool.
 *
 * Manages scheduled jobs, wake/run actions, delivery context, and reminder-style payload normalization.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronCreationDelivery } from "../../cron/delivery-context.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import type { CronDelivery } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { recordCronNextCheckProposal } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { isRecord } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { CRON_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { setToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { AUTOMATIONS_TOOL_NAME } from "./automations-tool-name.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";
import {
  assertCronToolAgentFieldMatchesScope,
  assertCronToolSessionRefsMatchScope,
  readCronToolAgentId,
  resolveCronToolCallerScope,
} from "./cron-tool-caller-scope.js";
import { canonicalizeCronToolObject, stripCronCreateNullClears } from "./cron-tool-canonicalize.js";
import {
  buildReminderContextLines,
  REMINDER_CONTEXT_MARKER,
  stripExistingContext,
} from "./cron-tool-context.js";
import {
  assertInheritedCronToolCaptureReady,
  capCronJobToolsAllowOnCreate,
  cronCreateRequiresCreatorAuthority,
} from "./cron-tool-creator-cap.js";
import { prepareCronToolArguments } from "./cron-tool-prepare.js";
import {
  assertCronPacingInput,
  createCronToolSchema,
  CRON_TOOL_LIST_MAX_LIMIT,
} from "./cron-tool-schema.js";
import { listCronSelfJob } from "./cron-tool-self-list.js";
import {
  assertCronCreatorAuthorityResolutionAvailable,
  assertNoCronShellExecution,
  updateCronJobFromAgentTool,
} from "./cron-tool-write.js";
import type { CronToolDeps, CronToolOptions } from "./cron-tool.types.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

export type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./cron-tool.types.js";
export {
  captureFinalEffectiveCronCreatorToolAllowlist,
  replaceWithEffectiveCronCreatorToolAllowlist,
} from "./cron-tool-creator-cap.js";

function readCronJobIdParam(params: Record<string, unknown>) {
  return readToolStringParam(params, "jobId") ?? readToolStringParam(params, "id");
}

const CRON_SELF_REMOVE_SCOPE_ERROR = "Automations tool is restricted to the current automation.";

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
      return { text: `Automations scheduler status.\nEnabled: ${enabled}` };
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
        ? { text: "Automations listed." }
        : { text: `Automations listed.\nCount: ${count}` };
    }
    case "get":
      return { text: "Automation loaded." };
    case "runs": {
      const entries = Array.isArray(result.details.entries)
        ? result.details.entries.length
        : undefined;
      return entries === undefined
        ? { text: "Automation run history loaded." }
        : { text: `Automation run history loaded.\nCount: ${entries}` };
    }
    default:
      return undefined;
  }
}

function isOlderGatewayWithoutCompactCronList(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("invalid cron.list params") &&
    error.message.includes("unexpected property 'compact'")
  );
}

function buildCronToolDescription(params: { triggersEnabled: boolean }): string {
  const addFields = params.triggersEnabled
    ? "{name?,schedule,payload,sessionTarget?,pacing?,trigger?,delivery?,enabled?}"
    : "{name?,schedule,payload,sessionTarget?,pacing?,delivery?,enabled?}";
  const streamScheduleLine = params.triggersEnabled
    ? '\n- {kind:"stream",command:[argv],mode?:"line"|"match",match?}: fires on supervised process output; needs cron.triggers.enabled.'
    : "";
  const scriptPayloadLine = params.triggersEnabled
    ? '\n- script {kind:"script",script,timeoutSeconds?,toolBudget?}: main|isolated only; needs cron.triggers.enabled.'
    : "";
  const triggerSection = params.triggersEnabled
    ? `TRIGGER (condition watcher on every/cron): {script,once?}; needs cron.triggers.enabled — if off, say so; never model-poll instead. Quiet headless check, no model; 30s/5 tool calls/16KB state. Read frozen trigger.state, return json({fire,message?,state?}) with NEW state; dedupe via state, never memory. fire:false saves state only. fire:true runs payload; message is that run's entire context — self-contained. Fire on failures/timeouts too; success-only watchers look healthy when broken. Script stays read-only; actions belong in payload. once:true disables after first fire. Code Mode: await tools.call("exec",{command:"..."}).`
    : `TRIGGERS DISABLED (cron.triggers.enabled=false): condition triggers, script payloads, and stream schedules are unavailable here. Omit trigger; use plain time-based schedules. If the user asks for a conditional watcher, say it is unsupported — never model-poll instead, and never silently create an unconditional job in its place.`;
  const silentWatcherCue = params.triggersEnabled ? ' Silent watcher=>mode:"none".' : "";
  return `Gateway scheduler: reminders, delayed self-wakeups, loops, recurring work${params.triggersEnabled ? ", event watchers" : ""}. Never exec sleep/poll as timer.

ACTIONS: status | list [includeDisabled,limit?,offset?] (use nextOffset for the next page) | get jobId | add job | update jobId job (partial: only supplied fields change; null clears) | remove jobId | run jobId (runMode "force"=now) | runs jobId = history | next_check in:"30m" (own paced run only) | wake text mode?:"now"|"next-heartbeat"(default) nudges a caller-owned lane (sessionKey/agentId to pick another).

ADD: ${addFields}. Required: schedule+payload.

For ordinary add/update calls, prefer these flat fields when nested objects are unreliable:
{ "action":"add", "name":"...", "at":"<ISO-8601>"|"everyMs":<ms>|"expr":"<cron>", "tz":"<optional-IANA>", "message":"<agentTurn prompt>"|"text":"<systemEvent text>", "toolsAllow":["read"], "sessionTarget":"main|isolated|current|session:<id>", "enabled":true }
Exactly one schedule field: at, everyMs, or expr. message implies agentTurn; text implies systemEvent.
Use nested job for model routing, scripts, pacing, triggers, streams, delivery, and other advanced settings. Top-level mode is wake-only.
When both forms are sent, the nested job takes precedence over flat fields.

SCHEDULE:
- {kind:"at",at:"ISO-8601"} one-shot; no tz=UTC; auto-deletes after run.
- {kind:"every",everyMs}.
- {kind:"cron",expr,tz?:"IANA"}: expr is wall time in tz; never pre-convert to UTC; no tz=gateway host local. 18:00 Shanghai => {expr:"0 18 * * *",tz:"Asia/Shanghai"}.${streamScheduleLine}

TARGET+PAYLOAD:
- "current" (agentTurn default) = this conversation: run carries this chat's context, result lands here. Self-wakeup/"continue later"/loop = at|every + agentTurn + current.
- "isolated" = fresh detached session (shows in \`openclaw tasks\`); standalone background work.
- "main" = heartbeat lane; payload {kind:"systemEvent",text} (systemEvent default target).
- "session:<key>" = named session.
- agentTurn {kind:"agentTurn",message,model?,thinking?,timeoutSeconds?}; timeoutSeconds 0=none.
- Inherited configured MCP authority includes only model-callable tools; interactive app-view-only capabilities are excluded from headless jobs.${scriptPayloadLine}

PACED LOOP: recurring job + pacing{min?,max?} durations ("15m","4h"; at least one). Inside its run, job calls next_check in:"<dur>" to set the next delay (clamped to bounds, measured from run end; failed runs keep normal backoff). Adaptive polling: tighten when active, back off when quiet.

${triggerSection}

DELIVERY {mode:"none"|"announce"|"webhook",channel?,to?,threadId?,bestEffort?,completionDestination?}: where detached run output goes. Omitted=announce (current=>this chat; isolated=>last route; set channel/to for a specific chat — no messaging tool inside the run).${silentWatcherCue} webhook posts finished-run event to URL in \`to\`. To keep announce delivery and also POST completion, use mode:"announce" with completionDestination:{mode:"webhook",to:"https://..."}.

Job wakeMode (main jobs): "now"(default)|"next-heartbeat". Restricted automation-run sessions: self status/list/get/runs/remove + own next_check only. failureAlert {...}|false disables. jobId canonical (id=compat). contextMessages 0-10 embeds recent chat lines into reminder text.`;
}

// Trigger-gated surfaces stay advertised for config-less callers; only an
// explicit runtime config with cron.triggers.enabled !== true narrows the
// model-facing surface, matching the scheduler's own gate in
// cron/service/jobs-validation.ts.
function resolveCronTriggersEnabled(config?: OpenClawConfig): boolean {
  if (!config) {
    return true;
  }
  return config.cron?.triggers?.enabled === true;
}

export function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  const triggersEnabled = resolveCronTriggersEnabled(opts?.config);
  const tool: AnyAgentTool = {
    label: "Automations",
    name: AUTOMATIONS_TOOL_NAME,
    displaySummary: CRON_TOOL_DISPLAY_SUMMARY,
    description: buildCronToolDescription({ triggersEnabled }),
    parameters: createCronToolSchema({ triggersEnabled }),
    prepareArguments: prepareCronToolArguments,
    execute: async (_toolCallId, args, operationSignal) => {
      operationSignal?.throwIfAborted();
      const params = prepareCronToolArguments(args);
      const action = readToolStringParam(params, "action", { required: true });
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
              ...(opts?.creatorToolAllowlistCaptureRef?.value?.version === 1 &&
              opts.creatorToolAllowlistCaptureRef.value.source === "final-executable-surface"
                ? { cronToolsAllowCapture: "final-executable-surface" as const }
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
            const requestedLimit = selfRemoveOnlyJobId
              ? undefined
              : readPositiveIntegerParam(params, "limit", {
                  max: CRON_TOOL_LIST_MAX_LIMIT,
                  message: `limit must be a positive integer no greater than ${CRON_TOOL_LIST_MAX_LIMIT}`,
                });
            const requestedOffset = selfRemoveOnlyJobId
              ? undefined
              : readNonNegativeIntegerParam(params, "offset");
            let useCompactList = true;
            const requestListPage = async (pageParams: Record<string, unknown>) => {
              for (;;) {
                try {
                  return await callGateway("cron.list", gatewayOpts, {
                    includeDisabled,
                    ...(useCompactList ? { compact: true } : {}),
                    ...(listAgentId ? { agentId: listAgentId } : {}),
                    ...pageParams,
                  });
                } catch (error) {
                  if (!useCompactList || !isOlderGatewayWithoutCompactCronList(error)) {
                    throw error;
                  }
                  // Protocol v4 gateways predating compact reject the additive field.
                  // Retry without it for mixed-version correctness; remove at the next protocol break.
                  useCompactList = false;
                }
              }
            };
            if (!selfRemoveOnlyJobId) {
              const result = await requestListPage({
                ...(requestedLimit !== undefined ? { limit: requestedLimit } : {}),
                ...(requestedOffset !== undefined ? { offset: requestedOffset } : {}),
              });
              return jsonResult(result);
            }

            return jsonResult(
              await listCronSelfJob({
                jobId: selfRemoveOnlyJobId,
                pageSize: CRON_TOOL_LIST_MAX_LIMIT,
                requestPage: requestListPage,
              }),
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
            if (!params.job || typeof params.job !== "object") {
              throw new Error("job required");
            }
            const canonicalJob = stripCronCreateNullClears(
              canonicalizeCronToolObject(params.job as Record<string, unknown>),
            );
            assertNoCronShellExecution(canonicalJob);
            assertCronDeliveryInputNonBlankFields(canonicalJob.delivery);
            assertCronPacingInput(canonicalJob.pacing);
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
            const requiresCreatorAuthority = cronCreateRequiresCreatorAuthority(
              job,
              opts?.creatorToolAllowlist,
            );
            assertCronCreatorAuthorityResolutionAvailable({
              required: requiresCreatorAuthority,
              resolveCreatorToolAuthority: opts?.resolveCreatorToolAuthority,
              creatorToolAllowlistCaptureRef: opts?.creatorToolAllowlistCaptureRef,
              unavailableReason: opts?.creatorAuthorityUnavailableReason,
            });
            const resolvedAuthority =
              requiresCreatorAuthority && opts?.resolveCreatorToolAuthority
                ? await opts.resolveCreatorToolAuthority({ signal: operationSignal })
                : undefined;
            operationSignal?.throwIfAborted();
            const creatorToolAllowlist = resolvedAuthority?.tools ?? opts?.creatorToolAllowlist;
            const creatorToolAllowlistCaptureRef = resolvedAuthority
              ? { value: resolvedAuthority.provenance }
              : opts?.creatorToolAllowlistCaptureRef;
            capCronJobToolsAllowOnCreate(job, creatorToolAllowlist);
            assertInheritedCronToolCaptureReady(job, creatorToolAllowlistCaptureRef);
            if (job && typeof job === "object") {
              const { mainKey, alias } = resolveMainSessionAlias(runtimeConfig);
              const resolvedSessionKey = opts?.agentSessionKey
                ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
                : undefined;
              if (callerScope) {
                assertCronToolAgentFieldMatchesScope({
                  value: (job as { agentId?: unknown }).agentId,
                  field: "automation agentId",
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
                  agentId: callerScope?.agentId,
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
            const writeCallerIdentity =
              resolvedAuthority && callerIdentity
                ? {
                    ...callerIdentity,
                    cronToolsAllowCapture: "final-executable-surface" as const,
                    cronCreatorAuthorityGrant: resolvedAuthority.grant,
                  }
                : callerIdentity;
            if (
              resolvedAuthority &&
              (!writeCallerIdentity || !("cronCreatorAuthorityGrant" in writeCallerIdentity))
            ) {
              throw new Error(
                "fresh configured MCP cron authority requires an authenticated local agent run",
              );
            }
            return jsonResult(
              await withGatewayToolCallerIdentity(
                writeCallerIdentity,
                async () =>
                  await callGateway("cron.add", gatewayOpts, {
                    ...job,
                  }),
              ),
            );
          }
          case "update": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }

            if (!params.job || typeof params.job !== "object") {
              throw new Error("job required");
            }
            const canonicalPatch = canonicalizeCronToolObject(
              params.job as Record<string, unknown>,
            );
            assertNoCronShellExecution(canonicalPatch);
            assertCronDeliveryInputNonBlankFields(canonicalPatch.delivery);
            assertCronPacingInput(canonicalPatch.pacing);
            if (
              typeof canonicalPatch.displayName === "string" &&
              canonicalPatch.displayName.trim().length === 0
            ) {
              throw new Error("displayName must be a non-empty string or null");
            }
            const patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;
            if (callerScope && "agentId" in patch) {
              throw new Error("automation patch agentId cannot be changed by the automations tool");
            }
            if (callerScope) {
              assertCronToolSessionRefsMatchScope(patch, callerScope);
            }
            return jsonResult(
              await updateCronJobFromAgentTool({
                id,
                patch,
                creatorToolAllowlist: opts?.creatorToolAllowlist,
                creatorToolAllowlistCaptureRef: opts?.creatorToolAllowlistCaptureRef,
                resolveCreatorToolAuthority: opts?.resolveCreatorToolAuthority,
                withCreatorAuthorityProvenance: callerIdentity
                  ? async (authority, run) =>
                      await withGatewayToolCallerIdentity(
                        {
                          ...callerIdentity,
                          cronToolsAllowCapture: "final-executable-surface",
                          cronCreatorAuthorityGrant: authority.grant,
                        },
                        run,
                      )
                  : undefined,
                gatewayOpts,
                callGateway,
                operationSignal,
                creatorAuthorityUnavailableReason: opts?.creatorAuthorityUnavailableReason,
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
            const rawDuration = readToolStringParam(params, "in", { required: true });
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
            const text = readToolStringParam(params, "text", { required: true });
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
            const explicitSessionKey = readToolStringParam(params, "sessionKey");
            const explicitAgentId = readToolStringParam(params, "agentId");
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
              ? resolveSessionAgentId({
                  sessionKey: opts.agentSessionKey,
                  config: cfg,
                  agentId: opts.agentId,
                })
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
