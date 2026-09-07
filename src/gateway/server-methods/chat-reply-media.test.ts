/**
 * Tests chat reply media handling for gateway message delivery.
 */
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumePendingToolMediaIntoReply } from "../../agents/embedded-agent-subscribe.handlers.messages.replies.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPinnedLookup } from "../../infra/net/ssrf.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { setMediaStoreNetworkDepsForTest } from "../../media/store.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createManagedOutgoingMediaBlocks as createManagedOutgoingImageBlocks } from "../managed-image-attachments.js";
import { buildAssistantReplyContent } from "./chat-assistant-content.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const TEST_SESSION_KEY = "agent:main:webchat:direct:user";

type ReplyMediaPayloads = Parameters<
  typeof normalizeWebchatReplyMediaPathsForDisplay
>[0]["payloads"];
type ReplyMediaPayload = ReplyMediaPayloads[number];

type MediaTestContext = {
  stateDir: string;
  agentDir: string;
  workspaceDir: string;
  cfg: OpenClawConfig;
};

describe("normalizeWebchatReplyMediaPathsForDisplay", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-webchat-reply-media-",
    });
  });

  afterEach(async () => {
    setMediaStoreNetworkDepsForTest();
    await testState.cleanup();
  });

  function createConfig(params: {
    agentDir: string;
    workspaceDir: string;
    allowRead: boolean;
  }): OpenClawConfig {
    return {
      tools: params.allowRead ? { allow: ["read"] } : { fs: { workspaceOnly: true } },
      agents: {
        list: [
          {
            id: "main",
            agentDir: params.agentDir,
            workspace: params.workspaceDir,
          },
        ],
      },
    };
  }

  function createMediaTestContext(params: { allowRead: boolean }): MediaTestContext {
    const stateDir = testState.stateDir;
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(stateDir, "workspace");
    return {
      stateDir,
      agentDir,
      workspaceDir,
      cfg: createConfig({ agentDir, workspaceDir, allowRead: params.allowRead }),
    };
  }

  async function createCodexHomeImage(params: { agentDir: string }): Promise<string> {
    const imagePath = path.join(params.agentDir, "codex-home", "outputs", "chart.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, PNG_BYTES);
    return imagePath;
  }

  async function createAudioFile(audioPath: string): Promise<void> {
    await fs.mkdir(path.dirname(audioPath), { recursive: true });
    await fs.writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  }

  function requireString(value: string | undefined, label: string): string {
    if (!value) {
      throw new Error(`expected ${label}`);
    }
    return value;
  }

  function dataImageUrl(): string {
    return `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
  }

  async function normalizeReplyMedia(params: {
    cfg: OpenClawConfig;
    payloads: ReplyMediaPayloads;
  }) {
    const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg: params.cfg,
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: params.payloads,
    });
    return payload;
  }

  async function normalizeCodexHomeImage(params: {
    allowRead: boolean;
    payload: (sourcePath: string) => ReplyMediaPayload;
  }) {
    const context = createMediaTestContext({ allowRead: params.allowRead });
    const sourcePath = await createCodexHomeImage({ agentDir: context.agentDir });
    const payload = await normalizeReplyMedia({
      cfg: context.cfg,
      payloads: [params.payload(sourcePath)],
    });
    return { ...context, sourcePath, payload };
  }

  async function createManagedImageBlocks(params: {
    cfg: OpenClawConfig;
    mediaUrls: string[] | undefined;
  }) {
    return createManagedOutgoingImageBlocks({
      sessionKey: TEST_SESSION_KEY,
      items: (params.mediaUrls ?? []).map((url) => ({ url, trustedLocal: false })),
      localRoots: getAgentScopedMediaLocalRoots(params.cfg, "main"),
    });
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    try {
      await fs.stat(targetPath);
      throw new Error(`expected ${targetPath} to be missing`);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ENOENT");
    }
  }

  async function expectOutboundMediaMissing(stateDir: string): Promise<void> {
    await expectPathMissing(path.join(stateDir, "media", "outbound"));
  }

  it("stages Codex-home image paths before Gateway managed-image display", async () => {
    const { stateDir, cfg, sourcePath, payload } = await normalizeCodexHomeImage({
      allowRead: true,
      payload: (imagePath) => ({ mediaUrls: [imagePath] }),
    });

    const normalizedPath = requireString(payload?.mediaUrls?.[0], "normalized media path");
    expect(normalizedPath).not.toBe(sourcePath);
    expect(normalizedPath.startsWith(path.join(stateDir, "media"))).toBe(true);
    const blocks = await createManagedImageBlocks({ cfg, mediaUrls: payload?.mediaUrls });

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type?: string }).type).toBe("image");
  });

  it("does not expose Codex-home media when host read policy is not enabled", async () => {
    const { payload } = await normalizeCodexHomeImage({
      allowRead: false,
      payload: (imagePath) => ({ mediaUrls: [imagePath] }),
    });

    expect(payload?.mediaUrl).toBeUndefined();
    expect(payload?.mediaUrls).toBeUndefined();
    expect(requireString(payload?.text, "suppressed media text")).toBe(
      "⚠️ chart.png: Delivery failed. Try sending this file again.",
    );
  });

  it("preserves ordered document and image metadata beside one rejected SVG", async () => {
    const { workspaceDir, cfg } = createMediaTestContext({ allowRead: true });
    const documentPath = path.join(workspaceDir, "artifact.json");
    const localImagePath = path.join(workspaceDir, "local.png");
    const unsupportedPath = path.join(workspaceDir, "vector.svg");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(documentPath, '{"ready":true}\n');
    await fs.writeFile(localImagePath, PNG_BYTES);
    await fs.writeFile(unsupportedPath, "<svg><script/></svg>\n");
    const upstream = http.createServer((req, res) => {
      expect(req.url).toBe("/remote.png?sig=secret");
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.end(PNG_BYTES);
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address() as AddressInfo;
    setMediaStoreNetworkDepsForTest({
      resolvePinnedHostname: async (hostname) => ({
        hostname,
        addresses: ["127.0.0.1"],
        lookup: createPinnedLookup({ hostname, addresses: ["127.0.0.1"] }),
      }),
    });

    try {
      const remoteImageUrl = `http://127.0.0.1:${address.port}/remote.png?sig=secret`;
      const payload = await normalizeReplyMedia({
        cfg,
        payloads: [
          {
            text: "Artifacts ready",
            mediaUrls: [documentPath, remoteImageUrl, localImagePath, unsupportedPath],
          },
        ],
      });

      expect(payload).toMatchObject({
        text: "Artifacts ready\n⚠️ vector.svg: Rejected by the local attachment allowlist. Send a supported file type.",
        attachments: [
          expect.objectContaining({ name: "artifact.json", mimeType: "application/json" }),
          {},
          expect.objectContaining({ name: "local.png", mimeType: "image/png" }),
        ],
      });
      expect(payload?.mediaUrls).toHaveLength(3);
      const { assistantContent: content } = await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads: payload ? [payload] : [],
        managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
      });
      expect(content).toEqual([
        { type: "text", text: "Artifacts ready" },
        expect.objectContaining({
          type: "attachment",
          attachment: expect.objectContaining({
            label: "artifact.json",
            mimeType: "application/json",
          }),
        }),
        expect.objectContaining({ type: "image", alt: "remote.png", mimeType: "image/png" }),
        expect.objectContaining({ type: "image", alt: "local.png", mimeType: "image/png" }),
        {
          type: "attachment_error",
          attachment: {
            code: "unsupported-format",
            kind: "image",
            label: "vector.svg",
            mimeType: "image/svg+xml",
          },
        },
      ]);
      const serialized = JSON.stringify(content);
      expect(serialized).toContain("vector.svg");
      expect(serialized).not.toContain("Media failed");
      expect(serialized).not.toContain("sig=secret");
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves named rejection outcomes and metadata beside trusted local audio", async () => {
    const { workspaceDir, cfg } = createMediaTestContext({ allowRead: true });
    const documentPath = path.join(workspaceDir, "report.json");
    const unsupportedPath = path.join(workspaceDir, "script.js");
    const audioPath = path.join(workspaceDir, "voice.mp3");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(documentPath, '{"ready":true}\n');
    await fs.writeFile(unsupportedPath, "export default true;\n");
    await createAudioFile(audioPath);

    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [
        {
          text: "Artifacts ready",
          mediaUrls: [documentPath, unsupportedPath, audioPath],
          attachments: [
            { name: "report.json", mimeType: "application/json", trustedLocalMedia: true },
            { name: "script.js", mimeType: "text/javascript", trustedLocalMedia: true },
            { name: "voice.mp3", mimeType: "audio/mpeg", trustedLocalMedia: true },
          ],
          trustedLocalMedia: true,
        },
      ],
    });

    expect(payload).toMatchObject({
      text: "Artifacts ready\n⚠️ script.js: Rejected by the local attachment allowlist. Send a supported file type.",
      mediaUrls: [expect.stringMatching(/\.json$/u), audioPath],
      attachments: [
        expect.objectContaining({ name: "report.json", mimeType: "application/json" }),
        expect.objectContaining({ name: "voice.mp3", mimeType: "audio/mpeg" }),
      ],
    });
  });

  it("does not stage sensitive media before display suppression", async () => {
    const { stateDir, sourcePath, payload } = await normalizeCodexHomeImage({
      allowRead: true,
      payload: (imagePath) => ({ mediaUrls: [imagePath], sensitiveMedia: true }),
    });

    expect(payload?.mediaUrl).toBeUndefined();
    expect(payload?.mediaUrls).toEqual([sourcePath]);
    await expectOutboundMediaMissing(stateDir);
  });

  it("preserves inline data image replies for WebChat rendering", async () => {
    const { stateDir, cfg } = createMediaTestContext({ allowRead: true });
    const dataUrl = dataImageUrl();

    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [{ mediaUrls: [dataUrl] }],
    });

    expect(payload?.mediaUrl).toBeUndefined();
    expect(payload?.mediaUrls).toEqual([dataUrl]);
    await expectOutboundMediaMissing(stateDir);
  });

  it("projects bounded retry guidance when managed media preparation fails", async () => {
    const source = "data:audio/mpeg;base64,not-valid!";
    const errors: string[] = [];

    const { assistantContent: content } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: [{ mediaUrls: [source] }],
      onManagedMediaPrepareError: (message) => errors.push(message),
    });

    expect(content).toEqual([
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "audio",
          label: "Generated audio 1",
        },
      },
    ]);
    expect(errors).toEqual(["Invalid image data URL"]);
    expect(JSON.stringify(content)).not.toContain(source);
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThan(256);
  });

  it("keeps a named failure when one media item cannot become an attachment", async () => {
    const { workspaceDir } = createMediaTestContext({ allowRead: true });
    const sourcePath = path.join(workspaceDir, "mystery.blob");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from([0, 1, 2, 3]));

    const { assistantContent: content, persistedAssistantContent } =
      await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads: [
          {
            text: "Artifact result",
            mediaUrls: [sourcePath],
            attachments: [{ name: "mystery.blob", trustedLocalMedia: true }],
          },
        ],
        managedMediaLocalRoots: [workspaceDir],
      });

    expect(content).toEqual([
      { type: "text", text: "Artifact result" },
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "document",
          label: "mystery.blob",
        },
      },
    ]);
    expect(persistedAssistantContent).toEqual(content);
  });

  it("preserves paragraph order when media follows adjacent reply text payloads", async () => {
    const payloads = [
      { text: "First paragraph" },
      {
        text: "Second paragraph",
        mediaUrl: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      },
    ];
    const { assistantContent: displayContent, persistedAssistantContent: persistedContent } =
      await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads,
        transcriptMediaMessage: await buildWebchatAssistantMessageFromReplyPayloads(payloads),
      });

    expect(displayContent?.some((block) => block.type === "image")).toBe(true);
    expect(
      persistedContent?.filter((block) => block.type === "text").map((block) => block.text),
    ).toEqual(["First paragraph", "Second paragraph"]);
    expect(persistedContent?.at(-1)?.type).toBe("image");
  });

  it.each([false, true])(
    "keeps an image-only caption beside its image (reply directive=%s)",
    async (replyToCurrent) => {
      const payloads = [
        { mediaUrl: `data:image/png;base64,${PNG_BYTES.toString("base64")}`, replyToCurrent },
        { text: "Following paragraph" },
      ];
      const { assistantContent, persistedAssistantContent } = await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads,
        transcriptMediaMessage: await buildWebchatAssistantMessageFromReplyPayloads(payloads),
      });

      expect(assistantContent?.map((block) => block.type)).toEqual(["image", "text"]);
      expect(persistedAssistantContent?.map((block) => block.type)).toEqual([
        "text",
        "image",
        "text",
      ]);
      expect(persistedAssistantContent?.[0]?.text).toBe(
        `${replyToCurrent ? "[[reply_to_current]]" : ""}Image reply`,
      );
      expect(persistedAssistantContent?.[2]?.text).toBe("Following paragraph");
    },
  );

  it("preserves local audio paths for WebChat audio embedding", async () => {
    const { stateDir, workspaceDir, cfg } = createMediaTestContext({ allowRead: false });
    const audioPath = path.join(workspaceDir, "voice.mp3");
    await createAudioFile(audioPath);

    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [{ mediaUrls: [audioPath], trustedLocalMedia: true, audioAsVoice: true }],
    });

    expect(payload?.mediaUrl).toBeUndefined();
    expect(payload?.mediaUrls).toEqual([audioPath]);
    expect(payload?.trustedLocalMedia).toBe(true);
    expect(payload?.audioAsVoice).toBe(true);
    await expectOutboundMediaMissing(stateDir);
  });

  it.each([
    {
      kind: "audio" as const,
      fileName: "generated-theme.mp3",
      bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      mimeType: "audio/mpeg",
    },
    {
      kind: "video" as const,
      fileName: "generated-clip.mp4",
      bytes: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
      mimeType: "video/mp4",
    },
  ])(
    "projects generated $kind into a managed history block",
    async ({ kind, fileName, bytes, mimeType }) => {
      const { workspaceDir } = createMediaTestContext({ allowRead: true });
      const sourcePath = path.join(workspaceDir, fileName);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, bytes);

      const { assistantContent: content } = await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads: [
          {
            text: "Generated media",
            mediaUrls: [sourcePath],
            attachments: [{ type: kind, path: sourcePath, name: fileName, durationMs: 1_500 }],
            trustedLocalMedia: true,
          },
        ],
        managedMediaLocalRoots: [workspaceDir],
      });

      expect(content).toEqual([
        { type: "text", text: "Generated media" },
        expect.objectContaining({
          type: kind,
          artifactId: expect.stringMatching(/^artifact_managed_media_/u),
          fileName,
          mimeType,
          durationMs: 1_500,
        }),
      ]);
      expect(JSON.stringify(content)).not.toContain(sourcePath);
    },
  );

  it("keeps attachment metadata aligned while deduplicating generated media", async () => {
    const { workspaceDir } = createMediaTestContext({ allowRead: true });
    const firstPath = path.join(workspaceDir, "first.mp3");
    const secondPath = path.join(workspaceDir, "second.mp3");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(firstPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    await fs.writeFile(secondPath, Buffer.from([0xff, 0xfb, 0x90, 0x01]));

    const { assistantContent: content } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: [
        {
          mediaUrl: secondPath,
          mediaUrls: [firstPath, firstPath],
          attachments: [
            { type: "audio", path: firstPath, name: "first.mp3", durationMs: 1_000 },
            { type: "audio", path: firstPath, name: "wrong.mp3", durationMs: 9_999 },
            { type: "audio", name: "second.mp3", durationMs: 2_000 },
          ],
          trustedLocalMedia: true,
        },
      ],
      managedMediaLocalRoots: [workspaceDir],
    });

    expect(content).toEqual([
      expect.objectContaining({ type: "audio", fileName: "first.mp3", durationMs: 1_000 }),
      expect.objectContaining({ type: "audio", fileName: "second.mp3", durationMs: 2_000 }),
    ]);
  });

  it("keeps normalized MEDIA directive URLs when projecting history", async () => {
    const { workspaceDir } = createMediaTestContext({ allowRead: true });
    const audioPath = path.join(workspaceDir, "directive.mp3");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));

    const { assistantContent: content } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: [{ text: `MEDIA:${audioPath}`, trustedLocalMedia: true }],
      managedMediaLocalRoots: [workspaceDir],
    });

    expect(content).toEqual([expect.objectContaining({ type: "audio", mimeType: "audio/mpeg" })]);
  });

  it("splits a mixed pending batch so only trusted local media reaches managed history", async () => {
    const { workspaceDir } = createMediaTestContext({ allowRead: true });
    const trustedPath = path.join(workspaceDir, "trusted.mp3");
    const untrustedPath = path.join(workspaceDir, "untrusted.mp3");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(trustedPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    await fs.writeFile(untrustedPath, Buffer.from([0xff, 0xfb, 0x90, 0x01]));
    const payload = consumePendingToolMediaIntoReply(
      {
        pendingToolMediaUrls: [trustedPath, untrustedPath],
        pendingToolMediaTrustByUrl: new Map([
          [trustedPath, true],
          [untrustedPath, false],
        ]),
        pendingToolAudioAsVoice: false,
      },
      {},
    );

    const { assistantContent: content } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: [payload],
      managedMediaLocalRoots: [workspaceDir],
    });

    expect(content).toEqual([
      expect.objectContaining({ type: "audio", mimeType: "audio/mpeg" }),
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "audio",
          label: "untrusted.mp3",
          mimeType: "audio/mpeg",
        },
      },
    ]);
  });

  it("preserves media order across interleaved trust classes", async () => {
    const { workspaceDir } = createMediaTestContext({ allowRead: true });
    const firstPath = path.join(workspaceDir, "first.mp3");
    const thirdPath = path.join(workspaceDir, "third.mp3");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(firstPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    await fs.writeFile(thirdPath, Buffer.from([0xff, 0xfb, 0x90, 0x01]));

    const { assistantContent: content } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: [
        {
          mediaUrls: [firstPath, dataImageUrl(), thirdPath],
          attachments: [
            { type: "audio", path: firstPath, trustedLocalMedia: true },
            { type: "image" },
            { type: "audio", path: thirdPath, trustedLocalMedia: true },
          ],
        },
      ],
      managedMediaLocalRoots: [workspaceDir],
    });

    expect(content?.map((block) => block.type)).toEqual(["audio", "image", "audio"]);
  });

  it("does not preserve untrusted local audio paths before display normalization", async () => {
    const { stateDir, cfg } = createMediaTestContext({ allowRead: false });
    const audioPath = path.join(testState.root, "outside", "voice.mp3");
    await createAudioFile(audioPath);

    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [{ mediaUrls: [audioPath] }],
    });

    expect(payload?.mediaUrl).toBeUndefined();
    expect(payload?.mediaUrls).toBeUndefined();
    expect(requireString(payload?.text, "suppressed media text")).toBe(
      "⚠️ voice.mp3: Delivery failed. Try sending this file again.",
    );
    await expectOutboundMediaMissing(stateDir);
  });

  it("preserves data images while staging mixed local image replies", async () => {
    const dataUrl = dataImageUrl();
    const { stateDir, cfg, sourcePath, payload } = await normalizeCodexHomeImage({
      allowRead: true,
      payload: (imagePath) => ({ mediaUrls: [dataUrl, imagePath] }),
    });

    const normalizedLocalPath = requireString(
      payload?.mediaUrls?.[1],
      "normalized local media path",
    );
    expect(payload?.mediaUrls?.[0]).toBe(dataUrl);
    expect(normalizedLocalPath).not.toBe(sourcePath);
    expect(normalizedLocalPath.startsWith(path.join(stateDir, "media"))).toBe(true);
    const blocks = await createManagedImageBlocks({ cfg, mediaUrls: payload?.mediaUrls });

    expect(blocks).toHaveLength(2);
  });

  it.each([
    {
      label: "before the inline image",
      mediaUrls: (imagePath: string, dataUrl: string) => [imagePath, dataUrl],
    },
    {
      label: "after the inline image",
      mediaUrls: (imagePath: string, dataUrl: string) => [dataUrl, imagePath],
    },
  ])("keeps a sanitized failure receipt when unreadable media is $label", async ({ mediaUrls }) => {
    const dataUrl = dataImageUrl();
    const { stateDir, sourcePath, payload } = await normalizeCodexHomeImage({
      allowRead: false,
      payload: (imagePath) => ({ mediaUrls: mediaUrls(imagePath, dataUrl) }),
    });

    expect(payload?.text).toBe("⚠️ chart.png: Delivery failed. Try sending this file again.");
    expect(payload?.text).not.toContain(sourcePath);
    expect(Buffer.byteLength(payload?.text ?? "")).toBeLessThan(256);
    expect(payload?.mediaUrl).toBe(dataUrl);
    expect(payload?.mediaUrls).toEqual([dataUrl]);
    await expectOutboundMediaMissing(stateDir);
  });

  it.each([
    {
      label: "a missing attachment before the staged attachment",
      mediaUrls: (missingPath: string, imagePath: string, dataUrl: string) => [
        missingPath,
        imagePath,
        dataUrl,
      ],
    },
    {
      label: "a missing attachment after the staged attachment",
      mediaUrls: (missingPath: string, imagePath: string, dataUrl: string) => [
        imagePath,
        missingPath,
        dataUrl,
      ],
    },
    {
      label: "multiple missing attachments around surviving media",
      mediaUrls: (missingPath: string, imagePath: string, dataUrl: string) => [
        missingPath,
        imagePath,
        dataUrl,
        path.join(path.dirname(imagePath), "private customer report.png"),
      ],
    },
  ])("keeps one named failure receipt per missing file for $label", async ({ mediaUrls }) => {
    const dataUrl = dataImageUrl();
    const { stateDir, sourcePath, payload } = await normalizeCodexHomeImage({
      allowRead: true,
      payload: (imagePath) => ({
        text: "Here is the surviving attachment",
        mediaUrls: mediaUrls(path.join(path.dirname(imagePath), "missing.png"), imagePath, dataUrl),
      }),
    });
    const normalizedLocalPath = requireString(payload?.mediaUrls?.[0], "normalized local media");

    expect(payload?.text).toContain(
      "Here is the surviving attachment\n⚠️ missing.png: File not found. Check the path and try again.",
    );
    expect(payload?.text).not.toContain(sourcePath);
    if (
      mediaUrls(path.join(path.dirname(sourcePath), "missing.png"), sourcePath, dataUrl).length > 3
    ) {
      expect(payload?.text).toContain(
        "⚠️ private customer report.png: File not found. Check the path and try again.",
      );
    }
    expect(Buffer.byteLength(payload?.text ?? "")).toBeLessThan(512);
    expect(payload?.mediaUrl).toBe(normalizedLocalPath);
    expect(payload?.mediaUrls).toEqual([normalizedLocalPath, dataUrl]);
    expect(normalizedLocalPath).not.toBe(sourcePath);
    expect(normalizedLocalPath.startsWith(path.join(stateDir, "media"))).toBe(true);
  });
});
