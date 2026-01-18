/**
 * Plugin Hook Runner
 *
 * Provides utilities for executing plugin lifecycle hooks with proper
 * error handling, priority ordering, and async support.
 */

import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAfterCompactionEvent,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeCompactionEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
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
  PluginHookToolContext,
} from "./types.js";

// Re-export types for consumers
export type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookAgentEndEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookAfterCompactionEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
  PluginHookToolContext,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookSessionContext,
  PluginHookSessionStartEvent,
  PluginHookSessionEndEvent,
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
};

export type HookRunnerLogger = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type HookRunnerOptions = {
  logger?: HookRunnerLogger;
  /** If true, errors in hooks will be caught and logged instead of thrown */
  catchErrors?: boolean;
};

/**
 * Get hooks for a specific hook name, sorted by priority (higher first).
 */
function getHooksForName<K extends PluginHookName>(
  registry: PluginRegistry,
  hookName: K,
): PluginHookRegistration<K>[] {
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((h) => h.hookName === hookName)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/**
 * Create a hook runner for a specific registry.
 */
export function createHookRunner(registry: PluginRegistry, options: HookRunnerOptions = {}) {
  const logger = options.logger;
  const catchErrors = options.catchErrors ?? true;

  /**
   * Run a hook that doesn't return a value (fire-and-forget style).
   * All handlers are executed in parallel for performance.
   */
  async function runVoidHook<K extends PluginHookName>(
    hookName: K,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  ): Promise<void> {
    const hooks = getHooksForName(registry, hookName);
    if (hooks.length === 0) return;

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers)`);

    const promises = hooks.map(async (hook) => {
      try {
        await (hook.handler as (event: unknown, ctx: unknown) => Promise<void>)(event, ctx);
      } catch (err) {
        const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`;
        if (catchErrors) {
          logger?.error(msg);
        } else {
          throw new Error(msg);
        }
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
    mergeResults?: (accumulated: TResult | undefined, next: TResult) => TResult,
  ): Promise<TResult | undefined> {
    const hooks = getHooksForName(registry, hookName);
    if (hooks.length === 0) return undefined;

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, sequential)`);

    let result: TResult | undefined;

    for (const hook of hooks) {
      try {
        const handlerResult = await (
          hook.handler as (event: unknown, ctx: unknown) => Promise<TResult>
        )(event, ctx);

        if (handlerResult !== undefined && handlerResult !== null) {
          if (mergeResults && result !== undefined) {
            result = mergeResults(result, handlerResult);
          } else {
            result = handlerResult;
          }
        }
      } catch (err) {
        const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`;
        if (catchErrors) {
          logger?.error(msg);
        } else {
          throw new Error(msg);
        }
      }
    }

    return result;
  }

  // =========================================================================
  // Agent Hooks
  // =========================================================================

  /**
   * Run before_agent_start hook.
   * Allows plugins to inject context into the system prompt.
   * Runs sequentially, merging systemPrompt and prependContext from all handlers.
   */
  async function runBeforeAgentStart(
    event: PluginHookBeforeAgentStartEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeAgentStartResult | undefined> {
    return runModifyingHook<"before_agent_start", PluginHookBeforeAgentStartResult>(
      "before_agent_start",
      event,
      ctx,
      (acc, next) => ({
        systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
        prependContext:
          acc?.prependContext && next.prependContext
            ? `${acc.prependContext}\n\n${next.prependContext}`
            : (next.prependContext ?? acc?.prependContext),
      }),
    );
  }

  /**
   * Run agent_end hook.
   * Allows plugins to analyze completed conversations.
   * Runs in parallel (fire-and-forget).
   */
  async function runAgentEnd(
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("agent_end", event, ctx);
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
   * Run message_received hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runMessageReceived(
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext,
  ): Promise<void> {
    return runVoidHook("message_received", event, ctx);
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
      (acc, next) => ({
        content: next.content ?? acc?.content,
        cancel: next.cancel ?? acc?.cancel,
      }),
    );
  }

  /**
   * Run message_sent hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runMessageSent(
    event: PluginHookMessageSentEvent,
    ctx: PluginHookMessageContext,
  ): Promise<void> {
    return runVoidHook("message_sent", event, ctx);
  }

  // =========================================================================
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
      (acc, next) => ({
        params: next.params ?? acc?.params,
        block: next.block ?? acc?.block,
        blockReason: next.blockReason ?? acc?.blockReason,
      }),
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
    return runVoidHook("after_tool_call", event, ctx);
  }

  // =========================================================================
  // Session Hooks
  // =========================================================================

  /**
   * Run session_start hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runSessionStart(
    event: PluginHookSessionStartEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    return runVoidHook("session_start", event, ctx);
  }

  /**
   * Run session_end hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runSessionEnd(
    event: PluginHookSessionEndEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    return runVoidHook("session_end", event, ctx);
  }

  // =========================================================================
  // Gateway Hooks
  // =========================================================================

  /**
   * Run gateway_start hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runGatewayStart(
    event: PluginHookGatewayStartEvent,
    ctx: PluginHookGatewayContext,
  ): Promise<void> {
    return runVoidHook("gateway_start", event, ctx);
  }

  /**
   * Run gateway_stop hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runGatewayStop(
    event: PluginHookGatewayStopEvent,
    ctx: PluginHookGatewayContext,
  ): Promise<void> {
    return runVoidHook("gateway_stop", event, ctx);
  }

  // =========================================================================
  // Utility
  // =========================================================================

  /**
   * Check if any hooks are registered for a given hook name.
   */
  function hasHooks(hookName: PluginHookName): boolean {
    return registry.typedHooks.some((h) => h.hookName === hookName);
  }

  /**
   * Get count of registered hooks for a given hook name.
   */
  function getHookCount(hookName: PluginHookName): number {
    return registry.typedHooks.filter((h) => h.hookName === hookName).length;
  }

  return {
    // Agent hooks
    runBeforeAgentStart,
    runAgentEnd,
    runBeforeCompaction,
    runAfterCompaction,
    // Message hooks
    runMessageReceived,
    runMessageSending,
    runMessageSent,
    // Tool hooks
    runBeforeToolCall,
    runAfterToolCall,
    // Session hooks
    runSessionStart,
    runSessionEnd,
    // Gateway hooks
    runGatewayStart,
    runGatewayStop,
    // Utility
    hasHooks,
    getHookCount,
  };
}

export type HookRunner = ReturnType<typeof createHookRunner>;
