import type { MoltbotConfig } from "../config/config.js";
import type { InboundDebounceByProvider } from "../config/types.messages.js";

const resolveMs = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
};

const resolveChannelOverride = (params: {
  byChannel?: InboundDebounceByProvider;
  channel: string;
}): number | undefined => {
  if (!params.byChannel) return undefined;
  return resolveMs(params.byChannel[params.channel]);
};

export function resolveInboundDebounceMs(params: {
  cfg: MoltbotConfig;
  channel: string;
  overrideMs?: number;
}): number {
  const inbound = params.cfg.messages?.inbound;
  const override = resolveMs(params.overrideMs);
  const byChannel = resolveChannelOverride({
    byChannel: inbound?.byChannel,
    channel: params.channel,
  });
  const base = resolveMs(inbound?.debounceMs);
  return override ?? byChannel ?? base ?? 0;
}

type DebounceBuffer<T> = {
  items: T[];
  timeout: ReturnType<typeof setTimeout> | null;
};

export function createInboundDebouncer<T>(params: {
  debounceMs: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
}) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const debounceMs = Math.max(0, Math.trunc(params.debounceMs));

  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>) => {
    buffers.delete(key);
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    if (buffer.items.length === 0) return;
    try {
      await params.onFlush(buffer.items);
    } catch (err) {
      params.onError?.(err, buffer.items);
    }
  };

  const flushKey = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) return;
    await flushBuffer(key, buffer);
  };

  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.timeout) clearTimeout(buffer.timeout);
    buffer.timeout = setTimeout(() => {
      void flushBuffer(key, buffer);
    }, debounceMs);
    buffer.timeout.unref?.();
  };

  const enqueue = async (item: T) => {
    const key = params.buildKey(item);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (key && buffers.has(key)) {
        await flushKey(key);
      }
      await params.onFlush([item]);
      return;
    }

    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      scheduleFlush(key, existing);
      return;
    }

    const buffer: DebounceBuffer<T> = { items: [item], timeout: null };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  return { enqueue, flushKey };
}
