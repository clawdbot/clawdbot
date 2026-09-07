import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { formatMessageCliText } from "../../commands/message-format.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { resolveMessageActionOutcome } from "./message-action-contracts.js";
import { runMessageAction } from "./message-action-runner.js";

describe("broadcast send outcomes through native actions", () => {
  let tempHome: TempHomeEnv;
  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-broadcast-outcomes-");
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });
  afterAll(async () => {
    await tempHome.restore();
  });

  it.each<{
    name: string;
    payload: Record<string, unknown>;
    ok: boolean;
    sentBeforeError?: true;
  }>([
    {
      name: "native rejection",
      payload: { ok: false, error: "provider rejected message" },
      ok: false,
    },
    {
      name: "native rejection before send",
      payload: { ok: false, error: "rejected before send", sentBeforeError: false },
      ok: false,
    },
    { name: "native suppression", payload: { ok: false, warning: "send suppressed" }, ok: false },
    {
      name: "native partial failure",
      payload: {
        ok: false,
        error: "second part failed",
        sentBeforeError: true,
        messageId: "sent-part",
      },
      ok: false,
      sentBeforeError: true,
    },
    { name: "native success", payload: { ok: true, messageId: "sent-native" }, ok: true },
    { name: "legacy empty success", payload: {}, ok: true },
    {
      name: "nested receipt",
      payload: { ok: true, result: { messageId: "sent-nested" } },
      ok: true,
    },
  ])("preserves $name alongside a successful target", async ({ payload, ok, sentBeforeError }) => {
    const delivered: string[] = [];
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "broadcast-test" }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      outbound: {
        deliveryMode: "direct",
        sendText: async () => {
          throw new Error("native action bypassed");
        },
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async ({ params }) => {
          delivered.push(String(params.to));
          return jsonResult(params.to === "first" ? payload : { ok: true, messageId: "sent-2" });
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));

    const result = await runMessageAction({
      cfg: {},
      action: "broadcast",
      params: { channel: plugin.id, targets: ["first", "second"], message: "hello" },
    });

    expect(delivered).toEqual(["first", "second"]);
    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { to: "first", ok, payload },
          { to: "second", ok: true },
        ],
      },
    });
    expect(resolveMessageActionOutcome(result).ok).toBe(ok);
    expect(formatMessageCliText(result)[0]).toContain(ok ? "2/2 succeeded" : "1/2 succeeded");
    if (result.kind !== "broadcast") {
      throw new Error("Expected broadcast result");
    }
    expect(result.payload.results[0]?.sentBeforeError).toBe(sentBeforeError);
    expect(result.payload.results[0]?.payload).toBe(payload);
  });
});
