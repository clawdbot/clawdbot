/**
 * cron built-in tool.
 *
 * Manages scheduled jobs, wake/run actions, delivery context, and reminder-style payload normalization.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { Type, type TSchema } from "typebox";
import { getRuntimeConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveCronCreationDelivery } from "../../cron/delivery-context.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import type { CronDelivery } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { isRecord, truncateUtf16Safe } from "../../utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import {
  optionalFiniteNumberSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  optionalStringEnum,
  stringEnum,
} from "../schema/typebox.js";
import { CRON_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { isToolAllowedByPolicyName } from "../tool-policy-match.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  expandToolGroups,
  normalizeToolName,
} from "../tool-policy.js";
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
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

// Spell out job/patch properties for model-facing schema; runtime validation
// still happens in normalizeCronJob* to avoid nested union schemas.

const CRON_ACTIONS = [
  "status",
  "list",
  "get",
  "add",
  "update",
  "remove",
  "run",
  "runs",
  "wake",
] as const;

const CRON_SCHEDULE_KINDS = ["at", "every", "cron"] as const;
const CRON_WAKE_MODES = ["now", "next-heartbeat"] as const;
const CRON_PAYLOAD_KINDS = ["systemEvent", "agentTurn"] as const;
const CRON_DELIVERY_MODES = ["none", "announce", "webhook"] as const;
const CRON_RUN_MODES = ["due", "force"] as const;

const REMINDER_CONTEXT_MESSAGES_MAX = 10;
const REMINDER_CONTEXT_PER_MESSAGE_MAX = 220;
const REMINDER_CONTEXT_TOTAL_MAX = 700;
const REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n";

function isMissingOrEmptyObject(value: unknown): boolean {
  return !value || (isRecord(value) && Object.keys(value).length === 0);
}

function nullableStringSchema(description: string) {
  return Type.Optional(Type.Union([Type.String(), Type.Null()], { description }));
}

function nullableStringArraySchema(description: string) {
  return Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()], { description }));
}

function deliveryStringSchema(params: { description: string; nullableClears: boolean }) {
  return params.nullableClears
    ? nullableStringSchema(`${params.description}, or null to clear`)
    : Type.Optional(Type.String({ description: params.description }));
}

function deliveryThreadIdSchema(params: { nullableClears: boolean }) {
  const variants = params.nullableClears
    ? [Type.String(), Type.Number(), Type.Null()]
    : [Type.String(), Type.Number()];
  return Type.Optional(Type.Union(variants, { description: "Thread/topic id" }));
}

function failureDestinationModeSchema(params: { nullableClears: boolean }) {
  const variants = params.nullableClears
    ? [Type.Literal("announce"), Type.Literal("webhook"), Type.Null()]
    : [Type.Literal("announce"), Type.Literal("webhook")];
  return Type.Optional(Type.Union(variants));
}

function cronPayloadObjectSchema(params: {
  model: TSchema;
  toolsAllow: TSchema;
  fallbacks: TSchema;
}) {
  return Type.Object(
    {
      kind: optionalStringEnum(CRON_PAYLOAD_KINDS, { description: "Payload kind" }),
      text: Type.Optional(Type.String({ description: "systemEvent text" })),
      message: Type.Optional(Type.String({ description: "agentTurn prompt" })),
      model: params.model,
      thinking: Type.Optional(Type.String({ description: "Thinking override" })),
      timeoutSeconds: optionalFiniteNumberSchema({ minimum: 0 }),
      lightContext: Type.Optional(Type.Boolean()),
      allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
      fallbacks: params.fallbacks,
      toolsAllow: params.toolsAllow,
    },
    { additionalProperties: true },
  );
}

function createCronScheduleSchema(): TSchema {
  return Type.Optional(
    Type.Object(
      {
        kind: optionalStringEnum(CRON_SCHEDULE_KINDS, { description: "Schedule kind" }),
        at: Type.Optional(Type.String({ description: "ISO-8601 time (kind=at)" })),
        everyMs: optionalPositiveIntegerSchema({ description: "Interval ms (kind=every)" }),
        anchorMs: optionalNonNegativeIntegerSchema({
          description: "Start anchor ms (kind=every)",
        }),
        expr: Type.Optional(
          Type.String({
            description:
              'Cron wall-time expr; never UTC-convert. Missing tz=Gateway local. Example "0 18 * * *", "Asia/Shanghai".',
          }),
        ),
        tz: Type.Optional(
          Type.String({
            description:
              'IANA timezone for wall-clock fields; missing=Gateway host local timezone. Example "Asia/Shanghai".',
          }),
        ),
        staggerMs: optionalNonNegativeIntegerSchema({ description: "Jitter ms (kind=cron)" }),
      },
      { additionalProperties: true },
    ),
  );
}

function createCronPayloadSchema(): TSchema {
  return Type.Optional(
    cronPayloadObjectSchema({
      model: Type.Optional(Type.String({ description: "Model override" })),
      toolsAllow: Type.Optional(Type.Array(Type.String(), { description: "Allowed tools" })),
      fallbacks: Type.Optional(Type.Array(Type.String(), { description: "Fallback models" })),
    }),
  );
}

function createCronTriggerSchema(params: { nullableClears: boolean }): TSchema {
  const trigger = Type.Object(
    {
      script: Type.String({ minLength: 1, maxLength: 65_536 }),
      once: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  return Type.Optional(params.nullableClears ? Type.Union([trigger, Type.Null()]) : trigger);
}

function cronDeliverySchema(params: { nullableClears: boolean }) {
  const failureDestinationObject = Type.Object(
    {
      channel: deliveryStringSchema({
        description: "Failure delivery channel",
        nullableClears: params.nullableClears,
      }),
      to: deliveryStringSchema({
        description: "Failure delivery target",
        nullableClears: params.nullableClears,
      }),
      accountId: deliveryStringSchema({
        description: "Failure delivery account",
        nullableClears: params.nullableClears,
      }),
      mode: failureDestinationModeSchema({ nullableClears: params.nullableClears }),
    },
    { additionalProperties: true },
  );

  return Type.Optional(
    Type.Object(
      {
        mode: optionalStringEnum(CRON_DELIVERY_MODES, { description: "Delivery mode" }),
        channel: deliveryStringSchema({
          description: "Delivery channel",
          nullableClears: params.nullableClears,
        }),
        to: deliveryStringSchema({
          description: "Delivery target",
          nullableClears: params.nullableClears,
        }),
        threadId: deliveryThreadIdSchema({ nullableClears: params.nullableClears }),
        bestEffort: Type.Optional(Type.Boolean()),
        accountId: deliveryStringSchema({
          description: "Delivery account",
          nullableClears: params.nullableClears,
        }),
        failureDestination: params.nullableClears
          ? Type.Optional(
              Type.Union([failureDestinationObject, Type.Null()], {
                description: "Failure destination; null clears.",
              }),
            )
          : Type.Optional(failureDestinationObject),
      },
      { additionalProperties: true },
    ),
  );
}

function createCronDeliverySchema(): TSchema {
  return cronDeliverySchema({ nullableClears: false });
}

function createCronDeliveryPatchSchema(): TSchema {
  return cronDeliverySchema({ nullableClears: true });
}

// Omitting `failureAlert` means "leave defaults/unchanged"; `false` explicitly disables alerts.
// Runtime handles `failureAlert === false` in cron/service/timer.ts.
// The schema declares `type: "object"` to stay compatible with providers that
// enforce an OpenAPI 3.0 subset (e.g. Gemini via GitHub Copilot).  The
// description tells the LLM that `false` is also accepted.
function createCronFailureAlertSchema(): TSchema {
  return Type.Optional(
    Type.Unsafe<Record<string, unknown> | false>({
      type: "object",
      properties: {
        after: optionalPositiveIntegerSchema({ description: "Failures before alert" }),
        channel: Type.Optional(Type.String({ description: "Alert channel" })),
        to: Type.Optional(Type.String({ description: "Alert target" })),
        cooldownMs: optionalNonNegativeIntegerSchema({ description: "Alert cooldown ms" }),
        includeSkipped: Type.Optional(Type.Boolean({ description: "Count skipped runs." })),
        mode: optionalStringEnum(["announce", "webhook"] as const),
        accountId: Type.Optional(Type.String()),
      },
      additionalProperties: true,
      description: "Failure alert; false disables.",
    }),
  );
}

function createCronJobObjectSchema(): TSchema {
  return Type.Optional(
    Type.Object(
      {
        name: Type.Optional(Type.String({ description: "Job name" })),
        declarationKey: Type.Optional(
          Type.String({
            description: "Idempotent declaration key.",
            minLength: 1,
            maxLength: 200,
            pattern: "\\S",
          }),
        ),
        displayName: Type.Optional(
          Type.String({ description: "Human-readable declarative job label", maxLength: 200 }),
        ),
        owner: Type.Optional(
          Type.Object(
            {
              agentId: Type.Optional(Type.String()),
              sessionKey: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        schedule: createCronScheduleSchema(),
        trigger: createCronTriggerSchema({ nullableClears: false }),
        sessionTarget: Type.Optional(
          Type.String({
            description: "main | isolated | current | session:<id>",
          }),
        ),
        wakeMode: optionalStringEnum(CRON_WAKE_MODES, { description: "Wake timing" }),
        payload: createCronPayloadSchema(),
        delivery: createCronDeliverySchema(),
        agentId: nullableStringSchema("Agent id, or null to keep it unset"),
        description: Type.Optional(Type.String({ description: "Human description" })),
        enabled: Type.Optional(Type.Boolean()),
        deleteAfterRun: Type.Optional(Type.Boolean({ description: "Delete after first run" })),
        sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
        failureAlert: createCronFailureAlertSchema(),
      },
      { additionalProperties: true },
    ),
  );
}

function createCronPatchObjectSchema(): TSchema {
  return Type.Optional(
    Type.Object(
      {
        name: Type.Optional(Type.String({ description: "Job name" })),
        displayName: Type.Optional(
          Type.Union([Type.String({ maxLength: 200 }), Type.Null()], {
            description: "Human-readable label; null clears it",
          }),
        ),
        schedule: createCronScheduleSchema(),
        trigger: createCronTriggerSchema({ nullableClears: true }),
        sessionTarget: Type.Optional(Type.String({ description: "Session target" })),
        wakeMode: optionalStringEnum(CRON_WAKE_MODES),
        payload: Type.Optional(
          cronPayloadObjectSchema({
            model: nullableStringSchema("Model override, or null to clear"),
            toolsAllow: nullableStringArraySchema("Allowed tool ids, or null to clear"),
            fallbacks: nullableStringArraySchema("Fallback models, or null to clear"),
          }),
        ),
        delivery: createCronDeliveryPatchSchema(),
        description: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
        deleteAfterRun: Type.Optional(Type.Boolean()),
        agentId: nullableStringSchema("Agent id, or null to clear it"),
        sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
        failureAlert: createCronFailureAlertSchema(),
      },
      { additionalProperties: true },
    ),
  );
}

// Flattened schema: runtime validates per-action requirements.
function createCronToolSchema(): TSchema {
  return Type.Object(
    {
      action: stringEnum(CRON_ACTIONS),
      ...gatewayCallOptionSchemaProperties(),
      includeDisabled: Type.Optional(Type.Boolean()),
      job: createCronJobObjectSchema(),
      jobId: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      patch: createCronPatchObjectSchema(),
      text: Type.Optional(Type.String()),
      mode: optionalStringEnum(CRON_WAKE_MODES),
      runMode: optionalStringEnum(CRON_RUN_MODES, {
        description:
          'Run mode for action="run": omitted defaults to "due"; use "force" to trigger now.',
      }),
      contextMessages: Type.Optional(
        Type.Integer({ minimum: 0, maximum: REMINDER_CONTEXT_MESSAGES_MAX }),
      ),
      agentId: Type.Optional(
        Type.String({
          description:
            'List filter for `action: "list"`; wake target override for `action: "wake"` (defaults to the calling agent when omitted on wake)',
        }),
      ),
      sessionKey: Type.Optional(
        Type.String({
          description:
            'Wake target override for `action: "wake"`: route the event to another session owned by the calling agent. Defaults to the resolved calling-session key when omitted.',
        }),
      ),
    },
    { additionalProperties: true },
  );
}

type CronToolOptions = {
  agentSessionKey?: string;
  currentDeliveryContext?: DeliveryContext;
  /**
   * Effective tool surface visible to the caller that created or edited a cron job.
   * Isolated cron runs use a fresh session, so agent-origin jobs need this cap
   * persisted on agentTurn payloads before the original session policy is lost.
   */
  creatorToolAllowlist?: CronCreatorToolAllowlistEntry[];
  selfRemoveOnlyJobId?: string;
};

type CronToolCallerScope = {
  kind: "agentTool";
  agentId: string;
};

export type CronCreatorToolAllowlistEntry =
  | string
  | {
      name: string;
      pluginId?: string;
    };

type NormalizedCronCreatorTool = {
  name: string;
  pluginId?: string;
};

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

type GatewayToolCaller = typeof callGatewayTool;

type CronToolDeps = {
  callGatewayTool?: GatewayToolCaller;
};

type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

function stripExistingContext(text: string) {
  const index = text.indexOf(REMINDER_CONTEXT_MARKER);
  if (index === -1) {
    return text;
  }
  return text.slice(0, index).trim();
}

function assertNoCronShellExecution(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const payload = isRecord(value.payload) ? value.payload : undefined;
  if (normalizeLowercaseStringOrEmpty(payload?.kind) === "command") {
    throw new Error(
      "cron command payloads cannot be created or edited through the agent cron tool; use the CLI or Gateway API.",
    );
  }
  const schedule = isRecord(value.schedule) ? value.schedule : undefined;
  if (schedule?.kind === "on-exit") {
    throw new Error(
      "cron on-exit schedules cannot be created or edited through the agent cron tool; use the CLI or Gateway API.",
    );
  }
}

function normalizeCronToolsAllow(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of expandToolGroups([...values])) {
    const toolName = normalizeToolName(entry);
    if (!toolName || seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    normalized.push(toolName);
  }
  return normalized;
}

function normalizeCronCreatorToolsAllow(
  values: readonly CronCreatorToolAllowlistEntry[],
): NormalizedCronCreatorTool[] {
  const normalized: NormalizedCronCreatorTool[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const name = normalizeToolName(typeof entry === "string" ? entry : entry.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const pluginId =
      typeof entry === "string" || typeof entry.pluginId !== "string"
        ? undefined
        : normalizeToolName(entry.pluginId);
    normalized.push(pluginId ? { name, pluginId } : { name });
  }
  return normalized;
}

function cronCreatorToolNames(tools: readonly NormalizedCronCreatorTool[]): string[] {
  return tools.map((tool) => tool.name);
}

function capCronAgentTurnToolsAllow(params: {
  payload: Record<string, unknown>;
  creatorToolAllowlist: CronCreatorToolAllowlistEntry[];
  defaultToolsAllow?: unknown;
}): void {
  if (params.payload.kind !== "agentTurn") {
    return;
  }
  const creatorToolsAllow = normalizeCronCreatorToolsAllow(params.creatorToolAllowlist);
  const creatorToolNames = cronCreatorToolNames(creatorToolsAllow);
  const requestedRaw = Object.hasOwn(params.payload, "toolsAllow")
    ? params.payload.toolsAllow
    : params.defaultToolsAllow;
  if (!Array.isArray(requestedRaw)) {
    params.payload.toolsAllow = creatorToolNames;
    params.payload.toolsAllowIsDefault = true;
    return;
  }
  const requestedToolsAllow = normalizeCronToolsAllow(
    requestedRaw.filter((entry): entry is string => typeof entry === "string"),
  );
  if (requestedToolsAllow.length === 0) {
    params.payload.toolsAllow = [];
    delete params.payload.toolsAllowIsDefault;
    return;
  }
  if (requestedToolsAllow.includes("*")) {
    params.payload.toolsAllow = creatorToolNames;
    params.payload.toolsAllowIsDefault = true;
    return;
  }
  const pluginGroups = buildPluginToolGroups({
    tools: creatorToolsAllow,
    toolMeta: (tool) => (tool.pluginId ? { pluginId: tool.pluginId } : undefined),
  });
  const requestedPolicy = expandPolicyWithPluginGroups(
    { allow: requestedToolsAllow },
    pluginGroups,
  );
  params.payload.toolsAllow = creatorToolNames.filter((toolName) =>
    isToolAllowedByPolicyName(toolName, requestedPolicy),
  );
  delete params.payload.toolsAllowIsDefault;
}

function capCronAgentTurnJobToolsAllow(
  value: unknown,
  creatorToolAllowlist: CronCreatorToolAllowlistEntry[] | undefined,
): void {
  if (!creatorToolAllowlist || !isRecord(value) || !isRecord(value.payload)) {
    return;
  }
  capCronAgentTurnToolsAllow({ payload: value.payload, creatorToolAllowlist });
}

function readCronPayloadKind(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.kind === "string" ? value.kind : undefined;
}

async function capCronAgentTurnUpdatePatchToolsAllow(params: {
  id: string;
  patch: Record<string, unknown>;
  creatorToolAllowlist: CronCreatorToolAllowlistEntry[] | undefined;
  gatewayOpts: GatewayCallOptions;
  callGateway: GatewayToolCaller;
}): Promise<void> {
  if (!params.creatorToolAllowlist) {
    return;
  }
  const payload = isRecord(params.patch.payload) ? params.patch.payload : undefined;
  const patchPayloadKind = readCronPayloadKind(payload);
  const patchRequestsAgentTurn = patchPayloadKind === "agentTurn";
  if (patchPayloadKind === "agentTurn" && payload && Object.hasOwn(payload, "toolsAllow")) {
    capCronAgentTurnToolsAllow({
      payload,
      creatorToolAllowlist: params.creatorToolAllowlist,
    });
    return;
  }
  if (
    patchPayloadKind === "systemEvent" ||
    patchPayloadKind === "command" ||
    (patchPayloadKind && patchPayloadKind !== "agentTurn")
  ) {
    return;
  }

  const existing = await params.callGateway("cron.get", params.gatewayOpts, {
    id: params.id,
  });
  const existingPayload = isRecord(existing) ? existing.payload : undefined;
  const existingPayloadKind = readCronPayloadKind(existingPayload);
  if (!patchRequestsAgentTurn && existingPayloadKind !== "agentTurn") {
    return;
  }
  const nextPayload: Record<string, unknown> = payload ?? {};
  nextPayload.kind = "agentTurn";
  params.patch.payload = nextPayload;
  capCronAgentTurnToolsAllow({
    payload: nextPayload,
    creatorToolAllowlist: params.creatorToolAllowlist,
    // Flagged defaults are re-derived so normal updates do not turn them into
    // explicit restrictions or lose the marker needed after restart.
    defaultToolsAllow:
      existingPayloadKind === "agentTurn" &&
      isRecord(existingPayload) &&
      existingPayload.toolsAllowIsDefault !== true
        ? existingPayload.toolsAllow
        : undefined,
  });
}

function truncateText(input: string, maxLen: number) {
  if (input.length <= maxLen) {
    return input;
  }
  const truncated = truncateUtf16Safe(input, Math.max(0, maxLen - 3)).trimEnd();
  return `${truncated}...`;
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

function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = extractTextFromChatContent(message.content);
  return text ? { role, text } : null;
}

async function buildReminderContextLines(params: {
  agentSessionKey?: string;
  gatewayOpts: GatewayCallOptions;
  contextMessages: number;
  callGatewayTool: GatewayToolCaller;
}) {
  const maxMessages = Math.min(
    REMINDER_CONTEXT_MESSAGES_MAX,
    Math.max(0, Math.floor(params.contextMessages)),
  );
  if (maxMessages <= 0) {
    return [];
  }
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return [];
  }
  const cfg = getRuntimeConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const resolvedKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
  try {
    const res = await params.callGatewayTool<{ messages: Array<unknown> }>(
      "chat.history",
      params.gatewayOpts,
      {
        sessionKey: resolvedKey,
        limit: maxMessages,
      },
    );
    const messages = Array.isArray(res?.messages) ? res.messages : [];
    const parsed = messages
      .map((msg) => extractMessageText(msg as ChatMessage))
      .filter((msg): msg is { role: string; text: string } => Boolean(msg));
    const recent = parsed.slice(-maxMessages);
    if (recent.length === 0) {
      return [];
    }
    const lines: string[] = [];
    let total = 0;
    for (const entry of recent) {
      const label = entry.role === "user" ? "User" : "Assistant";
      const text = truncateText(entry.text, REMINDER_CONTEXT_PER_MESSAGE_MAX);
      const line = `- ${label}: ${text}`;
      total += line.length;
      if (total > REMINDER_CONTEXT_TOTAL_MAX) {
        break;
      }
      lines.push(line);
    }
    return lines;
  } catch {
    return [];
  }
}

export function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  const tool: AnyAgentTool = {
    label: "Cron",
    name: "cron",
    displaySummary: CRON_TOOL_DISPLAY_SUMMARY,
    description: `Gateway schedules/wakes: reminders, later checks/follow-ups, recurring work. Never exec sleep/process-poll as timer. Main job => heartbeat system event; isolated => background task in \`openclaw tasks\`.

ACTIONS:
- status scheduler; list compact summaries (includeDisabled, session agentId auto-filter; get for full); get jobId
- add job; update jobId+patch; remove jobId
- run jobId (due only; runMode="force" now); runs jobId history
- wake text (+ optional mode). Default caller lane; top-level sessionKey/agentId selects another caller-owned lane.

ADD JOB:
{ "name":"...", "schedule":{...}, "trigger":{ "script":"...", "once":false }, "payload":{...}, "delivery":{...}, "sessionTarget":"main|isolated|current|session:<id>", "enabled":true }
Required: schedule,payload. enabled default true. trigger only every/cron.

TARGET/PAYLOAD:
- main => systemEvent {kind:"systemEvent",text:"..."}; systemEvent defaults main.
- isolated/current/session:<id> => agentTurn {kind:"agentTurn",message:"...",model?,thinking?,timeoutSeconds?}; agentTurn defaults isolated. timeoutSeconds=0 means none.
- current binds caller session at creation. session:<id> is persistent. Prefer isolated unless user explicitly wants current binding.

SCHEDULE:
- at: {kind:"at",at:"ISO-8601"}; timezone-less = UTC.
- every: {kind:"every",everyMs:<ms>,anchorMs?}.
- cron: {kind:"cron",expr:"...",tz?:"IANA"}. Expr is requested local wall time; never pre-convert to UTC. Missing tz = Gateway host local, not UTC. Shanghai 18:00: {kind:"cron",expr:"0 18 * * *",tz:"Asia/Shanghai"}.

TRIGGER SCRIPT:
- Requires cron.triggers.enabled; if off, explain and never model-poll fallback.
- Headless owner allowlist; quiet check has no model. Prior trigger.state is frozen JSON. Return/json({fire:boolean,message?:string,state?:JSONValue}); create new state, never mutate prior.
- fire:false saves state only; no payload/history. fire:true runs payload and appends message; fired state saves only after payload success. Check reads; payload acts.
- Silent watcher: top-level delivery.mode="none". Omitted delivery on isolated agentTurn announces and missing route may fail.
- once:true disables after first successful fire. Per check: 30s, 5 tool calls, 16KB state.
- Hidden Code Mode tools: await tools.call("exec", {command:"..."}); unknown id => search/describe.

DELIVERY top-level: {mode:"none|announce|webhook",channel?,to?,threadId?,bestEffort?}
- Isolated agentTurn omitted delivery => announce. announce only isolated/current/session; channel/to optional; threadId chat topic. Specific chat: set channel/to; no messaging tool inside run.
- webhook posts finished-run event to URL in to.

Restricted isolated runs may only self status/list, current get/runs, and remove current job. wake mode: next-heartbeat default | now. jobId canonical; id compat. contextMessages 0-10 adds prior messages.`,
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
          ? { agentId: callerScope.agentId, sessionKey: opts.agentSessionKey.trim() }
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
            capCronAgentTurnJobToolsAllow(job, opts?.creatorToolAllowlist);
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
            await capCronAgentTurnUpdatePatchToolsAllow({
              id,
              patch,
              creatorToolAllowlist: opts?.creatorToolAllowlist,
              gatewayOpts,
              callGateway,
            });
            return jsonResult(
              await callGateway("cron.update", gatewayOpts, {
                id,
                patch,
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
