// Whatsapp tests cover auto reply.broadcast groups.combined plugin behavior.
import "./test-helpers.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  monitorWebChannelWithCapture,
  sendWebDirectInboundAndCollectSessionKeys,
} from "./auto-reply.broadcast-groups.test-harness.js";
import {
  createWebInboundDeliverySpies,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  sendWebDirectInboundMessage,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import { createTestWebInboundMessage } from "./inbound/test-message.test-helper.js";

installWebAutoReplyTestHomeHooks();

describe("broadcast groups", () => {
  installWebAutoReplyUnitTestHooks();

  it("skips unknown broadcast agent ids when agents.list is present", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "+1000": ["alfred", "missing"],
      },
    } satisfies OpenClawConfig);

    const { seen, resolver } = await sendWebDirectInboundAndCollectSessionKeys();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen[0]).toContain("agent:alfred:");
    resetLoadConfigMock();
  });

  it("broadcasts sequentially in configured order", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      bindings: [{ agentId: "alfred", match: { channel: "whatsapp", accountId: "default" } }],
      broadcast: {
        strategy: "sequential",
        "+1000": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const { seen, resolver } = await sendWebDirectInboundAndCollectSessionKeys();

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(seen[0]).toContain("agent:alfred:");
    expect(seen[1]).toContain("agent:baerbel:");
    resetLoadConfigMock();
  });

  it("applies recipient and strategy changes on the same active listener", async () => {
    const base = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      bindings: [{ agentId: "alfred", match: { channel: "whatsapp", accountId: "default" } }],
    } satisfies OpenClawConfig;
    const phases = [
      { strategy: "sequential", recipients: ["alfred"] },
      { strategy: "parallel", recipients: ["alfred", "baerbel"] },
      { strategy: "sequential", recipients: ["baerbel", "alfred"] },
      { strategy: "sequential", recipients: ["baerbel"] },
    ] as const;
    let phase: (typeof phases)[number] = phases[0];
    const configure = () =>
      setLoadConfigMock({
        ...base,
        broadcast: { strategy: phase.strategy, "+1000": [...phase.recipients] },
      } satisfies OpenClawConfig);
    let active = 0;
    let peak = 0;
    let gate = createDeferred<void>();
    const seen: Array<{ agent: string; strategy?: string }> = [];
    const resolver = vi.fn(
      async (ctx: { SessionKey?: unknown }, _opts: unknown, cfg: OpenClawConfig) => {
        seen.push({
          agent: String(ctx.SessionKey).split(":")[1] ?? "",
          strategy: cfg.broadcast?.strategy,
        });
        active += 1;
        peak = Math.max(peak, active);
        if (phase.strategy === "parallel" && active === 1) {
          await gate.promise;
        }
        await Promise.resolve();
        active -= 1;
        return { text: "ok" };
      },
    );
    configure();
    const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);
    try {
      for (const [index, next] of phases.entries()) {
        phase = next;
        configure();
        seen.length = 0;
        peak = 0;
        gate = createDeferred<void>();
        const delivery = sendWebDirectInboundMessage({
          onMessage,
          spies,
          id: `reload-${index}`,
          from: "+1000",
          to: "+2000",
          body: "hello",
        });
        try {
          if (phase.strategy === "parallel") {
            await vi.waitFor(() => expect(peak).toBe(2));
          }
        } finally {
          // A failed concurrency assertion must release the first recipient before teardown.
          gate.resolve();
          await delivery;
        }
        const expected = phase.recipients.map((agent) => ({ agent, strategy: phase.strategy }));
        expect(seen).toHaveLength(expected.length);
        expect(seen).toEqual(
          phase.strategy === "parallel" ? expect.arrayContaining(expected) : expected,
        );
        expect(peak).toBe(phase.strategy === "parallel" ? 2 : 1);
        expect(active).toBe(0);
      }
    } finally {
      resetLoadConfigMock();
    }
  });

  it("shares group history across broadcast agents and clears after replying", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      bindings: [{ agentId: "alfred", match: { channel: "whatsapp", accountId: "default" } }],
      broadcast: {
        strategy: "sequential",
        "123@g.us": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "hello group",
      id: "g1",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
    });

    expect(resolver).not.toHaveBeenCalled();

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "@bot ping",
      id: "g2",
      senderE164: "+222",
      senderName: "Bob",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });

    expect(resolver).toHaveBeenCalledTimes(2);
    for (const call of resolver.mock.calls.slice(0, 2)) {
      const payload = call[0] as {
        Body: string;
        SenderName?: string;
        SenderE164?: string;
        SenderId?: string;
      };
      expect(payload.Body).toContain("Chat messages since your last reply");
      expect(payload.Body).toContain("Alice (+111): hello group");
      expect(payload.Body).not.toContain("[message_id:");
      expect(payload.Body).toContain("@bot ping");
      expect(payload.SenderName).toBe("Bob");
      expect(payload.SenderE164).toBe("+222");
      expect(payload.SenderId).toBe("+222");
    }

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "@bot ping 2",
      id: "g3",
      senderE164: "+333",
      senderName: "Clara",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });

    expect(resolver).toHaveBeenCalledTimes(4);
    for (const call of resolver.mock.calls.slice(2, 4)) {
      const payload = call[0] as { Body: string };
      expect(payload.Body).not.toContain("Alice (+111): hello group");
      expect(payload.Body).not.toContain("Chat messages since your last reply");
    }

    resetLoadConfigMock();
  });

  it("keeps named-account group broadcast routes on the scoped session key", async () => {
    setLoadConfigMock({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          accounts: {
            work: {
              allowFrom: ["*"],
            },
          },
        },
      },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      bindings: [{ agentId: "alfred", match: { channel: "whatsapp", accountId: "work" } }],
      broadcast: {
        strategy: "sequential",
        "123@g.us": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const seen: string[] = [];
    const resolver = vi.fn(async (ctx: { SessionKey?: unknown }) => {
      seen.push(String(ctx.SessionKey));
      return { text: "ok" };
    });

    const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "@bot ping",
      id: "g-work-1",
      senderE164: "+111",
      senderName: "Alice",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      accountId: "work",
    });

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      "agent:alfred:whatsapp:group:123@g.us:thread:whatsapp-account-work",
      "agent:baerbel:whatsapp:group:123@g.us:thread:whatsapp-account-work",
    ]);
    resetLoadConfigMock();
  });

  it("broadcasts in parallel by default", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      bindings: [{ agentId: "alfred", match: { channel: "whatsapp", accountId: "default" } }],
      broadcast: {
        strategy: "parallel",
        "+1000": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const { sendMedia, reply, sendComposing } = createWebInboundDeliverySpies();

    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const resolver = vi.fn(async () => {
      started += 1;
      if (started < 2) {
        await gate;
      } else {
        release?.();
      }
      return { text: "ok" };
    });

    const { onMessage: capturedOnMessage } = await monitorWebChannelWithCapture(resolver);

    await capturedOnMessage(
      createTestWebInboundMessage({
        event: {
          id: "m1",
          timestamp: Date.now(),
        },
        payload: {
          body: "hello",
        },
        platform: {
          chatJid: "direct:+1000",
          recipientJid: "+2000",
          sendComposing,
          reply,
          sendMedia,
        },
        admission: {
          accountId: "default",
          conversation: {
            kind: "direct",
            id: "+1000",
          },
        },
      }),
    );

    expect(resolver).toHaveBeenCalledTimes(2);
    resetLoadConfigMock();
  });
});
