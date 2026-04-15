import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { buildTelegramThreadingToolContext } from "./threading-tool-context.js";

describe("buildTelegramThreadingToolContext", () => {
  it("keeps topic thread state in plugin-owned tool context", () => {
    expect(
      buildTelegramThreadingToolContext({
        cfg: {} as OpenClawConfig,
        accountId: "default",
        context: {
          To: "telegram:-1001:topic:77",
          MessageThreadId: 77,
          CurrentMessageId: "msg-1",
        },
        hasRepliedRef: { value: false },
      }),
    ).toMatchObject({
      currentChannelId: "telegram:-1001:topic:77",
      currentThreadTs: "77",
    });
  });

  it("parses topic thread state from target grammar when MessageThreadId is absent", () => {
    expect(
      buildTelegramThreadingToolContext({
        cfg: {} as OpenClawConfig,
        accountId: "default",
        context: {
          To: "telegram:-1001:topic:77",
          CurrentMessageId: "msg-1",
        },
      }),
    ).toMatchObject({
      currentChannelId: "telegram:-1001:topic:77",
      currentThreadTs: "77",
    });
  });
});
