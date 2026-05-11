import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";

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

describe("deliverMattermostReplyPayload", () => {
  it("suppresses payloads flagged as reasoning", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    await deliverMattermostReplyPayload({
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
      {
        cfg,
        accountId: "default",
        replyToId: "root-post",
      },
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
      expect(sendMessage).toHaveBeenCalledWith("channel:town-square", "caption", {
        cfg,
        accountId: "default",
        mediaUrl,
        replyToId: "root-post",
        mediaLocalRoots: [
          path.join(os.tmpdir(), "openclaw"),
          path.join(stateDir, "media"),
          path.join(stateDir, "canvas"),
          path.join(stateDir, "workspace"),
          path.join(stateDir, "sandboxes"),
          path.join(stateDir, `workspace-${agentId}`),
        ],
      });
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

    await deliverMattermostReplyPayload({
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
    expect(sendMessage).toHaveBeenCalledWith("channel:town-square", "hello", {
      cfg,
      accountId: "default",
      replyToId: "root-post",
    });
  });
});
