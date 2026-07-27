// Regression coverage for openclaw-p3j: app-server/embedded-runner sends
// never carry the gateway's trusted current-source route tag (the embedded
// path's sibling of openclaw-kg9, which only patched the CLI runner), so the
// handler must verify the route itself to keep an explicit-route reply to
// the current source counted as a source reply (and not trip stranded-reply
// recovery).
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { embeddedSendResolvesToCurrentSource } from "./embedded-agent-send-resolution.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";

const CURRENT_CHANNEL_ID = "C0B2EDDPW95";

function makeContext(overrides: Record<string, unknown> = {}): Pick<ToolHandlerContext, "params"> {
  return {
    params: {
      messageChannel: "slack",
      currentChannelId: CURRENT_CHANNEL_ID,
      sessionKey: "agent:tank:test",
      ...overrides,
    },
  } as unknown as Pick<ToolHandlerContext, "params">;
}

describe("embeddedSendResolvesToCurrentSource", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: { normalizeTarget: (raw: string) => raw.trim() || undefined },
            actions: {
              extractToolSend: ({ args }: { args: Record<string, unknown> }) =>
                typeof args.to === "string" ? { to: args.to } : null,
            },
          },
          source: "test",
        },
      ]),
    );
  });

  it("treats an explicit route to the current source as a current-source reply", () => {
    expect(
      embeddedSendResolvesToCurrentSource(makeContext(), "message", {
        action: "send",
        channel: "slack",
        to: CURRENT_CHANNEL_ID,
        message: "reply",
      }),
    ).toBe(true);
  });

  it("rejects an explicit route to a different conversation", () => {
    expect(
      embeddedSendResolvesToCurrentSource(makeContext(), "message", {
        action: "send",
        channel: "slack",
        to: "C-SOMEWHERE-ELSE",
        message: "reply",
      }),
    ).toBe(false);
  });

  it("treats an implicit routeless send as the current source", () => {
    expect(
      embeddedSendResolvesToCurrentSource(makeContext(), "message", {
        action: "send",
        message: "reply",
      }),
    ).toBe(true);
  });

  it("matches when the provider is inferred from the current message channel rather than stated explicitly", () => {
    // Mirrors applyCurrentMessageProvider: neither call states `provider`/
    // `channel` explicitly, so both resolve it from ctx.params.messageChannel
    // identically — this is what keeps the target/reference comparison from
    // drifting when the agent's send omits provider but the channel plugin
    // still needs one to extract a target.
    expect(
      embeddedSendResolvesToCurrentSource(makeContext(), "message", {
        action: "send",
        to: CURRENT_CHANNEL_ID,
        message: "reply",
      }),
    ).toBe(true);
  });

  it("returns false when there is no current channel to resolve against", () => {
    expect(
      embeddedSendResolvesToCurrentSource(
        makeContext({ currentChannelId: undefined, messageChannel: undefined }),
        "message",
        { action: "send", channel: "slack", to: CURRENT_CHANNEL_ID, message: "reply" },
      ),
    ).toBe(false);
  });

  it("ignores non-message tools", () => {
    expect(
      embeddedSendResolvesToCurrentSource(makeContext(), "sessions_send", {
        action: "send",
        to: CURRENT_CHANNEL_ID,
        message: "reply",
      }),
    ).toBe(false);
  });
});
