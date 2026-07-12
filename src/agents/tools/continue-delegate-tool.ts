import { Type } from "typebox";
import {
  clampDelayMs,
  resolveContinuationRuntimeConfig,
} from "../../auto-reply/continuation/config.js";
import {
  enqueuePendingDelegate,
  getContinuationDelegateQueueDepths,
  stagePostCompactionDelegate,
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
import { formatActiveContinuationTraceparent } from "../../infra/continuation-tracer.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";

const log = createSubsystemLogger("continuation/delegate-tool");

const DELEGATE_MODES = ["normal", "silent", "silent-wake", "post-compaction"] as const;
const FANOUT_MODES = CONTINUATION_DELEGATE_FANOUT_MODES;

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
  model: Type.Optional(
    Type.String({
      description:
        "Optional provider/model override for the spawned delegate (e.g. github-copilot/claude-sonnet-4.6). " +
        'Omitted or "default" = inherit the parent session\'s model. ' +
        "Same form as sessions_spawn's model param.",
    }),
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
export function createContinueDelegateTool(opts: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Continuation",
    name: "continue_delegate",
    description: [
      "Fire a background sub-agent that runs now, later, or at compaction, then returns visibly or silently.",
      "Reach for this when you'd otherwise fan out parallel exec calls for independent investigations, sleep+poll in exec, or relay a hand-off through the parent — the gateway handles timing, chain-tracking, and delivery.",
      "Call multiple times in one turn for parallel fan-out; the main session stays free.",
      'Use mode="silent-wake" for ambient enrichment that quietly returns to context and wakes you to act on it.',
      'Use mode="post-compaction" to stage working-state survival across the compaction seam (lich-protocol phylactery shape — what survives is what you elect to carry).',
      "Return targeting: default returns to the dispatching session; targetSessionKey returns to one other session; targetSessionKeys returns byte-identical enrichment to multiple sessions; fanoutMode=tree returns to all ancestors in the chain; fanoutMode=all returns to all known sessions on this host.",
      "Use fanoutMode for distribution across comms channel between sessions that can be dispatched of delegates at low cost to this session.",
    ].join(" "),
    parameters: ContinueDelegateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts.agentSessionKey;

      if (!sessionKey) {
        throw new ToolInputError(
          "continue_delegate requires an active session. Not available in sessionless contexts.",
        );
      }

      const task = readStringParam(params, "task", { required: true });
      if (!task.trim()) {
        throw new ToolInputError("task must be a non-empty string describing the delegated work.");
      }

      const delaySeconds = readNumberParam(params, "delaySeconds");
      const requestedDelayMs =
        delaySeconds !== undefined ? Math.max(0, delaySeconds) * 1000 : undefined;

      const modeRaw = typeof params.mode === "string" ? params.mode.trim().toLowerCase() : "";
      if (modeRaw && !DELEGATE_MODES.includes(modeRaw as (typeof DELEGATE_MODES)[number])) {
        throw new ToolInputError(
          `Unknown mode "${modeRaw}". Valid modes: ${DELEGATE_MODES.join(", ")}`,
        );
      }
      const mode = (modeRaw || "normal") as (typeof DELEGATE_MODES)[number];
      const isPostCompaction = mode === "post-compaction";
      const targetSessionKey = readStringParam(params, "targetSessionKey");
      const targetSessionKeys = readStrictStringArrayParam(params, "targetSessionKeys");
      const fanoutModeRaw = readStringParam(params, "fanoutMode");
      const fanoutMode = fanoutModeRaw?.toLowerCase();
      if (fanoutMode && !FANOUT_MODES.includes(fanoutMode as (typeof FANOUT_MODES)[number])) {
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
        ...(fanoutMode ? { fanoutMode: fanoutMode as (typeof FANOUT_MODES)[number] } : {}),
      };
      // Trace context is runtime-owned. Ignore hidden/raw `traceparent` input
      // just like the public schema does, and capture only the active context.
      const traceparent = formatActiveContinuationTraceparent();
      const traceContextFields = traceparent ? { traceparent } : {};

      const modelOverride = normalizeToolModelOverride(readStringParam(params, "model"));
      const modelField = modelOverride ? { model: modelOverride } : {};

      const continuationConfig = resolveContinuationRuntimeConfig();
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
        stagePostCompactionDelegate(sessionKey, {
          task,
          stagedAt: Date.now(),
          ...targetingFields,
          ...traceContextFields,
          ...modelField,
        });
        const scheduledThisTurn = recordContinueDelegateScheduledThisTurn(sessionKey);

        return jsonResult({
          status: "queued-for-compaction",
          mode: "post-compaction",
          delegateIndex: scheduledThisTurn,
          delegatesThisTurn: scheduledThisTurn,
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
      enqueuePendingDelegate(sessionKey, {
        task,
        delayMs,
        ...(mode !== "normal" ? { mode } : {}),
        ...targetingFields,
        ...traceContextFields,
        ...modelField,
      });

      const dispatchIndex = recordContinueDelegateScheduledThisTurn(sessionKey);

      return jsonResult({
        status: "scheduled",
        mode: modeRaw || "normal",
        delaySeconds: delayMs ? delayMs / 1000 : 0,
        delegateIndex: dispatchIndex,
        delegatesThisTurn: dispatchIndex,
        ...targetingFields,
        ...modelField,
        note:
          "Delegate will be dispatched after your response completes. " +
          "Chain tracking (cost cap, depth limit) applies.",
      });
    },
  };
}
