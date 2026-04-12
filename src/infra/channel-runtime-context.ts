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

export function getChannelRuntimeContext<T = unknown>(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
  },
): T | undefined {
  const runtimeContexts = resolveRuntimeContextRegistry(params);
  if (!runtimeContexts) {
    return undefined;
  }
  return runtimeContexts.get<T>({
    channelId: params.channelId,
    accountId: params.accountId,
    capability: params.capability,
  });
}

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

export function createTaskScopedChannelRuntime(params: {
  channelRuntime?: ChannelRuntimeSurface;
}): {
  channelRuntime?: ChannelRuntimeSurface;
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
        trackedLeases.delete(lease);
        lease.dispose();
      },
    };
  };

  const scopedRuntime: ChannelRuntimeSurface = {
    ...baseRuntime,
    runtimeContexts: {
      ...runtimeContexts,
      register: (registerParams) => {
        const lease = runtimeContexts.register(registerParams);
        return trackLease(lease);
      },
    },
  };

  return {
    channelRuntime: scopedRuntime,
    dispose: () => {
      for (const lease of Array.from(trackedLeases)) {
        lease.dispose();
      }
    },
  };
}
