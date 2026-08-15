// Registers and watches plugin channel runtime context values.
import type {
  ChannelRuntimeContextKey,
  ChannelRuntimeSurface,
} from "../channels/plugins/channel-runtime-surface.types.js";

const NOOP_DISPOSE = () => {};

function resolveScopedRuntimeContextRegistry(params: {
  channelRuntime: ChannelRuntimeSurface;
}): ChannelRuntimeSurface["runtimeContexts"] {
  const runtimeContexts = resolveRuntimeContextRegistry(params);
  if (
    runtimeContexts &&
    typeof runtimeContexts.register === "function" &&
    typeof runtimeContexts.get === "function" &&
    typeof runtimeContexts.watch === "function"
  ) {
    return runtimeContexts;
  }
  throw new Error(
    "channelRuntime must provide runtimeContexts.register/get/watch; pass createPluginRuntime().channel or omit channelRuntime.",
  );
}

function resolveRuntimeContextRegistry(params: {
  channelRuntime?: ChannelRuntimeSurface;
}): ChannelRuntimeSurface["runtimeContexts"] | null {
  return params.channelRuntime?.runtimeContexts ?? null;
}

/** Registers a channel-scoped runtime context, returning null when no runtime registry exists. */
export function registerChannelRuntimeContext(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
    context: unknown;
    abortSignal?: AbortSignal;
  },
): { dispose: () => void } | null {
  const runtimeContexts = resolveRuntimeContextRegistry(params);
  if (!runtimeContexts) {
    return null;
  }
  return runtimeContexts.register({
    channelId: params.channelId,
    accountId: params.accountId,
    capability: params.capability,
    context: params.context,
    abortSignal: params.abortSignal,
  });
}

/** Reads a channel-scoped runtime context from the current runtime registry. */
export function getChannelRuntimeContext(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
  },
): unknown {
  const runtimeContexts = resolveRuntimeContextRegistry(params);
  if (!runtimeContexts) {
    return undefined;
  }
  return runtimeContexts.get({
    channelId: params.channelId,
    accountId: params.accountId,
    capability: params.capability,
  });
}

/** Watches context registration changes for one channel/account/capability key. */
export function watchChannelRuntimeContexts(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
    onEvent: Parameters<ChannelRuntimeSurface["runtimeContexts"]["watch"]>[0]["onEvent"];
  },
): (() => void) | null {
  const runtimeContexts = resolveRuntimeContextRegistry(params);
  if (!runtimeContexts) {
    return null;
  }
  return runtimeContexts.watch({
    channelId: params.channelId,
    accountId: params.accountId,
    capability: params.capability,
    onEvent: params.onEvent,
  });
}

/** Wraps a channel runtime so contexts registered during a task are disposed together. */
export function createTaskScopedChannelRuntime<T extends ChannelRuntimeSurface>(params: {
  channelRuntime?: T;
}): {
  channelRuntime?: T;
  dispose: () => void;
} {
  const baseRuntime = params.channelRuntime;
  if (!baseRuntime) {
    return {
      channelRuntime: undefined,
      dispose: NOOP_DISPOSE,
    };
  }
  const runtimeContexts = resolveScopedRuntimeContextRegistry({ channelRuntime: baseRuntime });

  const trackedLeases = new Set<{ dispose: () => void }>();
  const trackLease = (lease: { dispose: () => void }) => {
    trackedLeases.add(lease);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        // Lease disposal is idempotent so task cleanup and explicit caller cleanup can race.
        trackedLeases.delete(lease);
        lease.dispose();
      },
    };
  };

  const scopedRuntime = {
    ...baseRuntime,
    runtimeContexts: {
      ...runtimeContexts,
      register: (registerParams) => {
        const lease = runtimeContexts.register(registerParams);
        return trackLease(lease);
      },
    },
  } as T;

  return {
    channelRuntime: scopedRuntime,
    dispose: () => {
      for (const lease of Array.from(trackedLeases)) {
        lease.dispose();
      }
    },
  };
}
