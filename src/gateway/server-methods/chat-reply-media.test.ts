import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { createManagedOutgoingImageBlocks } from "../managed-image-attachments.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";

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
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webchat-reply-media-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(rootDir, "state"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(rootDir, { recursive: true, force: true });
    rootDir = "";
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
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
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
      mediaUrls: params.mediaUrls ?? [],
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
    expect(requireString(payload?.text, "suppressed media text")).toBe("⚠️ Media failed.");
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

  it("does not preserve untrusted local audio paths before display normalization", async () => {
    const { stateDir, cfg } = createMediaTestContext({ allowRead: false });
    const audioPath = path.join(rootDir, "outside", "voice.mp3");
    await createAudioFile(audioPath);

    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [{ mediaUrls: [audioPath] }],
    });

    expect(payload?.mediaUrl).toBeUndefined();
    expect(payload?.mediaUrls).toBeUndefined();
    expect(requireString(payload?.text, "suppressed media text")).toBe("⚠️ Media failed.");
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

  it("does not add a failure warning when a mixed inline image survives", async () => {
    const dataUrl = dataImageUrl();
    const { stateDir, payload } = await normalizeCodexHomeImage({
      allowRead: false,
      payload: (imagePath) => ({ mediaUrls: [imagePath, dataUrl] }),
    });

    expect(payload?.text).toBeUndefined();
    expect(payload?.mediaUrl).toBe(dataUrl);
    expect(payload?.mediaUrls).toEqual([dataUrl]);
    await expectOutboundMediaMissing(stateDir);
  });
});
