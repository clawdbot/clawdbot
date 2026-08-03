import { AsyncLocalStorage } from "node:async_hooks";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const DEFAULT_TURN_YIELD_MESSAGE = "Turn yielded.";
const TURN_YIELD_MESSAGE_MAX_CHARS = 1_000;

export function normalizeTurnYieldMessage(message?: string): string {
  return truncateUtf16Safe(
    message?.trim() || DEFAULT_TURN_YIELD_MESSAGE,
    TURN_YIELD_MESSAGE_MAX_CHARS,
  );
}

export type PluginTurnYieldCommitter = {
  readonly supported: boolean;
  commit(message: string): Promise<void>;
};

type PluginToolTurnYieldInvocation = {
  active: boolean;
  catalogMode?: "direct-only";
  committer: PluginTurnYieldCommitter;
  executionMode?: "sequential" | "parallel";
  request?: { message: string };
};

type PluginToolTurnYieldLease = {
  active: boolean;
  invocation?: PluginToolTurnYieldInvocation;
  unavailableReason?: string;
};

const PLUGIN_TOOL_TURN_YIELD_INVOCATION_KEY: unique symbol = Symbol.for(
  "openclaw.pluginToolTurnYieldInvocation",
);
const PLUGIN_TOOL_TURN_YIELD_LEASE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginToolTurnYieldLease",
);

const pluginToolTurnYieldInvocation = resolveGlobalSingleton<
  AsyncLocalStorage<PluginToolTurnYieldInvocation>
>(
  PLUGIN_TOOL_TURN_YIELD_INVOCATION_KEY,
  () => new AsyncLocalStorage<PluginToolTurnYieldInvocation>(),
);
const pluginToolTurnYieldLease = resolveGlobalSingleton<
  AsyncLocalStorage<PluginToolTurnYieldLease>
>(PLUGIN_TOOL_TURN_YIELD_LEASE_KEY, () => new AsyncLocalStorage<PluginToolTurnYieldLease>());

/** True only while the current plugin tool body can safely hand off its active turn. */
export function isTurnYieldAvailable(): boolean {
  const lease = pluginToolTurnYieldLease.getStore();
  return lease?.active === true && lease.unavailableReason === undefined;
}

/** Record one clean turn handoff after the current plugin tool returns successfully. */
export function requestTurnYield(message?: string): void {
  const lease = pluginToolTurnYieldLease.getStore();
  if (lease?.active !== true) {
    throw new Error("requestTurnYield() requires an active plugin tool execution.");
  }
  if (lease.unavailableReason || !lease.invocation) {
    throw new Error(lease.unavailableReason ?? "Turn yield is not supported by this runtime.");
  }
  if (lease.invocation.request) {
    return;
  }
  if (message !== undefined && typeof message !== "string") {
    throw new TypeError("requestTurnYield() message must be a string when provided.");
  }
  lease.invocation.request = { message: normalizeTurnYieldMessage(message) };
}

export async function runWithPluginToolTurnYieldInvocation<T>(params: {
  catalogMode?: "direct-only";
  committer: PluginTurnYieldCommitter;
  executionMode?: "sequential" | "parallel";
  run: () => Promise<T>;
}): Promise<{ result: T; requestedMessage?: string }> {
  const activeInvocation = pluginToolTurnYieldInvocation.getStore();
  if (activeInvocation?.active === true) {
    return { result: await params.run() };
  }

  const invocation: PluginToolTurnYieldInvocation = {
    active: true,
    catalogMode: params.catalogMode,
    committer: params.committer,
    executionMode: params.executionMode,
  };
  return await pluginToolTurnYieldInvocation.run(invocation, async () => {
    try {
      const result = await params.run();
      return {
        result,
        ...(invocation.request ? { requestedMessage: invocation.request.message } : {}),
      };
    } finally {
      invocation.active = false;
    }
  });
}

export async function runPluginToolBodyWithTurnYieldLease<T>(params: {
  run: () => Promise<T>;
}): Promise<T> {
  const invocation = pluginToolTurnYieldInvocation.getStore();
  const activeInvocation = invocation?.active === true ? invocation : undefined;
  const unavailableReason = !activeInvocation
    ? "Turn yield is not supported by this runtime."
    : activeInvocation.executionMode !== "sequential"
      ? 'Turn-yielding plugin tools must declare executionMode: "sequential".'
      : activeInvocation.catalogMode !== "direct-only"
        ? 'Turn-yielding plugin tools must declare catalogMode: "direct-only".'
        : !activeInvocation.committer.supported
          ? "Turn yield is not supported by this runtime."
          : undefined;
  const lease: PluginToolTurnYieldLease = {
    active: true,
    ...(activeInvocation ? { invocation: activeInvocation } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
  };
  return await pluginToolTurnYieldLease.run(lease, async () => {
    try {
      return await params.run();
    } finally {
      // Detached plugin work must not retain authority after this tool call settles.
      lease.active = false;
    }
  });
}

export async function runWithTurnYieldUnavailable<T>(run: () => Promise<T>): Promise<T> {
  const lease: PluginToolTurnYieldLease = {
    active: true,
    unavailableReason: "Turn yield is unavailable while the runtime commits a handoff.",
  };
  return await pluginToolTurnYieldLease.run(lease, run);
}
