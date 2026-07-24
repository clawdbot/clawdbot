// History image prune tests keep provider replay compact by replacing stale
// image bytes and fact-owned projections while preserving recent user context.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ImageContent } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  attachRuntimePromptMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../../media/media-facts.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import {
  installHistoryImagePruneContextTransform,
  pruneProcessedHistoryImages,
} from "./history-image-prune.js";

const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";
const PRUNED_HISTORY_MEDIA_REFERENCE_MARKER =
  "[media reference removed - already processed by model]";
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";

function expectArrayMessageContent(
  message: AgentMessage | undefined,
  errorMessage: string,
): Array<{ type: string; text?: string; data?: string }> {
  if (!message || !("content" in message) || !Array.isArray(message.content)) {
    throw new Error(errorMessage);
  }
  return message.content as Array<{ type: string; text?: string; data?: string }>;
}

function expectContentBlock(
  block: { type: string; text?: string; data?: string } | undefined,
  expected: { type: string; text?: string; data?: string },
) {
  expect(block?.type).toBe(expected.type);
  if ("text" in expected) {
    expect(block?.text).toBe(expected.text);
  }
  if ("data" in expected) {
    expect(block?.data).toBe(expected.data);
  }
}

function expectPrunedImageMessage(
  messages: AgentMessage[],
  errorMessage: string,
): Array<{ type: string; text?: string; data?: string }> {
  const pruned = expectPrunedMessages(messages);
  const content = expectArrayMessageContent(pruned[0], errorMessage);
  expect(content).toHaveLength(2);
  expectContentBlock(content[1], { type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
  return content;
}

function expectPrunedMessages(messages: AgentMessage[]): AgentMessage[] {
  const pruned = pruneProcessedHistoryImages(messages);
  expect(Array.isArray(pruned)).toBe(true);
  if (!pruned) {
    throw new Error("expected pruned history messages");
  }
  expect(pruned).not.toBe(messages);
  return pruned;
}

function expectImageMessagePreserved(messages: AgentMessage[], errorMessage: string) {
  const pruned = pruneProcessedHistoryImages(messages);

  expect(pruned).toBeNull();
  const content = expectArrayMessageContent(messages[0], errorMessage);
  expectContentBlock(content[1], { type: "image", data: "abc" });
}

function oldEnoughTail(): AgentMessage[] {
  // Four assistant turns makes the first message old enough to prune while
  // keeping each test focused on content rewriting instead of turn counting.
  const assistantTurn = () => castAgentMessage({ role: "assistant", content: "ack" });
  const userText = () => castAgentMessage({ role: "user", content: "more" });
  return [
    assistantTurn(),
    userText(),
    assistantTurn(),
    userText(),
    assistantTurn(),
    userText(),
    assistantTurn(),
  ];
}

describe("pruneProcessedHistoryImages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
  const assistantTurn = () => castAgentMessage({ role: "assistant", content: "ack" });
  const userText = () => castAgentMessage({ role: "user", content: "more" });

  it("prunes image blocks from user messages older than 3 assistant turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    const content = expectPrunedImageMessage(messages, "expected user array content");
    expect(content[0]?.type).toBe("text");
  });

  it("strips explicit-image provenance when its old image block is pruned", () => {
    const message = castAgentMessage({
      role: "user",
      content: [{ type: "text", text: "explicit image" }, { ...image }],
      __openclaw: {
        mediaImageBlockFactIndexes: [null],
        mediaImageLayout: { slots: [{ kind: "inline" }] },
      },
    });

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const meta = (pruned[0] as unknown as Record<string, unknown>)["__openclaw"];

    expect(meta).toBeUndefined();
  });

  it("redacts factless legacy attachment text while pruning old image blocks", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "old image",
              "[media attached: media://inbound/old.png]",
              "[media attached 1/2: /tmp/old photo.jpeg (image/jpeg) | https://example.test/img]",
              "[Image: source: /Users/me/Pictures/old.jpg]",
            ].join("\n"),
          },
          { ...image },
        ],
      }),
      ...oldEnoughTail(),
    ];

    const pruned = expectPrunedMessages(messages);

    const content = expectArrayMessageContent(pruned[0], "expected user array content");
    expect(content[0]?.text).toBe(
      [
        "old image",
        PRUNED_HISTORY_MEDIA_REFERENCE_MARKER,
        PRUNED_HISTORY_MEDIA_REFERENCE_MARKER,
        PRUNED_HISTORY_MEDIA_REFERENCE_MARKER,
      ].join("\n"),
    );
    expectContentBlock(content[1], { type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
    const originalContent = expectArrayMessageContent(
      messages[0],
      "expected original user content",
    );
    expect(originalContent[0]?.text).toContain("[media attached: media://inbound/old.png]");
    expectContentBlock(originalContent[1], { type: "image", data: "abc" });
  });

  it("redacts factless legacy attachment text without image blocks", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: "please remember [media attached: media://inbound/stale-image.png]",
      }),
      ...oldEnoughTail(),
    ];

    const pruned = expectPrunedMessages(messages);
    const user = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(user?.content).toBe(`please remember ${PRUNED_HISTORY_MEDIA_REFERENCE_MARKER}`);
  });

  it("prunes fact-owned and factless legacy late-media projections", () => {
    const fields = {
      role: "user" as const,
      MediaPath: "media://inbound/stale-image.png",
      MediaPaths: ["media://inbound/stale-image.png"],
    };
    const markedString = castAgentMessage({
      ...fields,
      content: "",
      __openclaw: { lateMedia: true },
    });
    const legacyString = castAgentMessage({
      content: "[media attached: media://inbound/stale-image.png]",
      role: "user",
    });
    const markedArray = castAgentMessage({
      ...fields,
      content: [{ ...image }],
      __openclaw: { lateMedia: true },
    });
    const legacyArray = castAgentMessage({
      role: "user",
      content: [
        { type: "text", text: "[media attached: media://inbound/stale-image.png]" },
        { ...image },
      ],
    });

    const prunedMarkedString = expectPrunedMessages([markedString, ...oldEnoughTail()]);
    const prunedLegacyString = expectPrunedMessages([legacyString, ...oldEnoughTail()]);
    const prunedMarkedArray = expectPrunedMessages([markedArray, ...oldEnoughTail()]);
    const prunedLegacyArray = expectPrunedMessages([legacyArray, ...oldEnoughTail()]);
    const markedStringOutput = prunedMarkedString as unknown as Array<{ content?: unknown }>;
    const markedArrayOutput = prunedMarkedArray as unknown as Array<{ content?: unknown }>;
    const legacyStringOutput = prunedLegacyString as unknown as Array<{ content?: unknown }>;
    const legacyArrayOutput = prunedLegacyArray as unknown as Array<{ content?: unknown }>;

    expect(markedStringOutput[0]?.content).toBe(PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
    expect(legacyStringOutput[0]?.content).toBe(PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
    expect(markedArrayOutput[0]?.content).toEqual([
      { type: "text", text: PRUNED_HISTORY_MEDIA_REFERENCE_MARKER },
      { type: "text", text: PRUNED_HISTORY_IMAGE_MARKER },
    ]);
    expect(legacyArrayOutput[0]?.content).toEqual([
      { type: "text", text: PRUNED_HISTORY_MEDIA_REFERENCE_MARKER },
      { type: "text", text: PRUNED_HISTORY_IMAGE_MARKER },
    ]);
  });

  it("does not replace a distinct caption on an old marked late-media turn", () => {
    const message = castAgentMessage({
      role: "user",
      content: "resolved subtitle",
      MediaPath: "media://inbound/stale-image.png",
      MediaPaths: ["media://inbound/stale-image.png"],
      __openclaw: { lateMedia: true },
    });

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const output = pruned as unknown as Array<{ content?: unknown; MediaPath?: unknown }>;
    expect(output[0]?.content).toBe("resolved subtitle");
    expect(output[0]?.MediaPath).toBeUndefined();
  });

  it("drops runtime facts from captioned old turns without changing their text", () => {
    const message = attachRuntimePromptMediaFacts(
      castAgentMessage({ role: "user", content: "caption stays byte-identical" }),
      [{ path: "/tmp/stale.png", contentType: "image/png" }],
    );

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const firstUser = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe("caption stays byte-identical");
    expect(firstUser && readRuntimePromptMediaFacts(firstUser)).toBeUndefined();
    expect(readRuntimePromptMediaFacts(message)).toHaveLength(1);
  });

  it("redacts the exact fact-owned projection from a captioned old turn", () => {
    const imagePath = "/tmp/stale-owned.png";
    const message = attachRuntimePromptMediaFacts(
      castAgentMessage({
        role: "user",
        content: `[media attached: ${imagePath} (image/png)]\n\ncaption stays`,
      }),
      [{ path: imagePath, contentType: "image/png" }],
    );

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const firstUser = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe(`${PRUNED_HISTORY_MEDIA_REFERENCE_MARKER}\n\ncaption stays`);
  });

  it("redacts a persisted fact projection with a distinct URL", () => {
    const imagePath = "/tmp/stale-owned.png";
    const imageUrl = "https://example.test/stale-owned.png";
    const message = castAgentMessage({
      role: "user",
      content: `[media attached: ${imagePath} (image/png) | ${imageUrl}]`,
      __openclaw: {
        media: [
          {
            path: imagePath,
            url: imageUrl,
            contentType: "image/png",
            hydrationSuppressed: true,
          },
        ],
      },
    });

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const firstUser = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe(PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
  });

  it("redacts a persisted relative projection after legacy path canonicalization", () => {
    const message = buildPersistedUserTurnMessage({
      text: "[media attached: ./old.png (image/png)]",
      media: [
        {
          path: "./old.png",
          workspaceDir: "/workspace",
          contentType: "image/png",
        },
      ],
    }) as AgentMessage;

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const firstUser = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe(PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
  });

  it("redacts a persisted relative projection without a dot prefix", () => {
    const message = buildPersistedUserTurnMessage({
      text: "[media attached: sub/old.png (image/png)]",
      media: [
        {
          path: "sub/old.png",
          workspaceDir: "/workspace",
          contentType: "image/png",
        },
      ],
    }) as AgentMessage;

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const firstUser = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe(PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
  });

  it("does not claim a basename-only marker for an absolute owned fact", () => {
    const message = buildPersistedUserTurnMessage({
      text: "caption mentions [media attached: ./photo.png (image/png)]",
      media: [{ path: "/workspace/sub/photo.png", contentType: "image/png" }],
    }) as AgentMessage;

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const firstUser = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe("caption mentions [media attached: ./photo.png (image/png)]");
  });

  it("preserves an unrelated legacy-shaped marker in a fact-backed caption", () => {
    const message = buildPersistedUserTurnMessage({
      text: "caption mentions [media attached: ./unrelated.png (image/png)]",
      media: [{ path: "./owned.png", workspaceDir: "/workspace", contentType: "image/png" }],
    }) as AgentMessage;

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const firstUser = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe(
      "caption mentions [media attached: ./unrelated.png (image/png)]",
    );
  });

  it("redacts separately projected fact lines in distinct text blocks", () => {
    const firstPath = "/tmp/first-owned.png";
    const secondPath = "/tmp/second-owned.png";
    const message = attachRuntimePromptMediaFacts(
      castAgentMessage({
        role: "user",
        content: [
          { type: "text", text: `[media attached: ${firstPath} (image/png)]` },
          { type: "text", text: `[media attached: ${secondPath} (image/png)]` },
        ],
      }),
      [
        { path: firstPath, contentType: "image/png" },
        { path: secondPath, contentType: "image/png" },
      ],
    );

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    expect(expectArrayMessageContent(pruned[0], "expected redacted text blocks")).toEqual([
      { type: "text", text: PRUNED_HISTORY_MEDIA_REFERENCE_MARKER },
      { type: "text", text: PRUNED_HISTORY_MEDIA_REFERENCE_MARKER },
    ]);
  });

  it("redacts a fact-backed legacy image-source projection", () => {
    const imagePath = "/tmp/legacy-owned.jpg";
    const message = castAgentMessage({
      role: "user",
      content: `[Image: source: ${imagePath}]\ncaption stays`,
      MediaPath: imagePath,
      MediaPaths: [imagePath],
      MediaType: "image/jpeg",
      MediaTypes: ["image/jpeg"],
    });

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const firstUser = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe(`${PRUNED_HISTORY_MEDIA_REFERENCE_MARKER}\ncaption stays`);
  });

  it("preserves a bare claim-check URI in a fact-backed caption", () => {
    const mediaRef = "media://inbound/captioned.png";
    const message = castAgentMessage({
      role: "user",
      content: `caption mentions ${mediaRef} as text`,
      MediaPath: mediaRef,
      MediaPaths: [mediaRef],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const firstUser = pruned[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe(`caption mentions ${mediaRef} as text`);
  });

  it("redacts bare old inbound media URIs from factless tool results", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "toolResult",
        toolName: "memory_search",
        content: "previous media://inbound/stale-screenshot.png result",
      }),
      ...oldEnoughTail(),
    ];

    const pruned = expectPrunedMessages(messages);
    const toolResult = pruned[0] as Extract<AgentMessage, { role: "toolResult" }> | undefined;
    expect(toolResult?.content).toBe(`previous ${PRUNED_HISTORY_MEDIA_REFERENCE_MARKER} result`);
  });

  it("keeps image blocks that belong to the third-most-recent assistant turn", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectImageMessagePreserved(messages, "expected user array content");
  });

  it("preserves recent media attachment markers", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: "recent [media attached: media://inbound/current.png]",
          },
          { ...image },
        ],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    const pruned = pruneProcessedHistoryImages(messages);

    expect(pruned).toBeNull();
    const content = expectArrayMessageContent(messages[0], "expected user array content");
    expect(content[0]?.text).toBe("recent [media attached: media://inbound/current.png]");
    expectContentBlock(content[1], { type: "image", data: "abc" });
  });

  it("does not count multiple assistant messages from one tool loop as separate turns", () => {
    // Tool-call assistant messages belong to one model turn; counting each
    // message separately would prune images too aggressively inside tool loops.
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      } as AgentMessage),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "bytes" }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectImageMessagePreserved(messages, "expected user array content");
  });

  it("does not prune latest user message when no assistant response exists yet", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
    ];

    const pruned = pruneProcessedHistoryImages(messages);

    expect(pruned).toBeNull();
    const content = expectArrayMessageContent(messages[0], "expected user array content");
    expect(content).toHaveLength(2);
    expectContentBlock(content[1], { type: "image", data: "abc" });
  });

  it("prunes image blocks from toolResult messages older than 3 assistant turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "screenshot bytes" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectPrunedImageMessage(messages, "expected toolResult array content");
  });

  it("prunes only old images while preserving recent ones", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "old" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "recent" }, { ...image }],
      }),
      assistantTurn(),
    ];

    const pruned = expectPrunedMessages(messages);

    const oldContent = expectArrayMessageContent(pruned[0], "expected old user content");
    expectContentBlock(oldContent[1], { type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });

    const recentContent = expectArrayMessageContent(pruned[6], "expected recent user content");
    expectContentBlock(recentContent[1], { type: "image", data: "abc" });

    const originalOldContent = expectArrayMessageContent(
      messages[0],
      "expected original old user content",
    );
    expectContentBlock(originalOldContent[1], { type: "image", data: "abc" });
  });

  it("does not change messages when no assistant turn exists", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: "noop",
      }),
    ];

    const pruned = pruneProcessedHistoryImages(messages);

    expect(pruned).toBeNull();
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe("noop");
  });
});

describe("installHistoryImagePruneContextTransform", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("prunes the provider replay view after an existing context transform", async () => {
    // The transform wrapper prunes only the replay view returned to providers,
    // leaving upstream transform output and restore behavior intact.
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "fresh prompt" }),
      ...oldEnoughTail(),
    ];
    const transformedMessages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: "stale [media attached: media://inbound/old.png]",
          },
          { ...image },
        ],
      }),
      ...oldEnoughTail(),
    ];
    const originalTransformContext = async (
      inputMessages: AgentMessage[],
      _signal?: AbortSignal,
    ) => {
      expect(inputMessages).toBe(messages);
      return transformedMessages;
    };
    const agent = { transformContext: originalTransformContext };

    const restore = installHistoryImagePruneContextTransform(agent);
    const replayMessages = await agent.transformContext(messages, new AbortController().signal);

    expect(replayMessages).not.toBe(transformedMessages);
    const replayContent = expectArrayMessageContent(
      replayMessages[0],
      "expected replay user array content",
    );
    expect(replayContent[0]?.text).toBe(`stale ${PRUNED_HISTORY_MEDIA_REFERENCE_MARKER}`);
    expectContentBlock(replayContent[1], {
      type: "text",
      text: PRUNED_HISTORY_IMAGE_MARKER,
    });
    const originalContent = expectArrayMessageContent(
      transformedMessages[0],
      "expected original transformed content",
    );
    expect(originalContent[0]?.text).toContain("media://inbound/old.png");
    expectContentBlock(originalContent[1], { type: "image", data: "abc" });

    restore();
    expect(agent.transformContext).toBe(originalTransformContext);
  });

  it("does not legacy-redact a fact-backed caption on the wrapper second pass", async () => {
    const mediaRef = "media://inbound/captioned.png";
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: `caption mentions ${mediaRef} as text`,
        media: [{ url: mediaRef, contentType: "image/png" }],
      }),
      ...oldEnoughTail(),
    ];
    const agent = {
      transformContext: async (input: AgentMessage[]) =>
        input.map((message) => ({ ...message })) as AgentMessage[],
    };
    const restore = installHistoryImagePruneContextTransform(agent);

    const replay = await agent.transformContext(messages);

    expect((replay[0] as { content?: unknown }).content).toBe(
      `caption mentions ${mediaRef} as text`,
    );
    restore();
  });

  it("hydrates recent facts before an existing transform clones messages", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-hydrate-"));
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const message = attachRuntimePromptMediaFacts(
      castAgentMessage({ role: "user", content: [{ type: "text", text: "describe" }] }),
      [{ path: imagePath, contentType: "image/png" }],
    );
    const agent = {
      transformContext: async (messages: AgentMessage[]) =>
        messages.map((entry) => {
          if (!("content" in entry)) {
            return { ...entry };
          }
          return {
            ...entry,
            content: Array.isArray(entry.content)
              ? entry.content.map((block: (typeof entry.content)[number]) => ({ ...block }))
              : entry.content,
          };
        }) as AgentMessage[],
    };
    const restore = installHistoryImagePruneContextTransform(agent, {
      workspaceDir,
      model: { input: ["text", "image"] },
      workspaceOnly: true,
    });

    try {
      const replay = await agent.transformContext([message]);
      expect(expectArrayMessageContent(replay[0], "expected hydrated content")).toEqual([
        { type: "text", text: "describe" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      restore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("strips nested media metadata before old turns can rehydrate", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pruned-nested-media-"));
    const imagePath = path.join(workspaceDir, "old.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const baseBridge = createHostSandboxFsBridge(workspaceDir);
    let hydrationReadCount = 0;
    const bridge = {
      ...baseBridge,
      readFile: async (params: Parameters<typeof baseBridge.readFile>[0]) => {
        hydrationReadCount++;
        return await baseBridge.readFile(params);
      },
    };
    const message = castAgentMessage({
      role: "user",
      content: "[media attached: ./old.png (image/png)]",
      __openclaw: {
        media: [{ path: "./old.png", contentType: "image/png" }],
        mediaImageBlockFactIndexes: [0],
        mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
      },
    });
    const agent: {
      transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]> | AgentMessage[];
    } = {};
    const restore = installHistoryImagePruneContextTransform(agent, {
      workspaceDir,
      model: { input: ["text", "image"] },
      workspaceOnly: true,
      sandbox: { root: workspaceDir, bridge },
    });

    try {
      const replay = await agent.transformContext?.([message, ...oldEnoughTail()]);
      const meta = (replay?.[0] as unknown as Record<string, unknown>)?.["__openclaw"] as
        | Record<string, unknown>
        | undefined;
      expect(hydrationReadCount).toBe(0);
      expect(meta?.media).toBeUndefined();
      expect(meta?.mediaImageBlockFactIndexes).toBeUndefined();
      expect(meta?.mediaImageLayout).toBeUndefined();
    } finally {
      restore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("treats identity-less nested facts as structured ownership", () => {
    const message = castAgentMessage({
      role: "user",
      content: "[media attached: /tmp/unknown.png (image/png)]",
      __openclaw: {
        media: [{ kind: "image" }],
        mediaImageLayout: { slots: [], suppressedFactIndexes: [0] },
      },
    });

    const pruned = expectPrunedMessages([message, ...oldEnoughTail()]);
    const first = pruned[0] as unknown as Record<string, unknown>;
    const meta = first["__openclaw"] as Record<string, unknown> | undefined;
    expect(first.content).toBe("[media attached: /tmp/unknown.png (image/png)]");
    expect(meta?.media).toBeUndefined();
    expect(meta?.mediaImageLayout).toBeUndefined();
  });
});
