/**
 * Regression test for issue #69546.
 *
 * The access stage must resolve the agent route against whatever
 * `cfg` is passed in on each call, not against a snapshot captured
 * once. This test simulates a binding update between two consecutive
 * inbound events and asserts the second route reflects the new
 * `bindings[]`.
 */

import { describe, expect, it, vi } from "vitest";
import type { QQBotInboundAccess } from "../../adapter/index.js";
import type { InboundPipelineDeps } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";
import type { GatewayAccount, GatewayPluginRuntime } from "../types.js";
import { runAccessStage } from "./access-stage.js";

interface StubBinding {
  match: { channel: string; accountPattern: string; peer?: string };
  agentId: string;
}

interface StubCfg {
  bindings: StubBinding[];
}

function buildAccount(overrides: Partial<GatewayAccount["config"]> = {}): GatewayAccount {
  return {
    accountId: "study",
    appId: "1000000",
    clientSecret: "secret",
    markdownSupport: false,
    config: {
      dmPolicy: "open",
      groupPolicy: "open",
      ...overrides,
    },
  };
}

function buildEvent(senderId: string): QueuedMessage {
  return {
    type: "c2c",
    senderId,
    content: "hi",
    messageId: `m-${senderId}`,
    timestamp: "0",
  };
}

function buildRuntime(
  resolve: GatewayPluginRuntime["channel"]["routing"]["resolveAgentRoute"],
): GatewayPluginRuntime {
  return {
    channel: {
      activity: { record: vi.fn() },
      routing: { resolveAgentRoute: resolve },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        resolveEffectiveMessagesConfig: vi.fn(() => ({})),
        finalizeInboundContext: vi.fn(),
        formatInboundEnvelope: vi.fn(() => ""),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
      },
      session: {
        resolveStorePath: vi.fn(() => ""),
        recordInboundSession: vi.fn(async () => undefined),
      },
      turn: { run: vi.fn(async () => undefined) },
      text: { chunkMarkdownText: vi.fn(() => []) },
    },
    tts: { textToSpeech: vi.fn() },
  };
}

function buildAllowAccess(): QQBotInboundAccess {
  return {
    senderAccess: { decision: "allow" },
  } as unknown as QQBotInboundAccess;
}

function buildDeps(
  cfg: unknown,
  runtime: GatewayPluginRuntime,
  account: GatewayAccount,
): InboundPipelineDeps {
  return {
    account,
    cfg,
    runtime,
    startTyping: vi.fn(),
    adapters: {
      access: {
        resolveInboundAccess: vi.fn(() => buildAllowAccess()),
        resolveSlashCommandAuthorization: vi.fn(() => true),
      },
    } as unknown as InboundPipelineDeps["adapters"],
  };
}

describe("runAccessStage — dynamic cfg routing (#69546)", () => {
  it("re-evaluates resolveAgentRoute against the cfg supplied on each call", async () => {
    const account = buildAccount();
    const peerId = "480562E9913A985D4A79822A643E27B6";

    const accountOnly: StubCfg = {
      bindings: [{ match: { channel: "qqbot", accountPattern: "study" }, agentId: "study" }],
    };
    const withPeer: StubCfg = {
      bindings: [
        {
          match: { channel: "qqbot", accountPattern: "study", peer: `direct:${peerId}` },
          agentId: "tutor",
        },
        { match: { channel: "qqbot", accountPattern: "study" }, agentId: "study" },
      ],
    };

    const captured: Array<{ cfg: unknown; peerId: string }> = [];
    const runtime = buildRuntime((params) => {
      const cfg = params.cfg as StubCfg;
      captured.push({ cfg, peerId: params.peer.id });
      const exact = cfg.bindings.find((b) => b.match.peer === `direct:${params.peer.id}`);
      const fallback = cfg.bindings.find((b) => !b.match.peer);
      const agent = exact?.agentId ?? fallback?.agentId;
      return { sessionKey: `qqbot:${params.peer.id}`, accountId: params.accountId, agentId: agent };
    });

    const event = buildEvent(peerId);

    const first = await runAccessStage(event, buildDeps(accountOnly, runtime, account));
    expect(first.kind).toBe("allow");
    if (first.kind === "allow") {
      expect(first.route.agentId).toBe("study");
    }

    const second = await runAccessStage(event, buildDeps(withPeer, runtime, account));
    expect(second.kind).toBe("allow");
    if (second.kind === "allow") {
      expect(second.route.agentId).toBe("tutor");
    }

    expect(captured).toHaveLength(2);
    expect(captured[0]?.cfg).toBe(accountOnly);
    expect(captured[1]?.cfg).toBe(withPeer);
  });

  it("never reads bindings from a previous cfg reference", async () => {
    const account = buildAccount();
    const seenCfgs = new Set<unknown>();
    const runtime = buildRuntime((params) => {
      seenCfgs.add(params.cfg);
      return { sessionKey: `s:${params.peer.id}`, accountId: params.accountId };
    });

    const cfgA: StubCfg = { bindings: [] };
    const cfgB: StubCfg = { bindings: [] };
    const cfgC: StubCfg = { bindings: [] };

    await runAccessStage(buildEvent("a"), buildDeps(cfgA, runtime, account));
    await runAccessStage(buildEvent("b"), buildDeps(cfgB, runtime, account));
    await runAccessStage(buildEvent("c"), buildDeps(cfgC, runtime, account));

    expect(seenCfgs.size).toBe(3);
    expect(seenCfgs.has(cfgA)).toBe(true);
    expect(seenCfgs.has(cfgB)).toBe(true);
    expect(seenCfgs.has(cfgC)).toBe(true);
  });
});
