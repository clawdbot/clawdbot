import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const executionBudgetContext = resolveGlobalSingleton(
  Symbol.for("openclaw.agentToolExecutionBudgetContext"),
  () => new AsyncLocalStorage<{ admit: () => void; assertCurrent: () => void }>(),
);

/** One invocation owns the count and closes every tool closure it created. */
export function createAgentToolExecutionBudget(params: {
  maxToolCalls?: number;
  signal: AbortSignal;
  abort: (reason: Error) => void;
  isCurrent?: () => boolean;
}) {
  let toolCalls = 0;
  let active = true;
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    try {
      if (!active || params.isCurrent?.() === false) {
        throw new Error("Agent tool execution scope is no longer active");
      }
    } catch (error) {
      if (error instanceof Error) {
        params.abort(error);
      }
      throw error;
    }
  };
  const admit = () => {
    assertCurrent();
    if (params.maxToolCalls !== undefined && toolCalls >= params.maxToolCalls) {
      const error = new Error("Agent tool-call budget exhausted");
      params.abort(error);
      throw error;
    }
    // This is the last synchronous source boundary, after approval/steering awaits.
    // Charging here admits exactly the cap even when sibling calls run in parallel.
    toolCalls += 1;
  };
  return {
    get toolCalls() {
      return toolCalls;
    },
    async run<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await executionBudgetContext.run({ admit, assertCurrent }, run);
      } finally {
        active = false;
      }
    },
  };
}

/** Capture at tool construction so retained tools cannot borrow a later budget. */
export function captureAgentToolExecutionBudget(): (() => void) | undefined {
  return executionBudgetContext.getStore()?.admit;
}

/** Freeze the invocation's operational fence before asynchronous source work. */
export function captureAgentToolSourceExecutionGuard(signal?: AbortSignal): () => void {
  // This host closure checks the exact delegated claim, even with audit disabled;
  // neither diagnostic identity tokens nor their collection grant authority.
  const authority = getGatewayToolCallerIdentity()?.receiptAuthority;
  const assertBudgetCurrent = executionBudgetContext.getStore()?.assertCurrent;
  return () => {
    signal?.throwIfAborted();
    assertBudgetCurrent?.();
    if (authority?.() === false) {
      throw new Error("tool invocation authority is no longer active");
    }
  };
}

const sourceExecutionGuards = new WeakMap<AnyAgentTool, () => void>();

/** Bind a host-owned guard without mutating a tool that another attempt may reuse. */
export function bindAgentToolSourceExecutionGuard(
  tool: AnyAgentTool,
  guard: () => void,
): AnyAgentTool {
  const bound = copyAgentToolMetadata(tool, { ...tool });
  sourceExecutionGuards.set(bound, guard);
  return bound;
}

export function copyAgentToolSourceExecutionGuard(
  source: AnyAgentTool,
  target: AnyAgentTool,
): void {
  const guard = sourceExecutionGuards.get(source);
  if (guard) {
    sourceExecutionGuards.set(target, guard);
  }
}

export function runAgentToolSourceExecutionGuard(tool: AnyAgentTool): void {
  sourceExecutionGuards.get(tool)?.();
}
