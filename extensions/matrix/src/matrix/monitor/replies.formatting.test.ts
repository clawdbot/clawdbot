import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveMarkdownTableMode,
  type MarkdownTableMode,
} from "openclaw/plugin-sdk/markdown-table-runtime";
import { mediaKindFromMime } from "openclaw/plugin-sdk/media-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  type PluginRuntime,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import { setMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { sendMessageMatrix } from "../send.js";
import { deliverMatrixReplies } from "./replies.js";

const table = "| Name | Status |\n|---|---|\n| Alpha | Ready |";
const runtimeEnv = {} as RuntimeEnv;
const defaultCfg = { channels: { matrix: {} } } as CoreConfig;

function createClient() {
  let nextId = 0;
  const sendMessage = vi.fn(
    async (_roomId: string, _content: Record<string, unknown>) => `$sent-${++nextId}`,
  );
  const uploadContent = vi.fn(async () => "mxc://example.org/fixture");
  const client = {
    prepareRoomForMessageSend: async () => "m.room.message",
    getUserId: async () => "@bot:example.org",
    sendMessage,
    uploadContent,
  } as unknown as MatrixClient;
  return { client, sendMessage, uploadContent };
}

describe("Matrix automatic reply table presentation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
    );
    setMatrixRuntime({
      channel: {
        text: {
          resolveMarkdownTableMode,
          resolveTextChunkLimit,
          resolveChunkMode,
          chunkMarkdownTextWithMode,
        },
      },
      logging: { shouldLogVerbose: () => false },
      media: { mediaKindFromMime },
    } as unknown as PluginRuntime);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each([
    { name: "plugin default", mode: undefined, expected: "<table>" },
    { name: "explicit native tables", mode: "block", expected: "<table>" },
    { name: "explicit code tables", mode: "code", expected: "<pre><code>" },
    { name: "explicit bullet tables", mode: "bullets", expected: "<strong>Alpha</strong>" },
    { name: "disabled table parsing", mode: "off", expected: "| Name | Status |" },
  ] satisfies Array<{ name: string; mode: MarkdownTableMode | undefined; expected: string }>)(
    "uses the same native output for automatic and direct sends with $name",
    async ({ mode, expected }) => {
      const cfg = {
        channels: { matrix: mode ? { markdown: { tables: mode } } : {} },
      } as CoreConfig;
      const direct = createClient();
      await sendMessageMatrix("!room:example.org", table, { cfg, client: direct.client });
      const directContent = direct.sendMessage.mock.calls[0]?.[1];
      expect(directContent?.formatted_body).toContain(expected);

      const automatic = createClient();
      const result = await deliverMatrixReplies({
        cfg,
        replies: [{ text: table }],
        roomId: "!room:example.org",
        client: automatic.client,
        runtime: runtimeEnv,
        replyToMode: "off",
      });

      expect(result.visibleReplySent).toBe(true);
      expect(automatic.sendMessage).toHaveBeenCalledOnce();
      const automaticContent = automatic.sendMessage.mock.calls[0]?.[1];
      expect(automaticContent?.formatted_body).toContain(expected);
      expect(automaticContent).toEqual(directContent);
    },
  );

  it("keeps a native table within a long automatic reply while preserving code examples", async () => {
    const text = `${"Paragraph content. ".repeat(250)}\n\n${table}\n\n\`\`\`md\n${table}\n\`\`\`\n\n    indented code`;
    const automatic = createClient();
    const result = await deliverMatrixReplies({
      cfg: defaultCfg,
      replies: [{ text }],
      roomId: "!room:example.org",
      client: automatic.client,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    const contents = automatic.sendMessage.mock.calls.map((call) => call[1]);
    expect(result.visibleReplySent).toBe(true);
    expect(contents.length).toBeGreaterThan(1);
    expect(contents.every((content) => String(content.body).length <= 4000)).toBe(true);
    expect(contents.some((content) => String(content.formatted_body).includes("<table>"))).toBe(
      true,
    );
    expect(
      contents.some((content) =>
        String(content.formatted_body).includes('<pre><code class="language-md">'),
      ),
    ).toBe(true);
    expect(
      contents.some((content) =>
        String(content.formatted_body).includes("<pre><code>indented code"),
      ),
    ).toBe(true);
  });

  it("keeps native tables in automatic media captions", async () => {
    await withTempDir("matrix-native-table-caption-", async (tempDir) => {
      const localRoot = await fs.realpath(tempDir);
      const mediaPath = path.join(localRoot, "attachment.txt");
      await fs.writeFile(mediaPath, "caption attachment fixture");
      const { client, sendMessage, uploadContent } = createClient();

      await deliverMatrixReplies({
        cfg: defaultCfg,
        replies: [{ text: table, mediaUrl: mediaPath }],
        roomId: "!room:example.org",
        client,
        runtime: runtimeEnv,
        replyToMode: "off",
        mediaLocalRoots: [localRoot],
      });

      expect(uploadContent).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
        msgtype: "m.file",
        filename: "attachment.txt",
        formatted_body: expect.stringContaining("<table>"),
      });
    });
  });

  it.each([false, true])(
    "keeps first-reply relations and receipts across chunks (separate dispatch: %s)",
    async (separateDispatch) => {
      const { client, sendMessage } = createClient();
      const hasRepliedRef = { value: false };
      const delivery = {
        cfg: defaultCfg,
        roomId: "!room:example.org",
        client,
        runtime: runtimeEnv,
        replyToMode: "first" as const,
        replyToId: "$incoming",
        hasRepliedRef,
      };
      const first = await deliverMatrixReplies({
        ...delivery,
        replies: [
          { text: "Visible paragraph. ".repeat(400) },
          ...(!separateDispatch ? [{ text: "Next payload" }] : []),
        ],
      });
      const firstCount = sendMessage.mock.calls.length - (separateDispatch ? 0 : 1);
      expect(firstCount).toBeGreaterThan(1);
      expect(first.messageIds).toEqual(
        sendMessage.mock.calls.map((_, index) => `$sent-${index + 1}`),
      );
      expect(first.receipt?.primaryPlatformMessageId).toBe("$sent-1");
      expect(first.content).toBe(
        sendMessage.mock.calls.map(([, content]) => content.body).join("\n"),
      );
      expect(hasRepliedRef.value).toBe(true);
      for (const [, content] of sendMessage.mock.calls.slice(0, firstCount)) {
        expect(content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$incoming" } });
      }

      if (separateDispatch) {
        await deliverMatrixReplies({ ...delivery, replies: [{ text: "Next payload" }] });
      }
      expect(sendMessage).toHaveBeenCalledTimes(firstCount + 1);
      expect(sendMessage.mock.calls[firstCount]?.[1].body).toBe("Next payload");
      expect(sendMessage.mock.calls[firstCount]?.[1]["m.relates_to"]).toBeUndefined();
    },
  );

  it("preserves native thread fallback on every chunk with implicit replies disabled", async () => {
    const { client, sendMessage } = createClient();
    await deliverMatrixReplies({
      cfg: defaultCfg,
      replies: [{ text: "Thread paragraph. ".repeat(400) }],
      roomId: "!room:example.org",
      client,
      runtime: runtimeEnv,
      replyToMode: "off",
      threadId: "$thread",
      replyToId: "$incoming",
    });
    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (const [, content] of sendMessage.mock.calls) {
      expect(content["m.relates_to"]).toEqual({
        rel_type: "m.thread",
        event_id: "$thread",
        is_falling_back: true,
        "m.in_reply_to": { event_id: "$incoming" },
      });
    }
  });

  it("uses the account limit and canonical bullet fallback for an oversized native table", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => `| Item${index} | Ready${index} |`);
    const text = `| Name | Status |\n|---|---|\n${rows.join("\n")}`;
    const cfg = {
      channels: {
        matrix: { accounts: { ops: { textChunkLimit: 256, streaming: { chunkMode: "newline" } } } },
      },
    } as CoreConfig;
    const automatic = createClient();
    const direct = createClient();
    await sendMessageMatrix("!room:example.org", text, {
      cfg,
      accountId: "ops",
      client: direct.client,
    });
    await deliverMatrixReplies({
      cfg,
      accountId: "ops",
      replies: [{ text }],
      roomId: "!room:example.org",
      client: automatic.client,
      runtime: runtimeEnv,
      replyToMode: "off",
    });
    const bodies = automatic.sendMessage.mock.calls.map(([, content]) => content);
    expect(bodies).toEqual(direct.sendMessage.mock.calls.map(([, content]) => content));
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((content) => String(content.body).length <= 256)).toBe(true);
    const visible = bodies.map((content) => content.body).join("\n");
    for (let index = 0; index < rows.length; index++) {
      expect(visible).toContain(`Item${index}`);
      expect(visible).toContain(`Ready${index}`);
    }
    expect(
      bodies.some((content) => String(content.formatted_body).includes("<strong>Item0</strong>")),
    ).toBe(true);
  });

  it("retains the accepted event and first-reply slot when a later chunk fails", async () => {
    const { client, sendMessage } = createClient();
    sendMessage.mockImplementation(async () => {
      if (sendMessage.mock.calls.length === 2) {
        throw new Error("second wire event failed");
      }
      return "$accepted";
    });
    const hasRepliedRef = { value: false };
    const error = await deliverMatrixReplies({
      cfg: defaultCfg,
      replies: [{ text: "Visible paragraph. ".repeat(400) }],
      roomId: "!room:example.org",
      client,
      runtime: runtimeEnv,
      replyToMode: "first",
      replyToId: "$incoming",
      hasRepliedRef,
    }).catch((caught: unknown) => caught);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(hasRepliedRef.value).toBe(true);
    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$accepted"],
        visibleReplySent: true,
        content: sendMessage.mock.calls[0]?.[1].body,
        receipt: { parts: [expect.objectContaining({ replyToId: "$incoming" })] },
      },
    });
  });

  it("preserves significant whitespace in an automatic text reply", async () => {
    const { client, sendMessage } = createClient();
    const text = "    indented code\n\nHard break  \nnext line";
    await deliverMatrixReplies({
      cfg: defaultCfg,
      replies: [{ text }],
      roomId: "!room:example.org",
      client,
      runtime: runtimeEnv,
      replyToMode: "off",
    });
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      body: text,
      formatted_body: "<pre><code>indented code\n</code></pre>\n<p>Hard break<br>\nnext line</p>",
    });
  });
});
