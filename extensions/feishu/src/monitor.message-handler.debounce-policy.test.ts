import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { expect, it, vi } from "vitest";
import * as dedup from "./dedup.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

it("changes Feishu batching timing on the running receive handler", async () => {
  const cfg: OpenClawConfig = { messages: { inbound: { debounceMs: 0 } } };
  setRuntimeConfigSnapshot(cfg, cfg);
  const claim = vi
    .spyOn(dedup, "claimUnprocessedFeishuMessage")
    .mockImplementation(async ({ messageId }) =>
      messageId
        ? {
            kind: "claimed",
            handle: { keys: [messageId], commit: async () => true, release: () => {} },
          }
        : { kind: "invalid" },
    );
  const dispatched: string[] = [];
  const debouncers: Array<{ drain: () => Promise<void> }> = [];
  const createDebouncer: typeof createInboundDebouncer = (options) => {
    const debouncer = createInboundDebouncer(options);
    debouncers.push(debouncer);
    return debouncer;
  };
  const handler = createFeishuMessageReceiveHandler({
    cfg,
    channelRuntime: createPluginRuntimeMock({
      channel: { debounce: { createInboundDebouncer: createDebouncer, resolveInboundDebounceMs } },
    }).channel,
    accountId: "default",
    chatHistories: new Map(),
    handleMessage: async ({ event }) => {
      dispatched.push(event.message.content);
    },
    resolveDebounceText: ({ event }) => event.message.content,
    hasProcessedMessage: async () => false,
  });
  const enqueue = (text: string) =>
    handler({
      sender: { sender_id: { open_id: "sender" }, sender_type: "user" },
      message: {
        message_id: text,
        chat_id: "conversation",
        chat_type: "p2p",
        message_type: "text",
        content: text,
      },
    });
  const publish = (debounceMs: number) => {
    const current = { messages: { inbound: { byChannel: { feishu: debounceMs } } } };
    setRuntimeConfigSnapshot(current, current);
  };
  try {
    await enqueue("immediate");
    expect(dispatched).toEqual(["immediate"]);
    publish(250);
    const started = performance.now();
    await enqueue("first");
    await enqueue("second");
    expect(dispatched).toEqual(["immediate"]);
    await vi.waitFor(() =>
      expect(dispatched).toEqual(["immediate", JSON.stringify({ text: "first\nsecond" })]),
    );
    const delayedElapsedMs = performance.now() - started;
    publish(0);
    await enqueue("after disable");
    expect(dispatched.at(-1)).toBe("after disable");
    expect(dispatched).toHaveLength(3);
    console.log(
      "MONITOR_DEBOUNCE_PROOF " +
        JSON.stringify({
          channel: "feishu",
          pid: process.pid,
          clock: "real",
          delaysMs: [0, 250, 0],
          delayedElapsedMs,
          bodies: dispatched,
          debouncersCreated: debouncers.length,
        }),
    );
  } finally {
    await Promise.all(debouncers.map((debouncer) => debouncer.drain()));
    clearRuntimeConfigSnapshot();
    claim.mockRestore();
  }
});
