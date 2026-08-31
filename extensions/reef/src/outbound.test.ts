import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalBytes,
  generateIdentity,
  MemoryAuditStore,
  MemoryReplayStore,
  PipelineError,
  REEF_MAX_PLAINTEXT_BYTES,
} from "../protocol/index.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  guard,
  peerTrust,
  reefKeys,
  transport,
  trust,
} from "./flow.test-helpers.js";
import { reefMessageAdapter, reefOutboundAdapter } from "./outbound.js";
import { createReefRuntimeAuthority, getActiveReef } from "./runtime.js";
import type { ReefTransportClient } from "./transport.js";

describe("reefOutboundAdapter", () => {
  it("delegates delivery to the Gateway that owns the active encrypted flow", () => {
    expect(reefOutboundAdapter.deliveryMode).toBe("gateway");
  });

  it("removes internal tool text while preserving user-visible examples", () => {
    const sanitizeText = reefOutboundAdapter.sanitizeText;
    if (!sanitizeText) {
      throw new Error("expected Reef outbound sanitizeText hook");
    }
    const sanitize = (text: string) => sanitizeText({ text, payload: { text } });
    const fenced = ["```xml", '<tool_call>{"name":"exec"}</tool_call>', "```"].join("\n");

    expect(sanitize("Done.\n⚠️ 🛠️ `search repos (agent)` failed")).toBe("Done.");
    expect(sanitize('<tool_call>{"name":"exec"}</tool_call>Message sent.')).toBe("Message sent.");
    expect(sanitize("The encrypted message was delivered.")).toBe(
      "The encrypted message was delivered.",
    );
    expect(sanitize(fenced)).toBe(fenced);
    expect(sanitize("⚠️ 🛠️ `search repos (agent)` failed")).toBe("");
  });

  it("normalizes the SDK target and delegates only message content/context to the guarded flow", async () => {
    const order: string[] = [];
    const send = vi.fn(
      async (
        _peer: string,
        _text: string,
        context: { onPlatformSendDispatch?: () => Promise<void> },
      ) => {
        await context.onPlatformSendDispatch?.();
        order.push("send");
        return "01JZ0000000000000000000200";
      },
    );
    const onPlatformSendDispatch = vi.fn(async () => {
      order.push("dispatch");
    });
    createReefRuntimeAuthority().activate({ flow: { send }, friends: {}, reviews: {} } as never);

    await expect(
      reefOutboundAdapter.sendText!({
        cfg: {},
        accountId: "default",
        to: "reef:Alice",
        text: "hello",
        threadId: 42,
        replyToId: "01JZ0000000000000000000199",
        preparedMessageId: "01JZ0000000000000000000200",
        onPlatformSendDispatch,
      } as never),
    ).resolves.toEqual({
      channel: "reef",
      messageId: "01JZ0000000000000000000200",
      target: { kind: "chat", id: "alice" },
      toJid: "reef:alice",
    });
    expect(order).toEqual(["dispatch", "send"]);
    expect(send).toHaveBeenCalledWith("alice", "hello", {
      thread: "42",
      replyTo: "01JZ0000000000000000000199",
      messageId: "01JZ0000000000000000000200",
      onPlatformSendDispatch: expect.any(Function),
    });
  });

  it("marks message-adapter dispatch before encrypted transport I/O", async () => {
    const order: string[] = [];
    const send = vi.fn(
      async (
        _peer: string,
        _text: string,
        context: { onPlatformSendDispatch?: () => Promise<void> },
      ) => {
        await context.onPlatformSendDispatch?.();
        order.push("send");
        return "01JZ0000000000000000000200";
      },
    );
    createReefRuntimeAuthority().activate({ flow: { send }, friends: {}, reviews: {} } as never);

    await reefMessageAdapter.send.text({
      cfg: {},
      to: "reef:Alice",
      text: "hello",
      onPlatformSendDispatch: async () => {
        order.push("dispatch");
      },
    });

    expect(order).toEqual(["dispatch", "send"]);
  });

  it("revokes a borrowed encrypted flow before a paused guard reaches the replaced relay", async () => {
    const guardPaused = createDeferred<void>();
    const firstAuthority = createReefRuntimeAuthority();
    const classifier = {
      ...guard(allow),
      classify: vi.fn(async () => {
        await guardPaused.promise;
        return allow;
      }),
    };
    const relay = transport();
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust({ alice: peerTrust(generateIdentity()) }).store,
      keys: reefKeys(),
      transport: relay as unknown as ReefTransportClient,
      guard: classifier,
      audit: new MemoryAuditStore(new Uint8Array(32).fill(9)),
      replay: new MemoryReplayStore(),
      // The send path consults the review store before classifying.
      reviews: { lookupDecision: async () => "none", request: async () => undefined } as never,
      delivered: {} as never,
      authoritySignal: firstAuthority.signal,
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    firstAuthority.activate({ flow, friends: {}, reviews: {} } as never);
    const stale = reefMessageAdapter.send.text({ cfg: {}, to: "reef:alice", text: "stale" });
    await vi.waitFor(() => expect(classifier.classify).toHaveBeenCalledOnce());

    const replacementAuthority = createReefRuntimeAuthority();
    const replacement = { flow: {}, friends: {}, reviews: {} } as never;
    replacementAuthority.activate(replacement);
    try {
      guardPaused.resolve();
      const staleResult = await stale.catch((error: unknown) => error);

      expect(relay.sendEnvelope).not.toHaveBeenCalled();
      expect(staleResult).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(getActiveReef()).toBe(replacement);
    } finally {
      replacementAuthority.release();
      firstAuthority.release();
    }
  });

  it("proves local flow failures happened before platform dispatch", async () => {
    const cause = new Error("guard denied");
    const send = vi.fn(async () => {
      throw cause;
    });
    createReefRuntimeAuthority().activate({ flow: { send }, friends: {}, reviews: {} } as never);

    const error = await reefMessageAdapter.send
      .text({
        cfg: {},
        to: "reef:Alice",
        text: "hello",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ cause, retryable: true });
  });

  it("terminally rejects local Reef policy denials", async () => {
    const cause = new PipelineError("guard", "guard denied", {
      decision: "deny",
      category: "confidential",
      reason: "Denied.",
      model: "gpt-5.6-sol",
      policyVersion: "reef-v1",
    });
    const send = vi.fn(async () => {
      throw cause;
    });
    createReefRuntimeAuthority().activate({ flow: { send }, friends: {}, reviews: {} } as never);

    const error = await reefMessageAdapter.send
      .text({ cfg: {}, to: "reef:Alice", text: "hello" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ cause, retryable: false });
  });

  it("terminally rejects unapproved Reef peers", async () => {
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust({}).store,
      keys: reefKeys(),
      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(9)),
      replay: new MemoryReplayStore(),
      reviews: {} as never,
      delivered: {} as never,
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    createReefRuntimeAuthority().activate({ flow, friends: {}, reviews: {} } as never);

    const error = await reefMessageAdapter.send
      .text({ cfg: {}, to: "reef:Alice", text: "hello" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({
      cause: {
        name: "ReefOutboundRejectedError",
        message: expect.stringContaining("not approved"),
      },
      retryable: false,
    });
  });

  it("keeps guard availability failures retryable before dispatch", async () => {
    const cause = new PipelineError("guard", "guard unavailable", {
      decision: "deny",
      category: "guard_failure",
      reason: "Guard unavailable or invalid.",
      model: "gpt-5.6-sol",
      policyVersion: "reef-v1",
    });
    const send = vi.fn(async () => {
      throw cause;
    });
    createReefRuntimeAuthority().activate({ flow: { send }, friends: {}, reviews: {} } as never);

    const error = await reefMessageAdapter.send
      .text({ cfg: {}, to: "reef:Alice", text: "hello" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ cause, retryable: true });
  });

  it("keeps published dispatch ambiguous when account authority closes", async () => {
    const cause = new Error("relay outcome unknown");
    const authority = createReefRuntimeAuthority();
    const send = vi.fn(
      async (
        _peer: string,
        _text: string,
        context: { onPlatformSendDispatch?: () => Promise<void> },
      ) => {
        await context.onPlatformSendDispatch?.();
        throw cause;
      },
    );
    const onPlatformSendDispatch = vi.fn(async () => authority.release());
    authority.activate({ flow: { send }, friends: {}, reviews: {} } as never);

    const error = await reefMessageAdapter.send
      .text({
        cfg: {},
        to: "reef:Alice",
        text: "hello",
        onPlatformSendDispatch,
      })
      .catch((caught: unknown) => caught);

    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(error).toBe(cause);
  });

  it("prepares a protocol-valid id without requiring an active Gateway runtime", () => {
    const first = reefOutboundAdapter.prepareConversationTurnMessageId!({
      cfg: {},
      to: "reef:alice",
      text: "hello",
    });
    const second = reefOutboundAdapter.prepareConversationTurnMessageId!({
      cfg: {},
      to: "reef:alice",
      text: "again",
    });

    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(second).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(second > first).toBe(true);
  });

  it("rejects oversized correlated text during pre-queue id preparation", () => {
    expect(() =>
      reefOutboundAdapter.prepareConversationTurnMessageId!({
        cfg: {},
        to: "reef:alice",
        text: "x".repeat(32 * 1024),
      }),
    ).toThrow("atomic message limit");
  });

  it("permanently rejects correlated text enlarged after its initial preflight", async () => {
    const rawText = "x".repeat(REEF_MAX_PLAINTEXT_BYTES - 256);
    const preparedMessageId = reefOutboundAdapter.prepareConversationTurnMessageId!({
      cfg: {},
      to: "reef:alice",
      text: rawText,
    });
    const send = vi.fn(async () => "01JZ0000000000000000000200");
    createReefRuntimeAuthority().activate({ flow: { send }, friends: {}, reviews: {} } as never);

    const error = await reefOutboundAdapter.sendText!({
      cfg: {},
      accountId: "default",
      to: "reef:alice",
      text: `${"p".repeat(512)} ${rawText}`,
      preparedMessageId,
    } as never).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({
      message: expect.stringContaining("atomic message limit"),
      retryable: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("chunks ordinary text by canonical plaintext bytes", () => {
    const text = `${"a".repeat(40_000)}${"🦞".repeat(10_000)}`;
    const chunks = reefOutboundAdapter.chunker!(text, REEF_MAX_PLAINTEXT_BYTES);

    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(
        canonicalBytes({
          text: chunk,
          replyTo: "0".repeat(26),
          thread: "0".repeat(26),
        }).length,
      ).toBeLessThanOrEqual(REEF_MAX_PLAINTEXT_BYTES);
    }
  });

  it("honors a stricter configured chunk limit", () => {
    const chunks = reefOutboundAdapter.chunker!("🦞".repeat(2_000), 1_024);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(
        canonicalBytes({
          text: chunk,
          replyTo: "0".repeat(26),
          thread: "0".repeat(26),
        }).length,
      ).toBeLessThanOrEqual(1_024);
    }
  });

  it("searches chunk boundaries only between complete Unicode code points", () => {
    const limit = canonicalBytes({
      text: "🦞",
      replyTo: "0".repeat(26),
      thread: "0".repeat(26),
    }).length;

    expect(reefOutboundAdapter.chunker!("🦞🦞🦞", limit)).toEqual(["🦞", "🦞", "🦞"]);
  });
});
