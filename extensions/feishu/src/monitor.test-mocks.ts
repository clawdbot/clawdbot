// Feishu plugin module implements monitor mocks behavior.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { vi } from "vitest";

export function createFeishuClientMockModule(): {
  createFeishuWSClient: () => { start: () => void; close: () => void };
  createEventDispatcher: () => { register: () => void };
} {
  return {
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn(), close: vi.fn() })),
    createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
  };
}

export function createFeishuRuntimeMockModule(): {
  getFeishuRuntime: () => PluginRuntime;
} {
  const stateDir = path.join(
    process.env.HOME ?? process.cwd(),
    `.openclaw-feishu-monitor-${randomUUID()}`,
  );
  const runtime = {
    state: {
      resolveStateDir: () => stateDir,
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
      ) =>
        createChannelIngressQueueForTests({
          ...options,
          channelId: "feishu",
          stateDir: options?.stateDir ?? stateDir,
        }),
    },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
          flushKey: async () => {},
          cancelKey: () => false,
          drain: async () => {},
        }),
      },
      text: {
        hasControlCommand: () => false,
      },
    },
  } as unknown as PluginRuntime;
  return {
    getFeishuRuntime: () => runtime,
  };
}
