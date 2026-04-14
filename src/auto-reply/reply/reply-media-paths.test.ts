import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDir = vi.hoisted(() => vi.fn(() => "/private/tmp/openclaw-501"));
const saveMediaSource = vi.hoisted(() => vi.fn());

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../infra/tmp-openclaw-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/tmp-openclaw-dir.js")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir,
  };
});

vi.mock("../../media/store.js", () => ({
  saveMediaSource,
}));

import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    resolvePreferredOpenClawTmpDir.mockReset().mockReturnValue("/private/tmp/openclaw-501");
    saveMediaSource.mockReset();
    vi.unstubAllEnvs();
  });

  it("resolves workspace-relative media against the agent workspace", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: path.join("/tmp/agent-workspace", "out", "photo.png"),
      mediaUrls: [path.join("/tmp/agent-workspace", "out", "photo.png")],
    });
  });

  it("maps sandbox-relative media back to the host sandbox workspace", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png", "file:///workspace/screens/final.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
      mediaUrls: [
        path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
        path.join("/tmp/sandboxes/session-1", "screens", "final.png"),
      ],
    });
  });

  it("drops arbitrary host-local media paths when sandbox exists", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/.openclaw/media/inbound/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("drops relative sandbox escapes when tools.fs.workspaceOnly is enabled", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: { tools: { fs: { workspaceOnly: true } } },
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["../sandboxes/session-1/screens/final.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("keeps managed generated media under the shared media root", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/tool-image-generation/generated.png",
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("drops absolute file URLs outside managed reply media roots", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["file:///Users/peter/.openclaw/media/inbound/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it("persists volatile agent-state media from the workspace into host outbound media", async () => {
    saveMediaSource.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/persisted.png",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/Users/peter/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: [
        "/Users/peter/.openclaw/workspace/.openclaw/media/tool-image-generation/generated.png",
      ],
    });

    expect(saveMediaSource).toHaveBeenCalledWith(
      "/Users/peter/.openclaw/workspace/.openclaw/media/tool-image-generation/generated.png",
      undefined,
      "outbound",
    );
    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/persisted.png",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/persisted.png"],
    });
  });

  it("persists TTS voice output from the preferred OpenClaw temp directory", async () => {
    const tmpVoicePath = path.join(
      "/private/tmp/openclaw-501",
      "tts-abc123",
      "voice-1234567890.opus",
    );
    saveMediaSource.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/tts-voice.opus",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: [tmpVoicePath],
    });

    expect(saveMediaSource).toHaveBeenCalledWith(tmpVoicePath, undefined, "outbound");
    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/tts-voice.opus",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/tts-voice.opus"],
    });
  });

  it("falls back to the original preferred tmp path when persisting TTS media fails", async () => {
    const tmpVoicePath = path.join(
      "/private/tmp/openclaw-501",
      "tts-fallback",
      "voice-1234567890.opus",
    );
    saveMediaSource.mockRejectedValue(new Error("disk full"));
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: [tmpVoicePath],
    });

    expect(result).toMatchObject({
      mediaUrl: tmpVoicePath,
      mediaUrls: [tmpVoicePath],
    });
  });

  it("drops host tmp paths outside the preferred OpenClaw temp directory", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/private/tmp/not-openclaw/voice-1234567890.opus"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });
});
