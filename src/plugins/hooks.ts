/**
 * Plugin Hook Runner
 *
 * Provides utilities for executing plugin lifecycle hooks with proper
 * error handling and priority ordering.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  expandToolGroups,
  normalizeToolList,
  normalizeToolPolicyName,
  readToolAllowlistIntersection,
} from "../agents/tool-policy.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { formatHookErrorForLog } from "../hooks/fire-and-forget.js";
import { formatErrorMessage } from "../infra/errors.js";
import { concatOptionalTextSegments } from "../shared/text/join-segments.js";
import {
  type GateHookResult,
  type InputGateDecision,
  isHookDecision,
} from "./hook-decision-types.js";
import { cloneHookIsolationValue, HookIsolationError } from "./hook-isolation.js";
import type { GlobalHookRunnerRegistry, HookRunnerRegistry } from "./hook-registry.types.js";
import type {
  PluginHookAfterCompactionEvent,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentTrigger,
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
  PluginHookBeforeAgentReplyEvent,
  PluginHookBeforeAgentReplyResult,
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
  PluginHookBeforeDispatchResult,
  PluginHookHandlerMap,
  PluginHookReplyPayloadSendingContext,
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
  PluginHookReplyPayload,
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeCompactionEvent,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookBeforeResetEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginAgentTurnPrepareEvent,
  PluginAgentTurnPrepareResult,
  PluginHeartbeatPromptContributionEvent,
  PluginHeartbeatPromptContributionResult,
  PluginHookBeforeAgentRunEvent,
  PluginHookCronReconciledContext,
  PluginHookCronReconciledEvent,
  PluginHookCronChangedEvent,
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
  PluginHookName,
  PluginHookRegistration,
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
  PluginHookSubagentContext,
  PluginHookSubagentDeliveryTargetEvent,
  PluginHookSubagentDeliveryTargetResult,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentSpawningResult,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentProgressEvent,
  PluginHookSubagentSpawnedEvent,
  PluginHookToolContext,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
  PluginHookBeforeInstallContext,
  PluginHookBeforeInstallEvent,
  PluginHookBeforeInstallResult,
  PluginHookResolveExecEnvContext,
  PluginHookResolveExecEnvEvent,
  PluginHookSkillChangedEvent,
  PluginHookSkillContext,
  PluginHookSkillProposalChangedEvent,
  PluginHookSkillProposalEvaluateEvent,
  PluginHookSkillProposalEvaluateResult,
  PluginHookSkillProposalEvaluationOutcome,
} from "./hook-types.js";
import {
  type PluginSubagentRequesterContext,
  withPluginSubagentRequesterContext,
} from "./runtime/subagent-requester-context.js";
import {
  createPluginToolMatcherScope,
  pluginToolMatcherCoversTool,
  type PluginToolMatcherScope,
} from "./tool-hook-matcher.js";

// Re-export types for consumers

type HookRunnerLogger = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type HookFailurePolicy = "fail-open" | "fail-closed";
export type VoidHookRunOptions = {
  unrefTimeout?: boolean;
};

type BeforeAgentFinalizeRetry = NonNullable<PluginHookBeforeAgentFinalizeResult["retry"]>;
type BeforeAgentFinalizeResultWithRetryCandidates = PluginHookBeforeAgentFinalizeResult & {
  retryCandidates?: BeforeAgentFinalizeRetry[];
};

type HookRunnerOptions = {
  logger?: HookRunnerLogger;
  /** If true, errors in hooks will be caught and logged instead of thrown */
  catchErrors?: boolean;
  /**
   * Optional per-hook failure policy.
   * Defaults to fail-open unless explicitly overridden for a hook name.
   */
  failurePolicyByHook?: Partial<Record<PluginHookName, HookFailurePolicy>>;
  /**
   * Optional timeout for void/observation hooks. A timed-out hook is logged and
   * the runner continues, but the plugin's underlying work is not cancelled.
   */
  voidHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
  /**
   * Optional timeout for modifying hooks. A timed-out hook is logged and skipped,
   * but the plugin's underlying work is not cancelled.
   */
  modifyingHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
};

const DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  agent_end: 30_000,
  channel_pairing_requested: 2_000,
  // Defensive default for the compaction lifecycle hooks. Without a budget an
  // unresponsive handler runs fully unbounded, and in the codex agent harness
  // these hooks fire on the serialized notification queue
  // (event-projector handleItemStarted awaits before_compaction / after_compaction
  // for a contextCompaction item), so a hung handler freezes every later codex
  // notification — including turn/completed — and the whole turn hangs. These
  // hooks can legitimately do real work (e.g. a memory flush), so the budget
  // matches agent_end's 30s rather than the tighter modifying-hook defaults.
  // The runner is fail-open for void hooks, so a timed-out handler is logged
  // and compaction proceeds.
  before_compaction: 30_000,
  after_compaction: 30_000,
  skill_changed: 30_000,
  skill_proposal_changed: 30_000,
  // Shutdown hooks share the Gateway's five-second teardown budget. They fail
  // open after logging so one plugin cannot consume the process watchdog.
  gateway_stop: 5_000,
};
const DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  before_agent_run: 15_000,
  // Policy hooks fail closed in the global runner. A bounded timeout turns a
  // stalled policy process into a denial instead of freezing the operation.
  before_install: 15_000,
  before_tool_call: 15_000,
  // Terminal finalization hooks sit on the runner's completion path. A hung
  // handler must not freeze final delivery or keep compaction retry recovery
  // unresolved; timeout fail-opens with the original final answer.
  before_agent_finalize: 15_000,
  before_prompt_build: 15_000,
  // Outbound modifying hooks run inside the serialized reply delivery lane.
  // A hung plugin must fail open so later hooks and queued replies can settle.
  message_sending: 15_000,
  reply_payload_sending: 15_000,
  resolve_exec_env: 15_000,
  skill_proposal_evaluate: 120_000,
};

function deepFreezeHookValue<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);
  for (const child of Object.values(object)) {
    deepFreezeHookValue(child, seen);
  }
  return Object.freeze(value);
}

type ModifyingHookPolicy<K extends PluginHookName, TResult> = {
  mergeResults?: (
    accumulated: TResult | undefined,
    next: TResult,
    registration: PluginHookRegistration<K>,
  ) => TResult;
  isolateEventPerHandler?: boolean;
  mergeNullResults?: boolean;
  shouldStop?: (result: TResult) => boolean;
  terminalLabel?: string;
  onTerminal?: (params: { hookName: K; pluginId: string; result: TResult }) => void;
};

type PluginTargetedInboundClaimOutcome =
  | {
      status: "handled";
      result: PluginHookInboundClaimResult;
    }
  | {
      status: "missing_plugin";
    }
  | {
      status: "no_handler";
    }
  | {
      status: "declined";
    }
  | {
      status: "error";
      error: string;
    };

type SyncHookName = "tool_result_persist" | "before_message_write";
type SyncHookHandler<K extends SyncHookName> = NonNullable<PluginHookRegistration<K>["handler"]>;
type SyncHookEvent<K extends SyncHookName> = Parameters<SyncHookHandler<K>>[0];
type SyncHookContext<K extends SyncHookName> = Parameters<SyncHookHandler<K>>[1];
type SyncHookResult<K extends SyncHookName> = ReturnType<SyncHookHandler<K>>;

/**
 * Get hooks for a specific hook name, sorted by priority (higher first).
 */
function getHooksForName<K extends PluginHookName>(
  registry: HookRunnerRegistry,
  hookName: K,
  ctx?: unknown,
  toolName?: string,
): PluginHookRegistration<K>[] {
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((hook) => {
      if (hook.hookName !== hookName) {
        return false;
      }
      if (hookName !== "before_agent_reply" || hook.eligibleTriggers === undefined) {
        return true;
      }
      const trigger =
        typeof ctx === "object" && ctx !== null && "trigger" in ctx
          ? (ctx as { trigger?: unknown }).trigger
          : undefined;
      return (
        typeof trigger === "string" &&
        hook.eligibleTriggers.includes(trigger as PluginHookAgentTrigger)
      );
    })
    .filter((hook) => toolName === undefined || pluginToolMatcherCoversTool(hook.matcher, toolName))
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function getToolHookMatcherScope(
  registry: HookRunnerRegistry,
  hookName: "before_tool_call" | "after_tool_call",
): PluginToolMatcherScope | undefined {
  return createPluginToolMatcherScope(
    getHooksForName(registry, hookName).map((registration) => registration.matcher),
  );
}

function getHooksForNameAndPlugin<K extends PluginHookName>(
  registry: HookRunnerRegistry,
  hookName: K,
  pluginId: string,
): PluginHookRegistration<K>[] {
  return getHooksForName(registry, hookName).filter((hook) => hook.pluginId === pluginId);
}

/**
 * Create a hook runner for a specific registry.
 */
export function createHookRunner(
  registry: GlobalHookRunnerRegistry,
  options: HookRunnerOptions = {},
) {
  const logger = options.logger;
  const catchErrors = options.catchErrors ?? true;
  const failurePolicyByHook = {
    before_agent_run: "fail-closed",
    ...options.failurePolicyByHook,
  } satisfies Partial<Record<PluginHookName, HookFailurePolicy>>;
  const voidHookTimeoutMsByHook = {
    ...DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK,
    ...options.voidHookTimeoutMsByHook,
  };
  const modifyingHookTimeoutMsByHook = {
    ...DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK,
    ...options.modifyingHookTimeoutMsByHook,
  };
  // Prompt-build hooks may start nested agent runs through any caller. The
  // mutable token lets detached descendants dispatch after the outer run settles.
  const beforePromptBuildDispatch = new AsyncLocalStorage<{ active: boolean }>();

  const shouldCatchHookErrors = (hookName: PluginHookName): boolean =>
    catchErrors && (failurePolicyByHook[hookName] ?? "fail-open") === "fail-open";

  const firstDefined = <T>(prev: T | undefined, next: T | undefined): T | undefined => prev ?? next;
  const lastDefined = <T>(prev: T | undefined, next: T | undefined): T | undefined => next ?? prev;
  const stickyTrue = (prev?: boolean, next?: boolean): true | undefined =>
    prev === true || next === true ? true : undefined;
  const toPluginReplyPayload = (payload: ReplyPayload): PluginHookReplyPayload => {
    const { trustedLocalMedia: _trustedLocalMedia, ...visiblePayload } = payload;
    return structuredClone(visiblePayload);
  };
  const areMediaUrlArraysEqual = (
    left: readonly string[] | undefined,
    right: readonly string[] | undefined,
  ): boolean => {
    const normalizedLeft = left ?? [];
    const normalizedRight = right ?? [];
    return (
      normalizedLeft.length === normalizedRight.length &&
      normalizedLeft.every((value, index) => value === normalizedRight[index])
    );
  };
  const preservesTrustedMediaRefs = (
    previous: ReplyPayload,
    next: PluginHookReplyPayload,
  ): boolean => {
    return (
      previous.trustedLocalMedia === true &&
      previous.mediaUrl === next.mediaUrl &&
      areMediaUrlArraysEqual(previous.mediaUrls, next.mediaUrls)
    );
  };
  const acceptPluginReplyPayload = (
    previous: ReplyPayload,
    next: PluginHookReplyPayload,
  ): ReplyPayload => {
    const { trustedLocalMedia: _trustedLocalMedia, ...safePayload } = next as ReplyPayload;
    const clonedPayload = structuredClone(safePayload);
    const acceptedPayload = preservesTrustedMediaRefs(previous, clonedPayload)
      ? { ...clonedPayload, trustedLocalMedia: true }
      : clonedPayload;
    return copyReplyPayloadMetadata(previous, acceptedPayload);
  };

  const mergeBeforeModelResolve = (
    acc: PluginHookBeforeModelResolveResult | undefined,
    next: PluginHookBeforeModelResolveResult,
  ): PluginHookBeforeModelResolveResult => ({
    // Keep the first defined override so higher-priority hooks win.
    modelOverride: firstDefined(acc?.modelOverride, next.modelOverride),
    providerOverride: firstDefined(acc?.providerOverride, next.providerOverride),
  });

  const normalizeHookToolsAllow = (value: unknown): string[] | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      return [];
    }
    if (value.some((entry) => typeof entry !== "string")) {
      return [];
    }
    return value as string[];
  };

  const readHookToolsAllowRestrictions = (value: unknown): string[][] => {
    const normalized = normalizeHookToolsAllow(value);
    if (normalized === undefined) {
      return [];
    }
    const attached = Array.isArray(value) ? readToolAllowlistIntersection(value) : undefined;
    return attached
      ? attached.map((restriction) => normalizeHookToolsAllow(restriction) ?? [])
      : [normalized];
  };

  const intersectToolsAllow = (left: string[] | undefined, right: string[]): string[] => {
    if (left === undefined) {
      return right;
    }
    if (left.length === 0 || right.length === 0) {
      return [];
    }
    const normalizedLeft = normalizeToolList(expandToolGroups(left));
    const normalizedRight = normalizeToolList(expandToolGroups(right));
    if (normalizedLeft.includes("*")) {
      return normalizedRight;
    }
    if (normalizedRight.includes("*")) {
      return normalizedLeft;
    }
    return [...new Set(normalizeToolList([...normalizedLeft, ...normalizedRight]))].filter(
      (name) => {
        const normalized = normalizeToolPolicyName(name);
        return (
          isToolAllowedByPolicyName(normalized, { allow: normalizedLeft }) &&
          isToolAllowedByPolicyName(normalized, { allow: normalizedRight })
        );
      },
    );
  };

  const mergeBeforePromptBuild = (
    acc: PluginHookBeforePromptBuildResult | undefined,
    next: PluginHookBeforePromptBuildResult,
  ): PluginHookBeforePromptBuildResult => {
    const toolRestrictions = [
      ...readHookToolsAllowRestrictions(acc?.toolsAllow),
      ...readHookToolsAllowRestrictions(next.toolsAllow),
    ];
    const toolsAllow =
      toolRestrictions.length === 0
        ? undefined
        : attachToolAllowlistIntersection(
            [
              ...(toolRestrictions.reduce<string[] | undefined>(intersectToolsAllow, undefined) ??
                []),
            ],
            toolRestrictions,
          );
    return {
      // Keep the first defined system prompt so higher-priority hooks win.
      systemPrompt: firstDefined(acc?.systemPrompt, next.systemPrompt),
      prependContext: concatOptionalTextSegments({
        left: acc?.prependContext,
        right: next.prependContext,
      }),
      appendContext: concatOptionalTextSegments({
        left: acc?.appendContext,
        right: next.appendContext,
      }),
      ...(toolsAllow !== undefined ? { toolsAllow } : {}),
      prependSystemContext: concatOptionalTextSegments({
        left: acc?.prependSystemContext,
        right: next.prependSystemContext,
      }),
      appendSystemContext: concatOptionalTextSegments({
        left: acc?.appendSystemContext,
        right: next.appendSystemContext,
      }),
    };
  };

  const mergeAgentTurnPrepare = <
    TResult extends { prependContext?: string; appendContext?: string },
  >(
    acc: TResult | undefined,
    next: TResult,
  ): TResult =>
    ({
      prependContext: concatOptionalTextSegments({
        left: acc?.prependContext,
        right: next.prependContext,
      }),
      appendContext: concatOptionalTextSegments({
        left: acc?.appendContext,
        right: next.appendContext,
      }),
    }) as TResult;

  const mergeBeforeAgentFinalize = (
    acc: PluginHookBeforeAgentFinalizeResult | undefined,
    next: PluginHookBeforeAgentFinalizeResult,
  ): PluginHookBeforeAgentFinalizeResult => {
    const normalizeRetry = (
      retry: PluginHookBeforeAgentFinalizeResult["retry"] | undefined,
    ): BeforeAgentFinalizeRetry | undefined => {
      const instruction = typeof retry?.instruction === "string" ? retry.instruction.trim() : "";
      if (!instruction) {
        return undefined;
      }
      return {
        ...retry,
        instruction,
      };
    };
    const readRetryCandidates = (
      result: PluginHookBeforeAgentFinalizeResult | undefined,
    ): BeforeAgentFinalizeRetry[] => {
      if (!result || result.action !== "revise") {
        return [];
      }
      const candidateList = (result as BeforeAgentFinalizeResultWithRetryCandidates)
        .retryCandidates;
      if (Array.isArray(candidateList) && candidateList.length > 0) {
        return candidateList
          .map((retry) => normalizeRetry(retry))
          .filter((retry): retry is BeforeAgentFinalizeRetry => retry !== undefined);
      }
      const retry = normalizeRetry(result.retry);
      return retry ? [retry] : [];
    };
    const attachRetryCandidates = (
      result: PluginHookBeforeAgentFinalizeResult,
      candidates: BeforeAgentFinalizeRetry[],
    ): PluginHookBeforeAgentFinalizeResult => {
      if (result.action !== "revise" || candidates.length <= 1) {
        return result;
      }
      Object.defineProperty(result, "retryCandidates", {
        configurable: true,
        enumerable: false,
        value: candidates,
      });
      return result;
    };
    if (acc?.action === "finalize") {
      return acc;
    }
    if (next.action === "finalize") {
      return { action: "finalize", reason: next.reason };
    }
    if (acc?.action === "revise" && next.action === "revise") {
      const retryCandidates = [...readRetryCandidates(acc), ...readRetryCandidates(next)];
      const retry = retryCandidates[0];
      return attachRetryCandidates(
        {
          action: "revise",
          reason: concatOptionalTextSegments({
            left: acc.reason,
            right: next.reason,
          }),
          ...(retry ? { retry } : {}),
        },
        retryCandidates,
      );
    }
    if (acc?.action === "revise") {
      return acc;
    }
    if (next.action === "revise") {
      const retry = normalizeRetry(next.retry);
      return {
        action: "revise",
        reason: next.reason,
        ...(retry ? { retry } : {}),
      };
    }
    return next.action === "continue" ? { action: "continue", reason: next.reason } : (acc ?? next);
  };

  const mergeSubagentSpawningResult = (
    acc: PluginHookSubagentSpawningResult | undefined,
    next: PluginHookSubagentSpawningResult,
  ): PluginHookSubagentSpawningResult => {
    if (acc?.status === "error") {
      return acc;
    }
    if (next.status === "error") {
      return next;
    }
    const deliveryOrigin = acc?.deliveryOrigin ?? next.deliveryOrigin;
    return {
      status: "ok",
      threadBindingReady: Boolean(acc?.threadBindingReady || next.threadBindingReady),
      ...(deliveryOrigin ? { deliveryOrigin } : {}),
    };
  };

  const mergeSubagentDeliveryTargetResult = (
    acc: PluginHookSubagentDeliveryTargetResult | undefined,
    next: PluginHookSubagentDeliveryTargetResult,
  ): PluginHookSubagentDeliveryTargetResult => {
    if (acc?.origin) {
      return acc;
    }
    return next;
  };

  const handleHookError = (params: {
    hookName: PluginHookName;
    pluginId: string;
    error: unknown;
  }): never | void => {
    const msg = `[hooks] ${params.hookName} handler from ${params.pluginId} failed: ${formatHookErrorForLog(params.error)}`;
    if (shouldCatchHookErrors(params.hookName)) {
      logger?.error(msg);
      return;
    }
    throw new Error(msg, { cause: params.error });
  };

  const sanitizeHookError = (error: unknown): string => {
    const raw = formatErrorMessage(error);
    const firstLine = raw.split("\n")[0]?.trim();
    return firstLine || "unknown error";
  };

  const getPluginPackageVersion = (pluginId: string): string | undefined =>
    registry.plugins.find((plugin) => plugin.id === pluginId)?.packageVersion;

  const normalizePositiveTimeoutMs = (timeoutMs: number | undefined): number | undefined => {
    return clampPositiveTimerTimeoutMs(timeoutMs);
  };

  const getVoidHookTimeoutMs = (
    hookName: PluginHookName,
    hook: PluginHookRegistration,
  ): number | undefined =>
    normalizePositiveTimeoutMs(hook.timeoutMs) ??
    normalizePositiveTimeoutMs(voidHookTimeoutMsByHook[hookName]);

  const getModifyingHookTimeoutMs = (
    hookName: PluginHookName,
    hook: PluginHookRegistration,
  ): number | undefined =>
    normalizePositiveTimeoutMs(hook.timeoutMs) ??
    normalizePositiveTimeoutMs(modifyingHookTimeoutMsByHook[hookName]);

  const getClaimingHookTimeoutMs = (hook: PluginHookRegistration): number | undefined =>
    normalizePositiveTimeoutMs(hook.timeoutMs);

  const withHookTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
    optionsResult: { unref?: boolean } = {},
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (optionsResult.unref) {
        timer.unref?.();
      }
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const runSyncHookHandler = <K extends SyncHookName>(
    hook: PluginHookRegistration<K>,
    event: SyncHookEvent<K>,
    ctx: SyncHookContext<K>,
  ): SyncHookResult<K> | undefined => {
    const handler = hook.handler as SyncHookHandler<K>;
    const out = handler(event, ctx) as SyncHookResult<K> | PromiseLike<unknown>;
    if (!isPromiseLike(out)) {
      return out;
    }

    // Sync-only hooks ignore async results; observe rejections so the global fatal handler cannot crash.
    void Promise.resolve(out).catch(() => undefined);
    const msg =
      `[hooks] ${hook.hookName} handler from ${hook.pluginId} returned a Promise; ` +
      `this hook is synchronous and the result was ignored.`;
    if (shouldCatchHookErrors(hook.hookName)) {
      logger?.warn?.(msg);
      return undefined;
    }
    throw new Error(msg);
  };

  /**
   * Run a hook that doesn't return a value (fire-and-forget style).
   * All handlers are executed in parallel for performance.
   */
  async function runVoidHook<K extends PluginHookName>(
    hookName: K,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
    optionsValue: VoidHookRunOptions = {},
    matcherToolName?: string,
  ): Promise<void> {
    const hooks = getHooksForName(registry, hookName, undefined, matcherToolName);
    if (hooks.length === 0) {
      return;
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers)`);

    const promises = hooks.map(async (hook) => {
      try {
        const promise = Promise.resolve(
          (hook.handler as (event: unknown, ctx: unknown) => Promise<void> | void)(event, ctx),
        );
        const timeoutMs = getVoidHookTimeoutMs(hookName, hook);
        if (timeoutMs) {
          await withHookTimeout(promise, timeoutMs, { unref: optionsValue.unrefTimeout ?? true });
        } else {
          await promise;
        }
      } catch (err) {
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
    });

    await Promise.all(promises);
  }

  /**
   * Run a hook that can return a modifying result.
   * Handlers are executed sequentially in priority order, and results are merged.
   */
  async function runModifyingHook<K extends PluginHookName, TResult>(
    hookName: K,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
    policy: ModifyingHookPolicy<K, TResult> = {},
    matcherToolName?: string,
  ): Promise<TResult | undefined> {
    const hooks = getHooksForName(registry, hookName, undefined, matcherToolName);
    if (hooks.length === 0) {
      return undefined;
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, sequential)`);

    let result: TResult | undefined;

    for (const hook of hooks) {
      try {
        const handler = hook.handler as (event: unknown, ctx: unknown) => Promise<TResult>;
        const handlerEvent = policy.isolateEventPerHandler
          ? cloneHookIsolationValue(hookName, event)
          : event;
        const promise = Promise.resolve(handler(handlerEvent, ctx));
        const timeoutMs = getModifyingHookTimeoutMs(hookName, hook);
        const handlerResult = timeoutMs ? await withHookTimeout(promise, timeoutMs) : await promise;

        const shouldMergeResult =
          handlerResult !== undefined && (handlerResult !== null || policy.mergeNullResults);
        if (shouldMergeResult) {
          if (policy.mergeResults) {
            result = policy.mergeResults(result, handlerResult, hook);
          } else {
            result = handlerResult;
          }
          if (result && policy.shouldStop?.(result)) {
            const terminalLabel = policy.terminalLabel ? ` ${policy.terminalLabel}` : "";
            const priority = hook.priority ?? 0;
            logger?.debug?.(
              `[hooks] ${hookName}${terminalLabel} decided by ${hook.pluginId} (priority=${priority}); skipping remaining handlers`,
            );
            policy.onTerminal?.({ hookName, pluginId: hook.pluginId, result });
            break;
          }
        }
      } catch (err) {
        if (err instanceof HookIsolationError) {
          throw err;
        }
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
    }

    return result;
  }

  /**
   * Run a sequential claim hook where the first `{ handled: true }` result wins.
   */
  async function runClaimingHook<K extends PluginHookName, TResult extends { handled: boolean }>(
    hookName: K,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
    runHandler?: (run: () => Promise<TResult | void>) => Promise<TResult | void>,
  ): Promise<TResult | undefined> {
    const hooks = getHooksForName(registry, hookName, ctx);
    if (hooks.length === 0) {
      return undefined;
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, first-claim wins)`);

    return await runClaimingHooksList(hooks, hookName, event, ctx, runHandler);
  }

  async function runClaimingHookForPlugin<
    K extends PluginHookName,
    TResult extends { handled: boolean },
  >(
    hookName: K,
    pluginId: string,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  ): Promise<TResult | undefined> {
    const hooks = getHooksForNameAndPlugin(registry, hookName, pluginId);
    if (hooks.length === 0) {
      return undefined;
    }

    logger?.debug?.(
      `[hooks] running ${hookName} for ${pluginId} (${hooks.length} handlers, targeted)`,
    );

    return await runClaimingHooksList(hooks, hookName, event, ctx);
  }

  async function runClaimingHooksList<
    K extends PluginHookName,
    TResult extends { handled: boolean },
  >(
    hooks: Array<PluginHookRegistration<K> & { pluginId: string }>,
    hookName: K,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
    runHandler?: (run: () => Promise<TResult | void>) => Promise<TResult | void>,
  ): Promise<TResult | undefined> {
    for (const hook of hooks) {
      try {
        const invokeHandler = async (): Promise<TResult | void> => {
          const promise = Promise.resolve(
            (hook.handler as (event: unknown, ctx: unknown) => Promise<TResult | void>)(event, ctx),
          );
          const timeoutMs = getClaimingHookTimeoutMs(hook);
          return timeoutMs ? await withHookTimeout(promise, timeoutMs) : await promise;
        };
        const handlerResult = runHandler ? await runHandler(invokeHandler) : await invokeHandler();
        if (handlerResult?.handled) {
          return handlerResult;
        }
      } catch (err) {
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
    }

    return undefined;
  }

  async function runClaimingHookForPluginOutcome<
    K extends PluginHookName,
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Targeted hook outcomes preserve caller-specific handled result types.
    TResult extends { handled: boolean },
  >(
    hookName: K,
    pluginId: string,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  ): Promise<
    | { status: "handled"; result: TResult }
    | { status: "missing_plugin" }
    | { status: "no_handler" }
    | { status: "declined" }
    | { status: "error"; error: string }
  > {
    const pluginLoaded = registry.plugins.some(
      (plugin) => plugin.id === pluginId && plugin.status === "loaded",
    );
    if (!pluginLoaded) {
      return { status: "missing_plugin" };
    }

    const hooks = getHooksForNameAndPlugin(registry, hookName, pluginId);
    if (hooks.length === 0) {
      return { status: "no_handler" };
    }

    logger?.debug?.(
      `[hooks] running ${hookName} for ${pluginId} (${hooks.length} handlers, targeted outcome)`,
    );

    let firstError: string | null = null;
    for (const hook of hooks) {
      try {
        const promise = Promise.resolve(
          (hook.handler as (event: unknown, ctx: unknown) => Promise<TResult | void>)(event, ctx),
        );
        const timeoutMs = getClaimingHookTimeoutMs(hook);
        const handlerResult = timeoutMs ? await withHookTimeout(promise, timeoutMs) : await promise;
        if (handlerResult?.handled) {
          return { status: "handled", result: handlerResult };
        }
      } catch (err) {
        firstError ??= sanitizeHookError(err);
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
    }

    if (firstError) {
      return { status: "error", error: firstError };
    }
    return { status: "declined" };
  }

  // =========================================================================
  // Agent Hooks
  // =========================================================================

  function withAgentRunId<TEvent extends { runId?: string }>(
    event: TEvent,
    ctx: PluginHookAgentContext,
  ): TEvent {
    if (event.runId || !ctx.runId) {
      return event;
    }
    return { ...event, runId: ctx.runId };
  }

  /**
   * Run before_model_resolve hook.
   * Allows plugins to override provider/model before model resolution.
   */
  async function runBeforeModelResolve(
    event: PluginHookBeforeModelResolveEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeModelResolveResult | undefined> {
    return runModifyingHook<"before_model_resolve", PluginHookBeforeModelResolveResult>(
      "before_model_resolve",
      event,
      ctx,
      { mergeResults: mergeBeforeModelResolve },
    );
  }

  /**
   * Run before_prompt_build hook.
   * Allows plugins to inject context and system prompt before prompt submission.
   */
  async function runBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    if (beforePromptBuildDispatch.getStore()?.active) {
      return undefined;
    }
    const token = { active: true };
    return await beforePromptBuildDispatch.run(token, async () => {
      try {
        return await runModifyingHook<"before_prompt_build", PluginHookBeforePromptBuildResult>(
          "before_prompt_build",
          event,
          ctx,
          { mergeResults: mergeBeforePromptBuild },
        );
      } finally {
        token.active = false;
      }
    });
  }

  async function runAgentTurnPrepare(
    event: PluginAgentTurnPrepareEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginAgentTurnPrepareResult | undefined> {
    return runModifyingHook<"agent_turn_prepare", PluginAgentTurnPrepareResult>(
      "agent_turn_prepare",
      event,
      ctx,
      { mergeResults: mergeAgentTurnPrepare },
    );
  }

  /**
   * Run before_agent_reply hook.
   * Allows plugins to intercept messages and return a synthetic reply,
   * short-circuiting the LLM agent. First handler to return { handled: true } wins.
   */
  async function runBeforeAgentReply(
    event: PluginHookBeforeAgentReplyEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeAgentReplyResult | undefined> {
    return runClaimingHook<"before_agent_reply", PluginHookBeforeAgentReplyResult>(
      "before_agent_reply",
      event,
      ctx,
    );
  }

  /**
   * Run agent_end hook.
   * Allows plugins to analyze completed conversations.
   * Runs handlers in parallel.
   */
  async function runAgentEnd(
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
    optionsLocal?: VoidHookRunOptions,
  ): Promise<void> {
    return runVoidHook("agent_end", withAgentRunId(event, ctx), ctx, optionsLocal);
  }

  /**
   * Run before_agent_finalize hook.
   * Allows plugins to request one more model pass before a natural final reply
   * is accepted. This is not the user-facing /stop cancellation path.
   */
  async function runBeforeAgentFinalize(
    event: PluginHookBeforeAgentFinalizeEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeAgentFinalizeResult | undefined> {
    return runModifyingHook<"before_agent_finalize", PluginHookBeforeAgentFinalizeResult>(
      "before_agent_finalize",
      withAgentRunId(event, ctx),
      ctx,
      { mergeResults: mergeBeforeAgentFinalize },
    );
  }

  /**
   * Run before_compaction hook.
   */
  async function runBeforeCompaction(
    event: PluginHookBeforeCompactionEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("before_compaction", event, ctx);
  }

  /**
   * Run after_compaction hook.
   */
  async function runAfterCompaction(
    event: PluginHookAfterCompactionEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("after_compaction", event, ctx);
  }

  // =========================================================================
  // Message Hooks
  // =========================================================================

  /**
   * Run inbound_claim hook.
   * Allows plugins to claim an inbound event before commands/agent dispatch.
   */
  async function runInboundClaim(
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginHookInboundClaimResult | undefined> {
    return runClaimingHook<"inbound_claim", PluginHookInboundClaimResult>(
      "inbound_claim",
      event,
      ctx,
    );
  }

  async function runInboundClaimForPlugin(
    pluginId: string,
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginHookInboundClaimResult | undefined> {
    return runClaimingHookForPlugin<"inbound_claim", PluginHookInboundClaimResult>(
      "inbound_claim",
      pluginId,
      event,
      ctx,
    );
  }

  async function runInboundClaimForPluginOutcome(
    pluginId: string,
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginTargetedInboundClaimOutcome> {
    return runClaimingHookForPluginOutcome<"inbound_claim", PluginHookInboundClaimResult>(
      "inbound_claim",
      pluginId,
      event,
      ctx,
    );
  }

  /**
   * Run before_dispatch hook.
   * Allows plugins to inspect or handle a message before model dispatch.
   * First handler returning { handled: true } wins.
   */
  async function runBeforeDispatch(
    event: PluginHookBeforeDispatchEvent,
    ctx: PluginHookBeforeDispatchContext,
    requester?: PluginSubagentRequesterContext,
  ): Promise<PluginHookBeforeDispatchResult | undefined> {
    const runHandler = requester
      ? (run: () => Promise<PluginHookBeforeDispatchResult | void>) =>
          withPluginSubagentRequesterContext(requester, run)
      : undefined;
    return runClaimingHook<"before_dispatch", PluginHookBeforeDispatchResult>(
      "before_dispatch",
      event,
      ctx,
      runHandler,
    );
  }

  /**
   * Run reply_dispatch hook.
   * Allows plugins to own reply dispatch before the default model path runs.
   * First handler returning { handled: true } wins.
   */
  async function runReplyDispatch(
    event: PluginHookReplyDispatchEvent,
    ctx: PluginHookReplyDispatchContext,
  ): Promise<PluginHookReplyDispatchResult | undefined> {
    return runClaimingHook<"reply_dispatch", PluginHookReplyDispatchResult>(
      "reply_dispatch",
      event,
      ctx,
    );
  }

  /**
   * Run reply_payload_sending hook.
   * Allows plugins to modify or cancel normalized reply payloads before delivery.
   * Runs sequentially, passing each handler the latest payload.
   */
  async function runReplyPayloadSending(
    event: PluginHookReplyPayloadSendingEvent,
    ctx: PluginHookReplyPayloadSendingContext,
  ): Promise<PluginHookReplyPayloadSendingResult | undefined> {
    const hooks = getHooksForName(registry, "reply_payload_sending");
    if (hooks.length === 0) {
      return undefined;
    }

    logger?.debug?.(`[hooks] running reply_payload_sending (${hooks.length} handlers, sequential)`);

    let currentPayload: ReplyPayload = event.payload;
    let result: PluginHookReplyPayloadSendingResult | undefined;

    for (const hook of hooks) {
      try {
        const handler = hook.handler as (
          event: PluginHookReplyPayloadSendingEvent,
          ctx: PluginHookReplyPayloadSendingContext,
        ) => Promise<PluginHookReplyPayloadSendingResult | void>;
        const promise = Promise.resolve(
          handler({ ...event, payload: toPluginReplyPayload(currentPayload) }, ctx),
        );
        const timeoutMs = getModifyingHookTimeoutMs("reply_payload_sending", hook);
        const handlerResult = timeoutMs ? await withHookTimeout(promise, timeoutMs) : await promise;

        if (!handlerResult) {
          continue;
        }

        if (handlerResult.payload !== undefined) {
          currentPayload = acceptPluginReplyPayload(currentPayload, handlerResult.payload);
        }

        result = {
          payload: currentPayload as PluginHookReplyPayload,
          cancel: stickyTrue(result?.cancel, handlerResult.cancel),
          reason: lastDefined(result?.reason, handlerResult.reason),
        };

        if (result.cancel === true) {
          const priority = hook.priority ?? 0;
          logger?.debug?.(
            `[hooks] reply_payload_sending cancel=true decided by ${hook.pluginId} (priority=${priority}); skipping remaining handlers`,
          );
          break;
        }
      } catch (err) {
        handleHookError({ hookName: "reply_payload_sending", pluginId: hook.pluginId, error: err });
      }
    }

    return result;
  }

  /**
   * Run message_sending hook.
   * Allows plugins to modify or cancel outgoing messages.
   * Runs sequentially.
   */
  async function runMessageSending(
    event: PluginHookMessageSendingEvent,
    ctx: PluginHookMessageContext,
  ): Promise<PluginHookMessageSendingResult | undefined> {
    return runModifyingHook<"message_sending", PluginHookMessageSendingResult>(
      "message_sending",
      event,
      ctx,
      {
        mergeResults: (acc, next) => {
          if (acc?.cancel === true) {
            return acc;
          }
          return {
            content: lastDefined(acc?.content, next.content),
            cancel: stickyTrue(acc?.cancel, next.cancel),
            cancelReason: lastDefined(acc?.cancelReason, next.cancelReason),
            metadata: next.metadata ?? acc?.metadata,
          };
        },
        shouldStop: (result) => result.cancel === true,
        terminalLabel: "cancel=true",
      },
    );
  }

  /**
   * Run before_agent_run gate hook.
   * Fires after session resolution and workspace preparation, before model inference.
   * Returns the most-restrictive pass/block decision from all handlers.
   * Handlers that return void are treated as pass.
   */
  async function runBeforeAgentRun(
    event: PluginHookBeforeAgentRunEvent,
    ctx: PluginHookAgentContext,
  ): Promise<GateHookResult<InputGateDecision> | undefined> {
    let winningPluginId: string | undefined;
    const decision = await runModifyingHook<"before_agent_run", InputGateDecision | undefined>(
      "before_agent_run",
      event,
      ctx,
      {
        mergeResults: (_acc, next, reg) => {
          if (next === undefined || next === null) {
            const normalized: InputGateDecision = {
              outcome: "block",
              reason: "before_agent_run returned an invalid decision",
            };
            winningPluginId = reg.pluginId;
            return normalized;
          }
          const normalized: InputGateDecision = isHookDecision(next)
            ? next
            : {
                outcome: "block",
                reason: "before_agent_run returned an invalid decision",
              };
          const merged =
            !_acc || (normalized.outcome === "block" && _acc.outcome !== "block")
              ? normalized
              : _acc;
          if (merged === normalized) {
            winningPluginId = reg.pluginId;
          }
          return merged;
        },
        mergeNullResults: true,
        shouldStop: (result) => result?.outcome === "block",
        terminalLabel: "gate-decision",
      },
    );
    if (!decision) {
      return undefined;
    }
    return { decision, pluginId: winningPluginId ?? "unknown" };
  }

  // Tool Hooks
  // =========================================================================

  /**
   * Run before_tool_call hook.
   * Allows plugins to modify or block tool calls.
   * Runs sequentially.
   */
  async function runBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<PluginHookBeforeToolCallResult | undefined> {
    return runModifyingHook<"before_tool_call", PluginHookBeforeToolCallResult>(
      "before_tool_call",
      event,
      ctx,
      {
        // A plugin may mutate its local event, but direct writes must not alter
        // the caller's params or the event observed by another plugin.
        isolateEventPerHandler: true,
        mergeResults: (acc, next, reg) => {
          if (acc?.block === true) {
            return acc;
          }
          const approvalAlreadyRequested = acc?.requireApproval !== undefined;
          let params = lastDefined(acc?.params, next.params);
          if (approvalAlreadyRequested) {
            params = acc?.params;
          } else if (next.requireApproval && params !== undefined) {
            // Approval covers one detached snapshot. Later hooks may still
            // block, but they cannot change what the operator reviewed.
            params = cloneHookIsolationValue("before_tool_call", params);
          }
          return {
            params,
            block: stickyTrue(acc?.block, next.block),
            blockReason: lastDefined(acc?.blockReason, next.blockReason),
            requireApproval:
              acc?.requireApproval ??
              (next.requireApproval
                ? { ...next.requireApproval, pluginId: reg.pluginId }
                : undefined),
          };
        },
        shouldStop: (result) => result.block === true,
        terminalLabel: "block=true",
      },
      event.toolName,
    );
  }

  /**
   * Run after_tool_call hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runAfterToolCall(
    event: PluginHookAfterToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> {
    return runVoidHook("after_tool_call", event, ctx, {}, event.toolName);
  }

  /**
   * Run tool_result_persist hook.
   *
   * This hook is intentionally synchronous: it runs in hot paths where session
   * transcripts are appended synchronously.
   *
   * Handlers are executed sequentially in priority order (higher first). Each
   * handler may return `{ message }` to replace the message passed to the next
   * handler.
   */
  function runToolResultPersist(
    event: PluginHookToolResultPersistEvent,
    ctx: PluginHookToolResultPersistContext,
  ): PluginHookToolResultPersistResult | undefined {
    const hooks = getHooksForName(registry, "tool_result_persist");
    if (hooks.length === 0) {
      return undefined;
    }

    let current = event.message;

    for (const hook of hooks) {
      try {
        const out = runSyncHookHandler(hook, { ...event, message: current }, ctx);
        const next = (out as PluginHookToolResultPersistResult | undefined)?.message;
        if (next) {
          current = next;
        }
      } catch (err) {
        const msg = `[hooks] tool_result_persist handler from ${hook.pluginId} failed: ${String(err)}`;
        if (shouldCatchHookErrors("tool_result_persist")) {
          logger?.error(msg);
        } else {
          throw new Error(msg, { cause: err });
        }
      }
    }

    return { message: current };
  }

  // =========================================================================
  // Message Write Hooks
  // =========================================================================

  /**
   * Run before_message_write hook.
   *
   * This hook is intentionally synchronous: it runs on the hot path where
   * session transcripts are appended synchronously.
   *
   * Handlers are executed sequentially in priority order (higher first).
   * If any handler returns { block: true }, the message is NOT written
   * to the session JSONL and we return immediately.
   * If a handler returns { message }, the modified message replaces the
   * original for subsequent handlers and the final write.
   */
  function runBeforeMessageWrite(
    event: PluginHookBeforeMessageWriteEvent,
    ctx: { agentId?: string; sessionKey?: string },
  ): PluginHookBeforeMessageWriteResult | undefined {
    const hooks = getHooksForName(registry, "before_message_write");
    if (hooks.length === 0) {
      return undefined;
    }

    let current = event.message;

    for (const hook of hooks) {
      try {
        const out = runSyncHookHandler(hook, { ...event, message: current }, ctx);
        const result = out as PluginHookBeforeMessageWriteResult | undefined;

        // If any handler blocks, return immediately.
        if (result?.block) {
          return { block: true };
        }

        // If handler provided a modified message, use it for subsequent handlers.
        if (result?.message) {
          current = result.message;
        }
      } catch (err) {
        const msg = `[hooks] before_message_write handler from ${hook.pluginId} failed: ${String(err)}`;
        if (shouldCatchHookErrors("before_message_write")) {
          logger?.error(msg);
        } else {
          throw new Error(msg, { cause: err });
        }
      }
    }

    // If message was modified by any handler, return it.
    if (current !== event.message) {
      return { message: current };
    }

    return undefined;
  }

  // =========================================================================
  // Session Hooks
  // =========================================================================

  /**
   * @deprecated Core prepares thread-bound subagent bindings through channel
   * session-binding adapters before subagent_spawned fires. This remains only
   * for older plugins that call the hook runner directly.
   */
  async function runSubagentSpawning(
    event: PluginHookSubagentSpawningEvent,
    ctx: PluginHookSubagentContext,
  ): Promise<PluginHookSubagentSpawningResult | undefined> {
    return runModifyingHook<"subagent_spawning", PluginHookSubagentSpawningResult>(
      "subagent_spawning",
      event,
      ctx,
      { mergeResults: mergeSubagentSpawningResult },
    );
  }

  /**
   * Run subagent_delivery_target hook.
   * Runs sequentially so channel plugins can deterministically resolve routing.
   */
  async function runSubagentDeliveryTarget(
    event: PluginHookSubagentDeliveryTargetEvent,
    ctx: PluginHookSubagentContext,
  ): Promise<PluginHookSubagentDeliveryTargetResult | undefined> {
    return runModifyingHook<"subagent_delivery_target", PluginHookSubagentDeliveryTargetResult>(
      "subagent_delivery_target",
      event,
      ctx,
      { mergeResults: mergeSubagentDeliveryTargetResult },
    );
  }

  // =========================================================================
  // Gateway Hooks
  // =========================================================================

  async function runHeartbeatPromptContribution(
    event: PluginHeartbeatPromptContributionEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHeartbeatPromptContributionResult | undefined> {
    return runModifyingHook<
      "heartbeat_prompt_contribution",
      PluginHeartbeatPromptContributionResult
    >("heartbeat_prompt_contribution", event, ctx, { mergeResults: mergeAgentTurnPrepare });
  }

  // =========================================================================
  // Skill Hooks
  // =========================================================================

  /**
   * Run every registered proposal evaluator and retain its attribution.
   *
   * Evaluator failures are returned as data so Workshop can persist and show
   * them. A broken optional evaluator must not make proposal state unreadable.
   */
  async function runSkillProposalEvaluate(
    event: PluginHookSkillProposalEvaluateEvent,
    ctx: PluginHookSkillContext,
  ): Promise<PluginHookSkillProposalEvaluationOutcome[]> {
    const hookName = "skill_proposal_evaluate";
    const hooks = getHooksForName(registry, hookName);
    if (hooks.length === 0) {
      return [];
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, attributed)`);
    const immutableEvent = deepFreezeHookValue(structuredClone(event));
    return await Promise.all(
      hooks.map(async (hook): Promise<PluginHookSkillProposalEvaluationOutcome> => {
        const pluginVersion = getPluginPackageVersion(hook.pluginId);
        const attribution = {
          evaluatorId: hook.registrationId ?? hook.pluginId,
          pluginId: hook.pluginId,
          ...(pluginVersion ? { pluginVersion } : {}),
        };
        try {
          const handler = hook.handler as (
            event: PluginHookSkillProposalEvaluateEvent,
            ctx: PluginHookSkillContext,
          ) => Promise<PluginHookSkillProposalEvaluateResult | void>;
          const promise = Promise.resolve(handler(immutableEvent, ctx));
          const timeoutMs = getModifyingHookTimeoutMs(hookName, hook);
          const result = timeoutMs ? await withHookTimeout(promise, timeoutMs) : await promise;
          return result
            ? Object.assign({}, attribution, { status: "completed" as const, result })
            : Object.assign({}, attribution, { status: "skipped" as const });
        } catch (error) {
          const message = sanitizeHookError(error);
          logger?.error(
            `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${formatHookErrorForLog(error)}`,
          );
          return Object.assign({}, attribution, { status: "error" as const, error: message });
        }
      }),
    );
  }

  async function runSkillProposalChanged(
    event: PluginHookSkillProposalChangedEvent,
    ctx: PluginHookSkillContext,
  ): Promise<void> {
    const immutableEvent = deepFreezeHookValue(structuredClone(event));
    return runVoidHook("skill_proposal_changed", immutableEvent, ctx);
  }

  async function runSkillChanged(
    event: PluginHookSkillChangedEvent,
    ctx: PluginHookSkillContext,
  ): Promise<void> {
    const immutableEvent = deepFreezeHookValue(structuredClone(event));
    return runVoidHook("skill_changed", immutableEvent, ctx);
  }

  // =========================================================================
  // Skill Install Hooks
  // =========================================================================

  /**
   * Run before_install hook.
   * Allows plugins to augment scan findings or block installs.
   * Runs sequentially so higher-priority hooks can block before lower ones run.
   */
  async function runBeforeInstall(
    event: PluginHookBeforeInstallEvent,
    ctx: PluginHookBeforeInstallContext,
  ): Promise<PluginHookBeforeInstallResult | undefined> {
    return runModifyingHook<"before_install", PluginHookBeforeInstallResult>(
      "before_install",
      event,
      ctx,
      {
        mergeResults: (acc, next) => {
          if (acc?.block === true) {
            return acc;
          }
          const mergedFindings = [...(acc?.findings ?? []), ...(next.findings ?? [])];
          return {
            findings: mergedFindings.length > 0 ? mergedFindings : undefined,
            block: stickyTrue(acc?.block, next.block),
            blockReason: lastDefined(acc?.blockReason, next.blockReason),
          };
        },
        shouldStop: (result) => result.block === true,
        terminalLabel: "block=true",
      },
    );
  }

  async function runResolveExecEnv(
    event: PluginHookResolveExecEnvEvent,
    ctx: PluginHookResolveExecEnvContext,
  ): Promise<Record<string, string>> {
    const result = await runModifyingHook<"resolve_exec_env", Record<string, string>>(
      "resolve_exec_env",
      event,
      ctx,
      {
        mergeResults: (acc, next) => (acc ? { ...acc, ...next } : next),
      },
    );
    return result ?? {};
  }

  // =========================================================================
  // Utility
  // =========================================================================

  function hasHooks<K extends PluginHookName>(
    hookName: K,
    ctx?: Parameters<PluginHookHandlerMap[K]>[1],
  ): boolean {
    if (ctx === undefined) {
      return registry.typedHooks.some((hook) => hook.hookName === hookName);
    }
    return getHooksForName(registry, hookName, ctx).length > 0;
  }

  /**
   * Get count of registered hooks for a given hook name.
   */
  function getHookCount(hookName: PluginHookName): number {
    return registry.typedHooks.filter((h) => h.hookName === hookName).length;
  }

  return {
    // Agent hooks
    runBeforeModelResolve,
    runAgentTurnPrepare,
    runBeforePromptBuild,
    runBeforeAgentReply,
    runModelCallStarted: async (
      event: PluginHookModelCallStartedEvent,
      ctx: PluginHookAgentContext,
    ): Promise<void> => runVoidHook("model_call_started", event, ctx),
    runModelCallEnded: async (
      event: PluginHookModelCallEndedEvent,
      ctx: PluginHookAgentContext,
    ): Promise<void> => runVoidHook("model_call_ended", event, ctx),
    runLlmInput: async (
      event: PluginHookLlmInputEvent,
      ctx: PluginHookAgentContext,
    ): Promise<void> => runVoidHook("llm_input", event, ctx),
    runLlmOutput: async (
      event: PluginHookLlmOutputEvent,
      ctx: PluginHookAgentContext,
    ): Promise<void> => runVoidHook("llm_output", event, ctx),
    runBeforeAgentFinalize,
    runAgentEnd,
    runBeforeCompaction,
    runAfterCompaction,
    runBeforeReset: async (
      event: PluginHookBeforeResetEvent,
      ctx: PluginHookAgentContext,
    ): Promise<void> => runVoidHook("before_reset", event, ctx),
    // Lifecycle gate hooks
    runBeforeAgentRun,
    // Message hooks
    runInboundClaim,
    runInboundClaimForPlugin,
    runInboundClaimForPluginOutcome,
    runChannelPairingRequested: async (
      event: Parameters<PluginHookHandlerMap["channel_pairing_requested"]>[0],
      ctx: Parameters<PluginHookHandlerMap["channel_pairing_requested"]>[1],
    ): Promise<void> => runVoidHook("channel_pairing_requested", event, ctx),
    runMessageReceived: async (
      event: PluginHookMessageReceivedEvent,
      ctx: PluginHookMessageContext,
    ): Promise<void> => runVoidHook("message_received", event, ctx),
    runBeforeDispatch,
    runReplyDispatch,
    runReplyPayloadSending,
    runMessageSending,
    runMessageSent: async (
      event: PluginHookMessageSentEvent,
      ctx: PluginHookMessageContext,
    ): Promise<void> => runVoidHook("message_sent", event, ctx),
    // Tool hooks
    runBeforeToolCall,
    runAfterToolCall,
    runToolResultPersist,
    // Message write hooks
    runBeforeMessageWrite,
    // Session hooks
    runSessionStart: async (
      event: PluginHookSessionStartEvent,
      ctx: PluginHookSessionContext,
    ): Promise<void> => runVoidHook("session_start", event, ctx),
    runSessionEnd: async (
      event: PluginHookSessionEndEvent,
      ctx: PluginHookSessionContext,
    ): Promise<void> => runVoidHook("session_end", event, ctx),
    runSubagentSpawning,
    runSubagentDeliveryTarget,
    runSubagentSpawned: async (
      event: PluginHookSubagentSpawnedEvent,
      ctx: PluginHookSubagentContext,
    ): Promise<void> => runVoidHook("subagent_spawned", event, ctx),
    runSubagentProgress: async (
      event: PluginHookSubagentProgressEvent,
      ctx: PluginHookSubagentContext,
    ): Promise<void> => runVoidHook("subagent_progress", event, ctx),
    runSubagentEnded: async (
      event: PluginHookSubagentEndedEvent,
      ctx: PluginHookSubagentContext,
    ): Promise<void> => runVoidHook("subagent_ended", event, ctx),
    // Gateway hooks
    runGatewayStart: async (
      event: PluginHookGatewayStartEvent,
      ctx: PluginHookGatewayContext,
    ): Promise<void> => runVoidHook("gateway_start", event, ctx),
    runGatewayStop: async (
      event: PluginHookGatewayStopEvent,
      ctx: PluginHookGatewayContext,
    ): Promise<void> => runVoidHook("gateway_stop", event, ctx),
    runHeartbeatPromptContribution,
    runCronReconciled: async (
      event: PluginHookCronReconciledEvent,
      ctx: PluginHookCronReconciledContext,
    ): Promise<void> => runVoidHook("cron_reconciled", event, ctx),
    runCronChanged: async (
      event: PluginHookCronChangedEvent,
      ctx: PluginHookGatewayContext,
    ): Promise<void> => runVoidHook("cron_changed", event, ctx),
    // Skill hooks
    runSkillProposalEvaluate,
    runSkillProposalChanged,
    runSkillChanged,
    // Install hooks
    runBeforeInstall,
    runResolveExecEnv,
    // Utility
    hasHooks,
    getHookCount,
  };
}

export type HookRunner = ReturnType<typeof createHookRunner>;

export type SubagentLifecycleHookRunner = Pick<
  HookRunner,
  | "hasHooks"
  | "runSubagentSpawning"
  | "runSubagentSpawned"
  | "runSubagentProgress"
  | "runSubagentEnded"
>;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
