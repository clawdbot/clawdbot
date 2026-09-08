import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelThreadingAdapter } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";

describe("reply dedupe uses the plugin's delivery destination", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "test-flat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "test-flat" }),
            threading: {
              resolveReplyTransport: ({ replyDelivery }) =>
                replyDelivery?.replyToMode === "off" ? { threadId: null, replyToId: null } : null,
            } satisfies ChannelThreadingAdapter,
          },
        },
      ]),
    );
  });

  it.each([
    { mode: "off", toolThread: undefined, count: 0 },
    { mode: "off", toolThread: "inbound-thread", count: 1 },
    { mode: "all", toolThread: undefined, count: 1 },
    { mode: "all", toolThread: "inbound-thread", count: 0 },
  ] as const)(
    "mode=$mode toolThread=$toolThread across immediate and queued replies",
    async ({ mode, toolThread, count }) => {
      const payloads = [{ text: "The completed answer." }];
      const targets = [
        {
          tool: "message",
          provider: "test-flat",
          to: "room",
          threadId: toolThread,
          text: "The completed answer.",
        },
      ];
      const result = await buildReplyPayloads({
        config: {},
        payloads,
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: mode,
        replyToChannel: "test-flat",
        currentMessageId: "current-message",
        messageProvider: "test-flat",
        originatingTo: "room",
        originatingThreadId: "inbound-thread",
        messagingToolSentTargets: targets,
      });
      expect(result.replyPayloads).toHaveLength(count);
      expect(
        resolveFollowupDeliveryPayloads({
          cfg: {},
          payloads,
          messageProvider: "test-flat",
          originatingTo: "room",
          originatingThreadId: "inbound-thread",
          originatingReplyToMode: mode,
          sentTargets: targets,
        }),
      ).toHaveLength(count);
    },
  );
});
