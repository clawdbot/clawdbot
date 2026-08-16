import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  clampDelayMs,
  resolveContinuationRuntimeConfig,
} from "../../auto-reply/continuation/config.js";
import { getContinuationDelegateQueueDepths } from "../../auto-reply/continuation/delegate-flow-store.js";
import { stagePostCompactionTaskFlowDelegate } from "../../auto-reply/continuation/delegate-store-post-compaction.js";
import {
  enqueuePendingDelegate,
  removeUnacceptedContinuationDelegate,
} from "../../auto-reply/continuation/delegate-store.js";
import {
  peekContinueDelegatesScheduledThisTurn,
  recordContinueDelegateScheduledThisTurn,
} from "../../auto-reply/continuation/delegate-turn-admission.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  hasCrossSessionDelegateTargeting,
  normalizeContinuationTargetKeys,
} from "../../auto-reply/continuation/targeting.js";
import type { PendingContinuationDelegate } from "../../auto-reply/continuation/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import { formatActiveContinuationTraceparent } from "../../infra/continuation-tracer.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import {
  MAX_INLINE_ATTACHMENT_MIME_TYPE_BYTES,
  MAX_INLINE_ATTACHMENT_MOUNT_PATH_BYTES,
  parseInlineAttachmentMountPath,
  type InlineAttachment,
  type InlineAttachmentMount,
} from "../../shared/inline-attachments.js";
import { prepareDelegateArtifactPolicy } from "../delegate-artifact-policy.js";
import { removeUnacceptedDelegateArtifactPolicy } from "../delegate-artifacts.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { validateSubagentAttachments } from "../subagents/spawn/subagent-attachments.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readNumberParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";

const log = createSubsystemLogger("continuation/delegate-tool");

const DELEGATE_MODES = ["normal", "silent", "silent-wake", "post-compaction"] as const;
const FANOUT_MODES = CONTINUATION_DELEGATE_FANOUT_MODES;

function isDelegateMode(value: string): value is (typeof DELEGATE_MODES)[number] {
  return DELEGATE_MODES.some((mode) => mode === value);
}

function isFanoutMode(value: string): value is (typeof FANOUT_MODES)[number] {
  return FANOUT_MODES.some((mode) => mode === value);
}

const ContinueDelegateToolSchema = Type.Object({
  task: Type.String({
    description:
      "The delegated sub-agent's task. Treat this like a letter to your future self: include scope, chunk/range, desired return shape, and what the parent should do with the result.",
    maxLength: 4096,
  }),
  delaySeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Seconds to wait before spawning the delegate. 0 or omitted = immediate. " +
        "Positive delays are clamped to continuation.minDelayMs / maxDelayMs from config.",
    }),
  ),
  mode: optionalStringEnum(DELEGATE_MODES, {
    description:
      'Return mode. "normal" = announces to channel (default). ' +
      '"silent" = result injected as internal context only, no channel echo; use for ambient enrichment and future recall. ' +
      '"silent-wake" = silent + triggers a new generation cycle so the agent can act on the enrichment immediately. ' +
      '"post-compaction" = silent-wake delegate that fires when compaction happens, not on a timer. ' +
      "Use for context evacuation: the shard starts at the moment of compaction and returns to the post-compaction session.",
  }),
  targetSessionKey: Type.Optional(
    Type.String({
      description:
        "Address one specific session on this host for the delegate's return. " +
        "Use when a child should return enrichment to an ancestor, sibling, or root session instead of the dispatching session.",
    }),
  ),
  targetSessionKeys: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Address multiple sessions on this host for byte-identical fan-out return. " +
        "Each listed session receives the same delegate completion payload through the session-delivery queue.",
    }),
  ),
  fanoutMode: optionalStringEnum(FANOUT_MODES, {
    description:
      'Broadcast return targeting. "tree" returns to every ancestor in the current continuation/subagent chain; ' +
      '"all" returns to every known session on this host. Do not combine with targetSessionKey/targetSessionKeys.',
  }),
  returnOptions: Type.Optional(
    Type.Object(
      {
        artifacts: Type.Optional(
          optionalStringEnum(["forbidden", "optional", "required"] as const),
        ),
      },
      {
        additionalProperties: false,
        description:
          "Managed return policy. Omitted or forbidden preserves ordinary text-only return.",
      },
    ),
  ),
  recipientContext: Type.Optional(
    Type.Object(
      {
        purpose: Type.String({ minLength: 1, maxLength: 1024 }),
      },
      {
        additionalProperties: false,
        description: "Contextual provenance for an artifact-capable inter-session recipient.",
      },
    ),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Optional provider/model override for the spawned delegate (e.g. github-copilot/claude-sonnet-4.6). " +
        'Omitted or "default" = inherit the parent session\'s model. ' +
        "Same form as sessions_spawn's model param.",
    }),
  ),
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        content: Type.String(),
        encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
        mimeType: Type.Optional(Type.String({ maxLength: MAX_INLINE_ATTACHMENT_MIME_TYPE_BYTES })),
      }),
      {
        maxItems: 50,
        description:
          "Inline snapshots mounted into the new child workspace. Uses the same limits and safety policy as sessions_spawn attachments.",
      },
    ),
  ),
  attachAs: Type.Optional(
    Type.Object(
      {
        mountPath: Type.Optional(
          Type.String({
            maxLength: MAX_INLINE_ATTACHMENT_MOUNT_PATH_BYTES,
            description:
              "Workspace-relative mount hint. The attachment receipt remains under the child workspace.",
          }),
        ),
      },
      { description: "Attachment mount options for the new child workspace." },
    ),
  ),
});

function readStrictStringArrayParam(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const raw = readSnakeCaseParamRaw(params, key);
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ToolInputError(`${key} must be an array of non-empty strings.`);
  }
  if (raw.length === 0) {
    return undefined;
  }
  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ToolInputError(`${key} must contain only non-empty strings.`);
    }
    values.push(entry.trim());
  }
  return normalizeContinuationTargetKeys(values);
}

function readInlineAttachmentsParam(
  params: Record<string, unknown>,
): InlineAttachment[] | undefined {
  const raw = readSnakeCaseParamRaw(params, "attachments");
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length > 50) {
    throw new ToolInputError("attachments must contain no more than 50 attachment objects.");
  }
  if (raw.length === 0) {
    return undefined;
  }
  return raw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ToolInputError(`attachments[${index}] must be an attachment object.`);
    }
    const record = entry;
    if (typeof record.name !== "string" || typeof record.content !== "string") {
      throw new ToolInputError(
        `attachments[${index}] must include string name and content fields.`,
      );
    }
    if (
      record.encoding !== undefined &&
      record.encoding !== "utf8" &&
      record.encoding !== "base64"
    ) {
      throw new ToolInputError(`attachments[${index}].encoding must be "utf8" or "base64".`);
    }
    if (record.mimeType !== undefined && typeof record.mimeType !== "string") {
      throw new ToolInputError(`attachments[${index}].mimeType must be a string.`);
    }
    const attachment: InlineAttachment = {
      name: record.name,
      content: record.content,
    };
    if (record.encoding) {
      attachment.encoding = record.encoding;
    }
    if (record.mimeType !== undefined) {
      attachment.mimeType = record.mimeType;
    }
    return attachment;
  });
}

function readAttachAsParam(params: Record<string, unknown>): InlineAttachmentMount | undefined {
  const raw = readSnakeCaseParamRaw(params, "attachAs");
  if (raw === undefined) {
    return undefined;
  }

  if (!isRecord(raw)) {
    throw new ToolInputError("attachAs must be an object.");
  }
  const record = raw;
  const keys = Object.keys(record);
  if (
    keys.some((key) => key !== "mountPath" && key !== "mount_path") ||
    (Object.hasOwn(record, "mountPath") && Object.hasOwn(record, "mount_path"))
  ) {
    throw new ToolInputError("attachAs must contain only one mountPath field.");
  }
  const mountPath = readSnakeCaseParamRaw(record, "mountPath");
  if (mountPath !== undefined && typeof mountPath !== "string") {
    throw new ToolInputError("attachAs.mountPath must be a string.");
  }
  const parsed = parseInlineAttachmentMountPath(mountPath);
  if (parsed.status === "invalid") {
    if (parsed.reason === "too_long") {
      throw new ToolInputError(
        `attachAs.mountPath invalid (reason=too_long maxMountPathBytes=${MAX_INLINE_ATTACHMENT_MOUNT_PATH_BYTES}).`,
      );
    }
    throw new ToolInputError(`attachAs.mountPath invalid (reason=${parsed.reason}).`);
  }
  return parsed.status === "valid" ? { mountPath: parsed.mountPath } : undefined;
}

function readArtifactReturnFields(params: Record<string, unknown>): {
  returnOptions?: { artifacts?: "forbidden" | "optional" | "required" };
  recipientContext?: { purpose: string };
} {
  if (Object.hasOwn(params, "returnOptions") && Object.hasOwn(params, "return_options")) {
    throw new ToolInputError("returnOptions and return_options cannot both be provided.");
  }
  const rawReturnOptions = readSnakeCaseParamRaw(params, "returnOptions");
  let artifacts: "forbidden" | "optional" | "required" | undefined;
  if (rawReturnOptions !== undefined) {
    if (!isRecord(rawReturnOptions)) {
      throw new ToolInputError("returnOptions must be an object.");
    }

    const record = rawReturnOptions;
    if (Object.keys(record).some((key) => key !== "artifacts")) {
      throw new ToolInputError("returnOptions contains unsupported fields.");
    }
    const rawArtifacts = record.artifacts;
    if (
      rawArtifacts !== undefined &&
      rawArtifacts !== "forbidden" &&
      rawArtifacts !== "optional" &&
      rawArtifacts !== "required"
    ) {
      throw new ToolInputError(
        'returnOptions.artifacts must be "forbidden", "optional", or "required".',
      );
    }
    artifacts = rawArtifacts;
  }

  if (Object.hasOwn(params, "recipientContext") && Object.hasOwn(params, "recipient_context")) {
    throw new ToolInputError("recipientContext and recipient_context cannot both be provided.");
  }
  const rawRecipientContext = readSnakeCaseParamRaw(params, "recipientContext");
  let purpose: string | undefined;
  if (rawRecipientContext !== undefined) {
    if (!isRecord(rawRecipientContext)) {
      throw new ToolInputError("recipientContext must be an object.");
    }
    const record = rawRecipientContext;
    if (Object.keys(record).some((key) => key !== "purpose")) {
      throw new ToolInputError("recipientContext contains unsupported fields.");
    }
    if (typeof record.purpose !== "string" || !record.purpose.trim()) {
      throw new ToolInputError("recipientContext.purpose must be a non-empty string.");
    }
    purpose = record.purpose.trim();
    if (
      Array.from(purpose).some((char) => {
        const code = char.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw new ToolInputError("recipientContext.purpose must not contain control characters.");
    }
    if (Buffer.byteLength(purpose, "utf8") > 1024) {
      throw new ToolInputError("recipientContext.purpose must be at most 1024 UTF-8 bytes.");
    }
  }
  return {
    ...(rawReturnOptions !== undefined ? { returnOptions: { artifacts } } : {}),
    ...(purpose ? { recipientContext: { purpose } } : {}),
  };
}

function prepareAcceptedDelegateArtifactPolicy(params: {
  flow: { flowId: string; revision: number } | null;
  cfg: ReturnType<typeof getRuntimeConfig>;
  config: ReturnType<typeof resolveContinuationRuntimeConfig>;
  dispatchingSessionKey: string;
  delegate: PendingContinuationDelegate;
  acceptedAt: number;
  prepareArtifactPolicy?: typeof prepareDelegateArtifactPolicy;
}): void {
  if (
    params.delegate.returnOptions?.artifacts !== "optional" &&
    params.delegate.returnOptions?.artifacts !== "required"
  ) {
    return;
  }
  if (!params.flow) {
    throw new ToolInputError("artifact-capable continuation dispatch could not be persisted.");
  }
  try {
    (params.prepareArtifactPolicy ?? prepareDelegateArtifactPolicy)({
      cfg: params.cfg,
      config: params.config,
      dispatchingSessionKey: params.dispatchingSessionKey,
      delegate: params.delegate,
      flowId: params.flow.flowId,
      dispatchRevision: params.flow.revision,
      acceptedAt: params.acceptedAt,
    });
  } catch {
    removeUnacceptedDelegateArtifactPolicy(params.flow.flowId);
    removeUnacceptedContinuationDelegate(params.flow.flowId);
    throw new ToolInputError("artifact-capable continuation dispatch could not be authorized.");
  }
}

/**
 * Creates the `continue_delegate` tool.
 *
 * This tool dispatches a sub-agent as a continuation delegate — tracked by the
 * gateway's continuation chain (cost caps, depth limits, chain counters).
 *
 * Architecture (Path A — side-channel):
 *   1. Tool writes to the module-level pending-delegate store during execution.
 *   2. After the agent's response finalizes, `agent-runner.ts` reads from the
 *      store and feeds delegates into the same scheduler that bracket-parsed
 *      `[[CONTINUE_DELEGATE:]]` signals use.
 *   3. Both paths (tool + brackets) converge at the same dispatch point —
 *      same cost cap, same chain depth, same delay clamping.
 *
 * The tool can be called multiple times per turn (multi-delegate fan-out).
 * Each call enqueues independently. No single-per-response regex limitation.
 *
 * No generation guard — per docs/design/continue-work-signal-v2.md,
 * unrelated inbound traffic does not cancel scheduled work.
 */
export function createContinueDelegateTool(opts: {
  agentSessionKey?: string;
  prepareArtifactPolicy?: typeof prepareDelegateArtifactPolicy;
}): AnyAgentTool {
  return {
    label: "Continuation",
    name: "continue_delegate",
    description: [
      "Fire a background sub-agent that runs now, later, or at compaction, then returns visibly or silently.",
      "Reach for this when you'd otherwise fan out parallel exec calls for independent investigations, sleep+poll in exec, or relay a hand-off through the parent — the gateway handles timing, chain-tracking, and delivery.",
      "Call multiple times in one turn for parallel fan-out; the main session stays free.",
      'Use mode="silent-wake" for ambient enrichment that quietly returns to context and wakes you to act on it.',
      'Use mode="post-compaction" to stage working-state survival across the compaction seam (lich-protocol phylactery shape — what survives is what you elect to carry).',
      "Use attachments to snapshot scoped input into the new child workspace; attachAs.mountPath is a mount hint.",
      "Return targeting: default returns to the dispatching session; targetSessionKey returns to one other session; targetSessionKeys returns byte-identical enrichment to multiple sessions; fanoutMode=tree returns to all ancestors in the chain; fanoutMode=all returns to all known sessions on this host.",
      "Use fanoutMode for distribution across comms channel between sessions that can be dispatched of delegates at low cost to this session.",
    ].join(" "),
    parameters: ContinueDelegateToolSchema,
    execute: async (_toolCallId, args) => {
      if (!isRecord(args)) {
        throw new ToolInputError("continue_delegate arguments must be an object.");
      }
      const params = args;
      const sessionKey = opts.agentSessionKey;

      if (!sessionKey) {
        throw new ToolInputError(
          "continue_delegate requires an active session. Not available in sessionless contexts.",
        );
      }

      const task = readToolStringParam(params, "task", { required: true });
      if (!task.trim()) {
        throw new ToolInputError("task must be a non-empty string describing the delegated work.");
      }
      const attachments = readInlineAttachmentsParam(params);
      const requestedAttachAs = readAttachAsParam(params);
      const attachAs = attachments ? requestedAttachAs : undefined;
      const runtimeConfig = getRuntimeConfig();
      const attachmentValidationError = validateSubagentAttachments({
        config: runtimeConfig,
        attachments,
        redactContinuationErrorDetails: true,
      });
      if (attachmentValidationError) {
        throw new ToolInputError(attachmentValidationError);
      }
      const attachmentFields = {
        ...(attachments ? { attachments } : {}),
        ...(attachments && attachAs ? { attachAs } : {}),
      };

      const delaySeconds = readNumberParam(params, "delaySeconds");
      const requestedDelayMs =
        delaySeconds !== undefined ? Math.max(0, delaySeconds) * 1000 : undefined;

      const modeRaw = typeof params.mode === "string" ? params.mode.trim().toLowerCase() : "";
      if (modeRaw && !isDelegateMode(modeRaw)) {
        throw new ToolInputError(
          `Unknown mode "${modeRaw}". Valid modes: ${DELEGATE_MODES.join(", ")}`,
        );
      }
      const mode = modeRaw && isDelegateMode(modeRaw) ? modeRaw : "normal";
      const isPostCompaction = mode === "post-compaction";
      const targetSessionKey = readToolStringParam(params, "targetSessionKey");
      const targetSessionKeys = readStrictStringArrayParam(params, "targetSessionKeys");
      const fanoutModeRaw = readToolStringParam(params, "fanoutMode");
      const fanoutMode = fanoutModeRaw?.toLowerCase();
      if (fanoutMode && !isFanoutMode(fanoutMode)) {
        throw new ToolInputError(
          `Unknown fanoutMode "${fanoutMode}". Valid fanout modes: ${FANOUT_MODES.join(", ")}`,
        );
      }
      if (fanoutMode && (targetSessionKey || (targetSessionKeys && targetSessionKeys.length > 0))) {
        throw new ToolInputError(
          "fanoutMode cannot be combined with targetSessionKey or targetSessionKeys. " +
            "For a targeted return, use targetSessionKey or targetSessionKeys and omit fanoutMode. " +
            "For tree/all fanout, use fanoutMode and omit explicit target keys.",
        );
      }
      const targetingFields = {
        ...(targetSessionKey ? { targetSessionKey } : {}),
        ...(targetSessionKeys && targetSessionKeys.length > 0 ? { targetSessionKeys } : {}),
        ...(fanoutMode && isFanoutMode(fanoutMode) ? { fanoutMode } : {}),
      };
      const artifactReturnFields = readArtifactReturnFields(params);
      const artifactMode = artifactReturnFields.returnOptions?.artifacts ?? "forbidden";
      if (artifactMode === "forbidden" && artifactReturnFields.recipientContext) {
        throw new ToolInputError(
          "recipientContext is only valid when managed artifact returns are optional or required.",
        );
      }
      // Trace context is runtime-owned. Ignore hidden/raw `traceparent` input
      // just like the public schema does, and capture only the active context.
      const traceparent = formatActiveContinuationTraceparent();
      const traceContextFields = traceparent ? { traceparent } : {};

      const modelOverride = normalizeToolModelOverride(readToolStringParam(params, "model"));
      const modelField = modelOverride ? { model: modelOverride } : {};

      const continuationConfig = resolveContinuationRuntimeConfig(runtimeConfig);
      const delayMs =
        requestedDelayMs !== undefined && requestedDelayMs > 0
          ? clampDelayMs(requestedDelayMs, continuationConfig)
          : requestedDelayMs;
      const hasCrossSessionTargeting = hasCrossSessionDelegateTargeting(
        targetingFields,
        sessionKey,
      );
      if (continuationConfig.crossSessionTargeting === "disabled" && hasCrossSessionTargeting) {
        throw new ToolInputError(
          "cross-session continuation targeting is disabled by agents.defaults.continuation.crossSessionTargeting. " +
            'Use the default return target, targetSessionKey set to this session, or fanoutMode="tree".',
        );
      }
      if (
        artifactMode !== "forbidden" &&
        hasCrossSessionTargeting &&
        !artifactReturnFields.recipientContext
      ) {
        throw new ToolInputError(
          "recipientContext.purpose is required for artifact-capable inter-session returns.",
        );
      }

      // Check per-turn delegate limit. The budget is keyed by session and reset
      // at each assistant-turn boundary (delegate-turn-admission), so a later
      // turn in the same run gets a fresh cap instead of inheriting this turn's
      // count. Durable queued depth is reported for visibility but does not
      // consume this turn's admission budget.
      const maxPerTurn = continuationConfig.maxDelegatesPerTurn;
      const delegatesThisTurn = peekContinueDelegatesScheduledThisTurn(sessionKey);
      if (delegatesThisTurn >= maxPerTurn) {
        const queueDepths = getContinuationDelegateQueueDepths(sessionKey);
        return jsonResult({
          status: "rejected",
          guard: "maxDelegatesPerTurn",
          reason: `would exceed maxDelegatesPerTurn cap (${delegatesThisTurn}/${maxPerTurn} already scheduled this turn)`,
          delegatesThisTurn,
          limit: maxPerTurn,
          queuedDelegateDepth: queueDepths.totalQueued,
          pendingQueuedDelegates: queueDepths.pendingQueued,
          runnablePendingDelegates: queueDepths.pendingRunnable,
          scheduledPendingDelegates: queueDepths.pendingScheduled,
          stagedPostCompactionDelegates: queueDepths.stagedPostCompaction,
        });
      }

      if (isPostCompaction) {
        const acceptedAt = Date.now();
        const delegate: PendingContinuationDelegate = {
          task,
          mode: "post-compaction",
          firstArmedAt: acceptedAt,
          ...attachmentFields,
          ...targetingFields,
          ...artifactReturnFields,
          ...traceContextFields,
          ...modelField,
        };
        const flow = stagePostCompactionTaskFlowDelegate(sessionKey, {
          ...delegate,
          stagedAt: acceptedAt,
        });
        prepareAcceptedDelegateArtifactPolicy({
          flow,
          cfg: runtimeConfig,
          config: continuationConfig,
          dispatchingSessionKey: sessionKey,
          delegate,
          acceptedAt,
          prepareArtifactPolicy: opts.prepareArtifactPolicy,
        });
        const scheduledThisTurn = recordContinueDelegateScheduledThisTurn(sessionKey);

        return jsonResult({
          status: "queued-for-compaction",
          mode: "post-compaction",
          delegateIndex: scheduledThisTurn,
          delegatesThisTurn: scheduledThisTurn,
          ...(attachments ? { attachmentCount: attachments.length } : {}),
          ...(attachAs ? { attachAs } : {}),
          ...targetingFields,
          ...modelField,
          note:
            "Delegate will fire when compaction occurs, not on a timer. " +
            "The shard starts at the moment of compaction and returns to the post-compaction session. " +
            "Chain tracking applies at dispatch time.",
        });
      }

      log.debug(
        `[continue_delegate:enqueue] session=${sessionKey} mode=${mode} delayMs=${delayMs} fanoutMode=${fanoutMode ?? "none"} targets=${targetSessionKeys?.length ?? (targetSessionKey ? 1 : 0)} task=${task.slice(0, 80)}`,
      );
      const acceptedAt = Date.now();
      const delegate: PendingContinuationDelegate = {
        task,
        delayMs,
        ...(artifactMode !== "forbidden" ? { firstArmedAt: acceptedAt } : {}),
        ...(mode !== "normal" ? { mode } : {}),
        ...attachmentFields,
        ...targetingFields,
        ...artifactReturnFields,
        ...traceContextFields,
        ...modelField,
      };
      const flow = enqueuePendingDelegate(sessionKey, delegate);
      prepareAcceptedDelegateArtifactPolicy({
        flow,
        cfg: runtimeConfig,
        config: continuationConfig,
        dispatchingSessionKey: sessionKey,
        delegate,
        acceptedAt,
        prepareArtifactPolicy: opts.prepareArtifactPolicy,
      });

      const dispatchIndex = recordContinueDelegateScheduledThisTurn(sessionKey);

      return jsonResult({
        status: "scheduled",
        mode: modeRaw || "normal",
        delaySeconds: delayMs ? delayMs / 1000 : 0,
        delegateIndex: dispatchIndex,
        delegatesThisTurn: dispatchIndex,
        ...(attachments ? { attachmentCount: attachments.length } : {}),
        ...(attachAs ? { attachAs } : {}),
        ...targetingFields,
        ...modelField,
        note:
          "Delegate will be dispatched after your response completes. " +
          "Chain tracking (cost cap, depth limit) applies.",
      });
    },
  };
}
