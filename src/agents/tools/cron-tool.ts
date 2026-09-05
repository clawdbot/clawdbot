/**
 * cron built-in tool.
 *
 * Manages scheduled jobs, wake/run actions, delivery context, and reminder-style payload normalization.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveCronCreationDelivery } from "../../cron/delivery-context.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import type { CronDelivery } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { CRON_MANAGEMENT_METHODS } from "../../gateway/cron-creator-authority-grant.js";
import { recordCronNextCheckProposal } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { isRecord } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { bindCronManagementGrant } from "../cron-creator-authority-context.js";
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
  canonicalizeCronToolObject,
  hasCronCreateSignal,
  isEmptyRecoveredCronPatch,
  recoverCronObjectFromFlatParams,
  stripCronCreateNullClears,
} from "./cron-tool-canonicalize.js";
import {
  buildReminderContextLines,
  REMINDER_CONTEXT_MARKER,
  stripExistingContext,
} from "./cron-tool-context.js";
import {
  assertInheritedCronToolCaptureReady,
  capCronJobToolsAllowOnCreate,
  cronCreateRequiresCreatorAuthority,
  resolveCronCreatorExecToolTarget,
} from "./cron-tool-creator-cap.js";
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
import type {
  CronCreatorToolAuthoritySnapshot,
  CronToolDeps,
  CronToolOptions,
} from "./cron-tool.types.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

export type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./cron-tool.types.js";
export {
  captureFinalEffectiveCronCreatorToolAllowlist,
  replaceWithEffectiveCronCreatorToolAllowlist,
} from "./cron-tool-creator-cap.js";

function isMissingOrEmptyObject(value: unknown): boolean {
  return !value || (isRecord(value) && Object.keys(value).length === 0);
}

function readCronJobIdParam(params: Record<string, unknown>) {
  return readToolStringParam(params, "jobId") ?? readToolStringParam(params, "id");
}

function requireCronJobIdParam(params: Record<string, unknown>): string {
  const id = readCronJobIdParam(params);
  if (!id) {
    throw new Error("jobId required (id accepted for backward compatibility)");
  }
  return id;
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
  if (["next_check", "get", "remove", "runs"].includes(action)) {
    const id = readCronJobIdParam(params);
    if (id === selfRemoveOnlyJobId || (action === "next_check" && !id)) {
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
    ? '\n- {kind:"stream",command:[argv],mode?:"line"|"match",match?}: fires on supervised process output; disabled only when cron.triggers.enabled=false.'
    : "";
  const scriptPayloadLine = params.triggersEnabled
    ? '\n- script {kind:"script",script,timeoutSeconds?,toolBudget?}: main|isolated only; disabled only when cron.triggers.enabled=false.'
    : "";
  const triggerSection = params.triggersEnabled
    ? `TRIGGER (condition watcher on every/cron): {script,once?}; available unless cron.triggers.enabled=false — if off, say so; never model-poll instead. Quiet headless check, no model; 30s/5 tool calls/16KB state. Read frozen trigger.state, return json({fire,message?,state?}) with NEW state; dedupe via state, never memory. fire:false saves state only. fire:true runs payload; message is that run's entire context — self-contained. Fire on failures/timeouts too; success-only watchers look healthy when broken. Script stays read-only; actions belong in payload. once:true disables after first fire. Code Mode: await exec({command:"..."}).`
    : `TRIGGERS DISABLED (cron.triggers.enabled=false): condition triggers, script payloads, and stream schedules are unavailable here. Omit trigger; use plain time-based schedules. If the user asks for a conditional watcher, say it is unsupported — never model-poll instead, and never silently create an unconditional job in its place.`;
  const silentWatcherCue = params.triggersEnabled ? ' Silent watcher=>mode:"none".' : "";
  return `Gateway scheduler: reminders, delayed self-wakeups, loops, recurring work${params.triggersEnabled ? ", event watchers" : ""}. Never exec sleep/poll as timer.

ACTIONS: status | list [includeDisabled,limit?,offset?] (compact summaries with timing; use nextOffset for the next page) | get jobId (full schedule, payload, and delivery details) | add job | update jobId job (partial: only supplied fields change; null clears) | remove jobId | run jobId (runMode "force"=now) | runs jobId = history | next_check in:"30m" (own paced run only) | wake text mode?:"now"|"next-heartbeat"(default) nudges a caller-owned lane (sessionKey/agentId to pick another).

Authenticated Control UI administrator turns can list/get/update/run/remove any Gateway automation. Other turns have a restricted inventory; use a fresh admin Control UI turn or the Automations page for cross-session management.

ADD: ${addFields}. Required: schedule+payload.

SCHEDULE:
- {kind:"at",at:"ISO-8601"} one-shot; no tz=UTC; auto-deletes after successful completion: delivery confirmed, not requested, intentionally silent, or explicitly bestEffort. Failed/unknown required delivery retains it disabled.
- {kind:"every",everyMs}.
- {kind:"cron",expr,tz?:"IANA"}: expr is wall time in tz; never pre-convert to UTC; no tz=gateway host local. 18:00 Shanghai => {expr:"0 18 * * *",tz:"Asia/Shanghai"}.${streamScheduleLine}

TARGET+PAYLOAD:
- "current" (agentTurn default) = this conversation: the run stays detached, reads bounded chat context, then commits its final visible assistant result to this conversation's durable history. Self-wakeup/"continue later"/loop = at|every + agentTurn + current.
- "isolated" = fresh detached session (shows in \`openclaw tasks\`); standalone background work.
- "main" = heartbeat lane; payload {kind:"systemEvent",text} (systemEvent default target).
- "session:<key>" = named session.
- agentTurn {kind:"agentTurn",message,model?,thinking?,timeoutSeconds?}; timeoutSeconds 0=none.
- Inherited configured MCP authority includes only model-callable tools; interactive app-view-only capabilities are excluded from headless jobs.${scriptPayloadLine}

PACED LOOP: recurring job + pacing{min?,max?} durations ("15m","4h"; at least one). Inside its run, job calls next_check in:"<dur>" to set the next delay (clamped to bounds, measured from run end; failed runs keep normal backoff). Adaptive polling: tighten when active, back off when quiet.

${triggerSection}

DELIVERY {mode:"none"|"announce"|"webhook",channel?,to?,threadId?,bestEffort?,completionDestination?}: where detached run output goes. Omitted=announce (current=>canonical session commit, plus one normal channel send for external chats; isolated=>last route; set channel/to for a specific chat — no messaging tool inside the run). A current announce succeeds only after its history commit; WebChat observes that commit live and after reconnect without another user message.${silentWatcherCue} webhook posts finished-run event (successful empty summary is intentional silence, no POST) to URL in \`to\`. To keep announce delivery and also POST completion, use mode:"announce" with completionDestination:{mode:"webhook",to:"https://..."}.

FAILURE ALERTS: jobs with a failure route default to alerting after 2 consecutive execution failures with a 1h cooldown. Route order: job failureAlert fields, delivery.failureDestination over global cron.failureAlert destination fields, then primary announce. failureAlert:false disables execution/delivery alerts, not the auto-disable safety notice; a failureAlert object activates/tunes. bestEffort suppresses inherited execution alerts. Required completion-delivery failure uses only an alternate route, bypasses after, and shares the execution-alert cooldown from the first failure; it does not increment the execution streak.

Job wakeMode (main jobs): "now"(default)|"next-heartbeat". Restricted automation-run sessions: self status/list/get/runs/remove + own next_check only. jobId canonical (id=compat). contextMessages 0-10 embeds recent chat lines into reminder text.`;
}

export function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool {
  const gatewayCall = deps?.callGatewayTool ?? callGatewayTool;
  const managementAuthority = bindCronManagementGrant(opts?.runId);
  // Trigger-gated surfaces default on, matching cron/service/jobs-validation.ts.
  const triggersEnabled = opts?.config?.cron?.triggers?.enabled !== false;
  const tool: AnyAgentTool = {
    label: "Automations",
    name: AUTOMATIONS_TOOL_NAME,
    displaySummary: CRON_TOOL_DISPLAY_SUMMARY,
    description: managementAuthority?.managementOnly
      ? 'Manage any existing automation on this Gateway as the authenticated Control UI administrator. Actions: list [includeDisabled,limit,offset] (compact summaries with timing; follow nextOffset); get jobId (full schedule, payload, and delivery details); update jobId job (partial patch, null clears); run jobId (runMode:"force" runs now); remove jobId. Creator attribution and scheduled execution policy stay intact. Use the Automations page for other actions.'
      : buildCronToolDescription({ triggersEnabled }),
    parameters: createCronToolSchema({
      agentSessionKey: opts?.agentSessionKey,
      triggersEnabled,
      management: managementAuthority
        ? managementAuthority.managementOnly
          ? "only"
          : "also"
        : undefined,
    }),
    execute: async (_toolCallId, args, operationSignal) => {
      operationSignal?.throwIfAborted();
      const callGateway: typeof callGatewayTool = async <T>(
        ...request: Parameters<typeof callGatewayTool>
      ) => {
        const identity = getGatewayToolCallerIdentity();
        const grant = managementAuthority?.mint(request[0], operationSignal);
        if (grant && !identity) {
          throw new Error(
            "Automation management requires the active Control UI administrator turn.",
          );
        }
        return grant && identity
          ? await withGatewayToolCallerIdentity(
              {
                ...identity,
                cronManagementGrant: grant,
              },
              () => gatewayCall<T>(...request),
            )
          : await gatewayCall<T>(...request);
      };
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (
        managementAuthority?.managementOnly &&
        !CRON_MANAGEMENT_METHODS.some((method) => method === `cron.${action}`)
      ) {
        throw new Error(
          "This turn can only list, get, update, run, or remove automations. Use the Automations page for other actions.",
        );
      }
      assertCronSelfRemoveScope(opts, action, params);
      const parsedGatewayOpts = readGatewayCallOptions(params);
      const gatewayOpts: GatewayCallOptions = {
        ...parsedGatewayOpts,
        timeoutMs: parsedGatewayOpts.timeoutMs ?? 60_000,
      };
      const runtimeConfig = getRuntimeConfig();
      const callerAgentId = opts?.agentSessionKey?.trim()
        ? resolveSessionAgentId({
            sessionKey: opts.agentSessionKey,
            config: runtimeConfig,
            agentId: opts.agentId,
          })
        : undefined;
      const creatorExecToolTarget = resolveCronCreatorExecToolTarget(opts?.creatorToolAllowlist);
      const callerIdentity =
        callerAgentId && opts?.agentSessionKey?.trim()
          ? {
              agentId: callerAgentId,
              sessionKey: opts.agentSessionKey.trim(),
              turnSourceAccountId: opts.agentAccountId,
              ...(readCronSelfRemoveOnlyJobId(opts)
                ? { cronSelfManagementJobId: readCronSelfRemoveOnlyJobId(opts) }
                : {}),
              ...(opts?.creatorToolAllowlistCaptureRef?.value?.version === 1 &&
              opts.creatorToolAllowlistCaptureRef.value.source === "final-executable-surface"
                ? {
                    cronToolsAllowCapture: "final-executable-surface" as const,
                    ...(creatorExecToolTarget ? { cronExecToolTarget: creatorExecToolTarget } : {}),
                  }
                : {}),
            }
          : undefined;

      const withCreatorAuthorityProvenance = async <T>(
        authority: CronCreatorToolAuthoritySnapshot | undefined,
        run: () => Promise<T>,
      ): Promise<T> => {
        if (!authority) {
          return await run();
        }
        if (!callerIdentity) {
          throw new Error(
            "fresh configured MCP cron authority requires an authenticated local agent run",
          );
        }
        const cronExecToolTarget = resolveCronCreatorExecToolTarget(authority.tools);
        return await withGatewayToolCallerIdentity(
          {
            ...callerIdentity,
            cronToolsAllowCapture: "final-executable-surface",
            ...(cronExecToolTarget ? { cronExecToolTarget } : {}),
            cronCreatorAuthorityGrant: authority.grant,
          },
          run,
        );
      };

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
            const listAgentId = readToolStringParam(params, "agentId");
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
              return jsonResult({
                ...result,
                scope: managementAuthority ? "gateway" : "caller",
                ...(!managementAuthority
                  ? {
                      scopeHint:
                        "Restricted automation inventory. For Gateway-wide management, use a fresh authenticated Control UI administrator turn or the Automations page.",
                    }
                  : {}),
              });
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
            const id = requireCronJobIdParam(params);
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
                  agentId: callerAgentId,
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
              await withCreatorAuthorityProvenance(resolvedAuthority, () =>
                callGateway("cron.add", gatewayOpts, job),
              ),
            );
          }
          case "update": {
            const id = requireCronJobIdParam(params);

            // Flat-params recovery for update patches
            let recoveredFlatPatch = false;
            if (isMissingOrEmptyObject(params.job)) {
              const synthetic = recoverCronObjectFromFlatParams(params);
              if (synthetic.found) {
                params.job = synthetic.value;
                recoveredFlatPatch = true;
              }
            }

            if (!params.job || typeof params.job !== "object") {
              throw new Error("job required");
            }
            const canonicalPatch = canonicalizeCronToolObject(
              params.job as Record<string, unknown>,
            );
            if (!managementAuthority) {
              assertNoCronShellExecution(canonicalPatch);
            }
            assertCronDeliveryInputNonBlankFields(canonicalPatch.delivery);
            assertCronPacingInput(canonicalPatch.pacing);
            if (
              typeof canonicalPatch.displayName === "string" &&
              canonicalPatch.displayName.trim().length === 0
            ) {
              throw new Error("displayName must be a non-empty string or null");
            }
            const patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;
            if (recoveredFlatPatch && isEmptyRecoveredCronPatch(patch)) {
              throw new Error("job required");
            }
            // Admin patches still need stored-payload inference, but must not
            // recapture the creator's execution authority.
            const creatorOptions = managementAuthority ? undefined : opts;
            return jsonResult(
              await updateCronJobFromAgentTool({
                id,
                patch,
                adminManagement: Boolean(managementAuthority),
                creatorToolAllowlist: creatorOptions?.creatorToolAllowlist,
                creatorToolAllowlistCaptureRef: creatorOptions?.creatorToolAllowlistCaptureRef,
                resolveCreatorToolAuthority: creatorOptions?.resolveCreatorToolAuthority,
                withCreatorAuthorityProvenance:
                  !managementAuthority && callerIdentity
                    ? withCreatorAuthorityProvenance
                    : undefined,
                gatewayOpts,
                callGateway,
                operationSignal,
                creatorAuthorityUnavailableReason:
                  creatorOptions?.creatorAuthorityUnavailableReason,
              }),
            );
          }
          case "remove": {
            const id = requireCronJobIdParam(params);
            return jsonResult(
              await callGateway("cron.remove", gatewayOpts, {
                id,
              }),
            );
          }
          case "run": {
            const id = requireCronJobIdParam(params);
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
            const id = requireCronJobIdParam(params);
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
            // An omitted target wakes the originating conversation, not the
            // heartbeat lane. Gateway owns target validation and authorization.
            const { mainKey, alias } = resolveMainSessionAlias(runtimeConfig);
            const explicitSessionKey = readToolStringParam(params, "sessionKey");
            const explicitAgentId = readToolStringParam(params, "agentId");
            const inferredSessionKey = opts?.agentSessionKey
              ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
              : undefined;
            const sessionKey = explicitSessionKey ?? inferredSessionKey;
            // Pair an explicit session with its own agent; caller defaults must
            // not rewrite that target before the Gateway can validate it.
            const agentIdFromExplicitSessionKey = explicitSessionKey
              ? parseAgentSessionKey(explicitSessionKey)?.agentId
              : undefined;
            const agentId =
              explicitAgentId ??
              (explicitSessionKey ? agentIdFromExplicitSessionKey : callerAgentId);
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
