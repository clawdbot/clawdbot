import type {
  ChannelRuntimeContextEvent,
  ChannelRuntimeContextKey,
  ChannelRuntimeContextRegistry,
} from "../../channels/plugins/channel-runtime-surface.types.js";
import { createSubsystemLogger } from "../../logging.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type StoredRuntimeContext = {
  token: symbol;
  context: unknown;
  normalizedKey: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
};

const log = createSubsystemLogger("plugins/runtime-channel");

function normalizeRuntimeContextString(value: string | null | undefined): string {
  return normalizeOptionalString(value) ?? "";
}

function normalizeRuntimeContextKey(params: ChannelRuntimeContextKey): {
  mapKey: string;
  normalizedKey: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
} | null {
  const channelId = normalizeRuntimeContextString(params.channelId);
  const capability = normalizeRuntimeContextString(params.capability);
  const accountId = normalizeRuntimeContextString(params.accountId);
  if (!channelId || !capability) {
    return null;
  }
  return {
    mapKey: `${channelId}\u0000${accountId}\u0000${capability}`,
    normalizedKey: {
      channelId,
      capability,
      ...(accountId ? { accountId } : {}),
    },
  };
}

function doesRuntimeContextWatcherMatch(params: {
  watcher: {
    channelId?: string;
    accountId?: string;
    capability?: string;
  };
  event: ChannelRuntimeContextEvent;
}): boolean {
  if (params.watcher.channelId && params.watcher.channelId !== params.event.key.channelId) {
    return false;
  }
  if (
    params.watcher.accountId !== undefined &&
    params.watcher.accountId !== (params.event.key.accountId ?? "")
  ) {
    return false;
  }
  if (params.watcher.capability && params.watcher.capability !== params.event.key.capability) {
    return false;
  }
  return true;
}

export function createChannelRuntimeContextRegistry(): ChannelRuntimeContextRegistry {
  const runtimeContexts = new Map<string, StoredRuntimeContext>();
  const runtimeContextWatchers = new Set<{
    filter: {
      channelId?: string;
      accountId?: string;
      capability?: string;
    };
    onEvent: (event: ChannelRuntimeContextEvent) => void;
  }>();
  const emitRuntimeContextEvent = (event: ChannelRuntimeContextEvent) => {
    for (const watcher of runtimeContextWatchers) {
      if (!doesRuntimeContextWatcherMatch({ watcher: watcher.filter, event })) {
        continue;
      }
      try {
        watcher.onEvent(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          `runtime context watcher failed during ${event.type} ` +
            `channel=${event.key.channelId} capability=${event.key.capability}` +
            (event.key.accountId ? ` account=${event.key.accountId}` : "") +
            `: ${message}`,
        );
      }
    }
  };
  return {
    register: (params) => {
      const normalized = normalizeRuntimeContextKey(params);
      if (!normalized) {
        return { dispose: () => {} };
      }
      if (params.abortSignal?.aborted) {
        return { dispose: () => {} };
      }
      const token = Symbol(normalized.mapKey);
      let disposed = false;
      const dispose = () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const current = runtimeContexts.get(normalized.mapKey);
        if (!current || current.token !== token) {
          return;
        }
        runtimeContexts.delete(normalized.mapKey);
        emitRuntimeContextEvent({
          type: "unregistered",
          key: normalized.normalizedKey,
        });
      };
      params.abortSignal?.addEventListener("abort", dispose, { once: true });
      if (params.abortSignal?.aborted) {
        dispose();
        return { dispose };
      }
      runtimeContexts.set(normalized.mapKey, {
        token,
        context: params.context,
        normalizedKey: normalized.normalizedKey,
      });
      if (disposed) {
        return { dispose };
      }
      emitRuntimeContextEvent({
        type: "registered",
        key: normalized.normalizedKey,
        context: params.context,
      });
      return { dispose };
    },
    get: (params) => {
      const normalized = normalizeRuntimeContextKey(params);
      if (!normalized) {
        return undefined;
      }
      return runtimeContexts.get(normalized.mapKey)?.context as never;
    },
    watch: (params) => {
      const watcher = {
        filter: {
          ...(params.channelId?.trim() ? { channelId: params.channelId.trim() } : {}),
          ...(params.accountId != null ? { accountId: params.accountId.trim() } : {}),
          ...(params.capability?.trim() ? { capability: params.capability.trim() } : {}),
        },
        onEvent: params.onEvent,
      };
      runtimeContextWatchers.add(watcher);
      return () => {
        runtimeContextWatchers.delete(watcher);
      };
    },
  };
}
