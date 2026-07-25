// Mattermost tests cover reply delivery plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import {
  createMattermostReplyDeliveryBarrier,
  deliverMattermostReplyPayload,
} from "./reply-delivery.js";

type DeliverMattermostReplyPayloadParams = Parameters<typeof deliverMattermostReplyPayload>[0];
type ReplyDeliveryMarkdownTableMode = Parameters<
  DeliverMattermostReplyPayloadParams["core"]["channel"]["text"]["convertMarkdownTables"]
>[1];

function createReplyDeliveryCore(): DeliverMattermostReplyPayloadParams["core"] {
  return {
    channel: {
      text: {
        chunkByNewline: vi.fn((text: string) => [text]),
        chunkMarkdownText: vi.fn((text: string) => [text]),
        convertMarkdownTables: vi.fn((text: string) => text),
        chunkText: vi.fn((text: string) => [text]),
        chunkTextWithMode: vi.fn((text: string) => [text]),
        resolveMarkdownTableMode: vi.fn<() => ReplyDeliveryMarkdownTableMode>(() => "off"),
        resolveChunkMode: vi.fn<() => ChunkMode>(() => "length"),
        resolveTextChunkLimit: vi.fn(
          (
            _cfg?: OpenClawConfig,
            _provider?: string,
            _accountId?: string | null,
            opts?: { fallbackLimit?: number },
          ) => opts?.fallbackLimit ?? 4000,
        ),
        hasControlCommand: vi.fn(() => false),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime;
}

describe("createMattermostReplyDeliveryBarrier", () => {
  it("extends while direct deliveries or DM resolution remain unsettled", async () => {
    const barrier = createMattermostReplyDeliveryBarrier({ isDirect: true });
    const policy = barrier.resolveTimeoutPolicy({
      queuedCounts: { tool: 1, block: 0, final: 1 },
      humanDelayBudgetMs: 0,
    });
    expect(policy?.maxTimeoutMs).toBe(420_000);
    expect(policy?.shouldExtend()).toBe(true);

    let resolveResolution: () => void = () => {};
    const resolution = new Promise<void>((resolve) => {
      resolveResolution = resolve;
    });
    barrier.trackDmChannelResolution(resolution);
    expect(policy?.shouldExtend()).toBe(true);

    resolveResolution();
    await resolution;
    await Promise.resolve();
    expect(policy?.shouldExtend()).toBe(true);

    barrier.markDeliverySettled();
    expect(policy?.shouldExtend()).toBe(true);

    barrier.markDeliverySettled();
    expect(policy?.shouldExtend()).toBe(false);
  });

  it("stays extended between failed retries until queued deliveries settle", async () => {
    const barrier = createMattermostReplyDeliveryBarrier({ isDirect: true });
    const policy = barrier.resolveTimeoutPolicy({
      queuedCounts: { tool: 1, block: 0, final: 1 },
      humanDelayBudgetMs: 0,
    });
    let rejectResolution: (error: Error) => void = () => {};
    const resolution = new Promise<void>((_resolve, reject) => {
      rejectResolution = reject;
    });
    barrier.trackDmChannelResolution(resolution);

    rejectResolution(new Error("DM creation failed"));
    await expect(resolution).rejects.toThrow("DM creation failed");
    await Promise.resolve();
    barrier.markDeliverySettled();
    expect(policy?.shouldExtend()).toBe(true);

    barrier.markDeliverySettled();
    expect(policy?.shouldExtend()).toBe(false);
  });

  it("does not extend non-DM delivery", () => {
    const barrier = createMattermostReplyDeliveryBarrier({ isDirect: false });
    expect(
      barrier.resolveTimeoutPolicy({
        queuedCounts: { tool: 1, block: 1, final: 1 },
        humanDelayBudgetMs: 0,
      }),
    ).toBeUndefined();
  });
});

describe("deliverMattermostReplyPayload", () => {
  it("suppresses payloads flagged as reasoning", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    const outcome = await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "hidden", isReasoning: true },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(outcome).toBe("reasoning_skipped");
  });

  it("returns 'empty' for substantive text that produced no send (regression: #80501)", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();
    // Make the markdown table converter strip the text to empty so
    // deliverTextOrMediaReply sees an empty chunked text and returns "empty".
    core.channel.text.convertMarkdownTables = vi.fn(() => "");
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => []);

    const outcome = await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "non-trivial input that the converter strips" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(outcome).toBe("empty");
  });

  it("suppresses reasoning-prefixed payloads even without an explicit flag", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "  \n Reasoning:\n_hidden_" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses reasoning payloads formatted as a Mattermost blockquote", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "> Reasoning:\n> _hidden_" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not suppress messages that mention Reasoning: mid-text", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "Intro line\nReasoning: appears in content but is not a prefix" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      "Intro line\nReasoning: appears in content but is not a prefix",
      expect.objectContaining({
        cfg,
        accountId: "default",
        replyToId: "root-post",
      }),
    );
  });

  it("passes agent-scoped mediaLocalRoots when sending media paths", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const sendMessage = vi.fn(async () => undefined);
      const core = createReplyDeliveryCore();

      const agentId = "agent-1";
      const mediaUrl = `file://${path.join(stateDir, `workspace-${agentId}`, "photo.png")}`;
      const cfg = {} satisfies OpenClawConfig;

      await deliverMattermostReplyPayload({
        core,
        cfg,
        payload: { text: "caption", mediaUrl },
        to: "channel:town-square",
        accountId: "default",
        agentId,
        replyToId: "root-post",
        textLimit: 4000,
        tableMode: "off",
        sendMessage,
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "channel:town-square",
        "caption",
        expect.objectContaining({
          cfg,
          accountId: "default",
          mediaUrl,
          replyToId: "root-post",
          mediaLocalRoots: expect.arrayContaining([
            path.join(stateDir, "media"),
            path.join(stateDir, "canvas"),
            path.join(stateDir, "workspace"),
            path.join(stateDir, "sandboxes"),
            path.join(stateDir, `workspace-${agentId}`),
          ]),
        }),
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("forwards replyToId for text-only chunked replies", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => ["hello"]);

    const outcome = await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "hello" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      "hello",
      expect.objectContaining({
        cfg,
        accountId: "default",
        replyToId: "root-post",
      }),
    );
    expect(outcome).toBe("text");
  });
});
