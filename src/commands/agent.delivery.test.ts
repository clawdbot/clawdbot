import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverAgentCommandResult } from "../agents/command/delivery.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
  getChannelPlugin: vi.fn(() => ({})),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+15551234567" })),
}));

type DeliveryCall = {
  accountId?: string;
  session?: {
    agentId?: string;
    key?: string;
  };
};

type ResolveTargetCall = {
  accountId?: string;
  channel?: string;
  mode?: string;
  to?: string;
};

function readDeliveryCall(): DeliveryCall {
  expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
  const calls = mocks.deliverOutboundPayloads.mock.calls as unknown as Array<[unknown]>;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected delivery call");
  }
  return call as DeliveryCall;
}

function readResolveTargetCall(): ResolveTargetCall {
  expect(mocks.resolveOutboundTarget).toHaveBeenCalledOnce();
  const calls = mocks.resolveOutboundTarget.mock.calls as unknown as Array<[unknown]>;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected resolve target call");
  }
  return call as ResolveTargetCall;
}

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  getLoadedChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/targets.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/outbound/targets.js")>(
    "../infra/outbound/targets.js",
  );
  return {
    ...actual,
    resolveOutboundTarget: mocks.resolveOutboundTarget,
  };
});

describe("deliverAgentCommandResult", () => {
  function createRuntime(): RuntimeEnv {
    return {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
  }

  function createResult(text = "hi") {
    return {
      payloads: [{ text }],
      meta: { durationMs: 1 },
    };
  }

  async function runDelivery(params: {
    opts: Record<string, unknown>;
    outboundSession?: { key?: string; agentId?: string };
    sessionEntry?: SessionEntry;
    runtime?: RuntimeEnv;
    resultText?: string;
    payloads?: ReplyPayload[];
  }) {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = params.runtime ?? createRuntime();
    const result = params.payloads
      ? {
          payloads: params.payloads,
          meta: { durationMs: 1 },
        }
      : createResult(params.resultText);

    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: params.opts as never,
      outboundSession: params.outboundSession,
      sessionEntry: params.sessionEntry,
      result,
      payloads: result.payloads,
    });

    return { runtime };
  }

  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockClear();
    mocks.resolveOutboundTarget.mockClear();
  });

  it("prefers explicit accountId for outbound delivery", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        accountId: "kev",
        to: "+15551234567",
      },
      sessionEntry: {
        lastAccountId: "default",
      } as SessionEntry,
    });

    expect(readDeliveryCall().accountId).toBe("kev");
  });

  it("falls back to session accountId for implicit delivery", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
      },
      sessionEntry: {
        lastAccountId: "legacy",
        lastChannel: "whatsapp",
      } as SessionEntry,
    });

    expect(readDeliveryCall().accountId).toBe("legacy");
  });

  it("does not infer accountId for explicit delivery targets", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
        deliveryTargetMode: "explicit",
      },
      sessionEntry: {
        lastAccountId: "legacy",
      } as SessionEntry,
    });

    const targetCall = readResolveTargetCall();
    expect(targetCall.accountId).toBeUndefined();
    expect(targetCall.mode).toBe("explicit");
    expect(readDeliveryCall().accountId).toBeUndefined();
  });

  it("skips session accountId when channel differs", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
      },
      sessionEntry: {
        lastAccountId: "legacy",
        lastChannel: "telegram",
      } as SessionEntry,
    });

    const targetCall = readResolveTargetCall();
    expect(targetCall.accountId).toBeUndefined();
    expect(targetCall.channel).toBe("whatsapp");
  });

  it("uses session last channel when none is provided", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
      },
      sessionEntry: {
        lastChannel: "telegram",
        lastTo: "123",
      } as SessionEntry,
    });

    const targetCall = readResolveTargetCall();
    expect(targetCall.channel).toBe("telegram");
    expect(targetCall.to).toBe("123");
  });

  it("uses reply overrides for delivery routing", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        to: "+15551234567",
        replyTo: "#reports",
        replyChannel: "slack",
        replyAccountId: "ops",
      },
      sessionEntry: {
        lastChannel: "telegram",
        lastTo: "123",
        lastAccountId: "legacy",
      } as SessionEntry,
    });

    const targetCall = readResolveTargetCall();
    expect(targetCall.channel).toBe("slack");
    expect(targetCall.to).toBe("#reports");
    expect(targetCall.accountId).toBe("ops");
  });

  it("stays silent for intentional empty payloads", async () => {
    const runtime = createRuntime();

    await runDelivery({
      opts: {
        message: "hello",
      },
      runtime,
      payloads: [],
    });

    expect(runtime.log).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("uses runContext turn source over stale session last route", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        runContext: {
          messageChannel: "whatsapp",
          currentChannelId: "+15559876543",
          accountId: "work",
        },
      },
      sessionEntry: {
        lastChannel: "slack",
        lastTo: "U_WRONG",
        lastAccountId: "wrong",
      } as SessionEntry,
    });

    const targetCall = readResolveTargetCall();
    expect(targetCall.channel).toBe("whatsapp");
    expect(targetCall.to).toBe("+15559876543");
    expect(targetCall.accountId).toBe("work");
  });

  it("does not reuse session lastTo when runContext source omits currentChannelId", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        runContext: {
          messageChannel: "whatsapp",
        },
      },
      sessionEntry: {
        lastChannel: "slack",
        lastTo: "U_WRONG",
      } as SessionEntry,
    });

    const targetCall = readResolveTargetCall();
    expect(targetCall.channel).toBe("whatsapp");
    expect(targetCall.to).toBeUndefined();
  });

  it("uses caller-provided outbound session context when opts.sessionKey is absent", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
      },
      outboundSession: {
        key: "agent:exec:hook:gmail:thread-1",
        agentId: "exec",
      },
    });

    const deliveryCall = readDeliveryCall();
    expect(deliveryCall.session?.key).toBe("agent:exec:hook:gmail:thread-1");
    expect(deliveryCall.session?.agentId).toBe("exec");
  });

  it("prefixes nested agent outputs with context", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      resultText: "ANNOUNCE_SKIP",
      opts: {
        message: "hello",
        deliver: false,
        lane: "nested",
        sessionKey: "agent:main:main",
        runId: "run-announce",
        messageChannel: "webchat",
      },
      sessionEntry: undefined,
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect((runtime.log as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["[agent:nested] session=agent:main:main run=run-announce channel=webchat ANNOUNCE_SKIP"],
    ]);
  });

  it("prefixes per-session nested lanes with the same nested log context (#67502)", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      resultText: "ANNOUNCE_SKIP",
      opts: {
        message: "hello",
        deliver: false,
        lane: "nested:agent:ebao-next:quietchat:channel:1",
        sessionKey: "agent:ebao-next:quietchat:channel:1",
        runId: "run-announce",
        messageChannel: "webchat",
      },
      sessionEntry: undefined,
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect((runtime.log as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [
        "[agent:nested] session=agent:ebao-next:quietchat:channel:1 run=run-announce channel=webchat ANNOUNCE_SKIP",
      ],
    ]);
  });

  it("preserves audioAsVoice in JSON output envelopes", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      payloads: [{ text: "voice caption", mediaUrl: "file:///tmp/clip.mp3", audioAsVoice: true }],
      opts: {
        message: "hello",
        deliver: false,
        json: true,
      },
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String((runtime.log as ReturnType<typeof vi.fn>).mock.calls.at(0)?.[0])),
    ).toEqual({
      payloads: [
        {
          text: "voice caption",
          mediaUrl: "file:///tmp/clip.mp3",
          mediaUrls: ["file:///tmp/clip.mp3"],
          audioAsVoice: true,
        },
      ],
      meta: { durationMs: 1 },
    });
  });
});
