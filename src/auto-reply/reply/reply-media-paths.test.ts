import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrl = vi.hoisted(() => vi.fn());
const resolveAgentScopedOutboundMediaAccess = vi.hoisted(() => vi.fn());

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl,
}));

vi.mock("../../media/read-capability.js", () => ({
  resolveAgentScopedOutboundMediaAccess,
}));

import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

type NormalizedReply = {
  mediaUrl?: string;
  mediaUrls?: string[];
  text?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value;
}

function expectMedia(result: NormalizedReply, mediaUrl: string, mediaUrls: string[]): void {
  expect(result.mediaUrl).toBe(mediaUrl);
  expect(result.mediaUrls).toEqual(mediaUrls);
}

function expectNoMedia(result: NormalizedReply): void {
  expect(result.mediaUrl).toBeUndefined();
  expect(result.mediaUrls).toBeUndefined();
}

function expectOutboundAttachmentCall(
  index: number,
  mediaUrl: string,
  mediaMaxBytes: number,
): Record<string, unknown> {
  const call = resolveOutboundAttachmentFromUrl.mock.calls.at(index) as unknown[] | undefined;
  if (!call) {
    throw new Error(`missing outbound attachment call ${index + 1}`);
  }
  expect(call[0]).toBe(mediaUrl);
  expect(call[1]).toBe(mediaMaxBytes);
  return requireRecord(call[2], "outbound attachment options");
}

function expectAgentScopedMediaAccessCall(): Record<string, unknown> {
  const call = resolveAgentScopedOutboundMediaAccess.mock.calls.at(0) as unknown[] | undefined;
  if (!call) {
    throw new Error("missing agent scoped media access call");
  }
  return requireRecord(call[0], "agent scoped media access request");
}

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    resolveOutboundAttachmentFromUrl.mockReset().mockImplementation(async (mediaUrl: string) => ({
      path: path.join("/tmp/outbound-media", path.basename(mediaUrl.replace(/^file:\/\//i, ""))),
    }));
    resolveAgentScopedOutboundMediaAccess
      .mockReset()
      .mockImplementation(({ workspaceDir }: { workspaceDir?: string }) => ({
        workspaceDir,
        localRoots: workspaceDir ? [workspaceDir] : undefined,
        readFile: async () => Buffer.from("image"),
      }));
    vi.unstubAllEnvs();
  });

  it("stages workspace-relative media through shared outbound attachment loading", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expectMedia(result, "/tmp/outbound-media/photo.png", ["/tmp/outbound-media/photo.png"]);
    const options = expectOutboundAttachmentCall(
      0,
      path.join("/tmp/agent-workspace", "out", "photo.png"),
      5 * 1024 * 1024,
    );
    const mediaAccess = requireRecord(options.mediaAccess, "media access");
    expect(mediaAccess.workspaceDir).toBe("/tmp/agent-workspace");
  });

  it("maps sandbox-relative media back to the host sandbox workspace before staging", async () => {
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

    expectMedia(result, "/tmp/outbound-media/photo.png", [
      "/tmp/outbound-media/photo.png",
      "/tmp/outbound-media/final.png",
    ]);
    expectOutboundAttachmentCall(
      0,
      path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
      5 * 1024 * 1024,
    );
    expectOutboundAttachmentCall(
      1,
      path.join("/tmp/sandboxes/session-1", "screens", "final.png"),
      5 * 1024 * 1024,
    );
  });

  it("drops sandbox-mapped media when staging fails instead of retrying the workspace fallback", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(new Error("media too large"));
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledTimes(1);
    expectOutboundAttachmentCall(
      0,
      path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
      5 * 1024 * 1024,
    );
    expect(result.text).toBe("⚠️ Media failed.");
  });

  it("drops host file URLs when no sandbox mapping applies", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["file:///Users/peter/Documents/report.pdf"],
    });

    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("drops host file URLs even when sandbox exists", async () => {
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
      mediaUrls: ["file:///Users/peter/Documents/report.pdf"],
    });

    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("drops absolute host-local media paths when sandbox mapping fails", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: { tools: { fs: { workspaceOnly: false } } },
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/Documents/report.pdf"],
    });

    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("stages absolute workspace media paths so the PR scenario now works", async () => {
    const absolutePath = "/Users/peter/.openclaw/workspace/exports/images/chart.png";
    const normalize = createReplyMediaPathNormalizer({
      cfg: { agents: { defaults: { mediaMaxMb: 8 } } },
      sessionKey: "session-key",
      workspaceDir: "/Users/peter/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: [absolutePath],
    });

    expectMedia(result, "/tmp/outbound-media/chart.png", ["/tmp/outbound-media/chart.png"]);
    expectOutboundAttachmentCall(0, absolutePath, 8 * 1024 * 1024);
  });

  it("prefers channel account media limits when staging reply attachments", async () => {
    const absolutePath = "/Users/peter/.openclaw/workspace/exports/images/chart.png";
    const normalize = createReplyMediaPathNormalizer({
      cfg: {
        channels: {
          whatsapp: {
            mediaMaxMb: 50,
            accounts: {
              work: {
                mediaMaxMb: 64,
              },
            },
          },
        },
        agents: { defaults: { mediaMaxMb: 8 } },
      },
      sessionKey: undefined,
      workspaceDir: "/Users/peter/.openclaw/workspace",
      messageProvider: "whatsapp",
      accountId: "work",
    });

    await normalize({
      mediaUrls: [absolutePath],
    });

    expectOutboundAttachmentCall(0, absolutePath, 64 * 1024 * 1024);
  });

  it("drops workspace-relative media paths that escape the agent workspace", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["../../etc/passwd"],
    });

    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("drops sandbox-relative media paths that escape both sandbox and workspace", async () => {
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
      mediaUrls: ["../../etc/passwd"],
    });

    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("keeps managed generated media under the shared media root", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });

    expectMedia(result, "/Users/peter/.openclaw/media/tool-image-generation/generated.png", [
      "/Users/peter/.openclaw/media/tool-image-generation/generated.png",
    ]);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("keeps managed outbound media under the shared media root with sandbox mapping", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/generated.png"],
    });

    expectMedia(result, "/Users/peter/.openclaw/media/outbound/generated.png", [
      "/Users/peter/.openclaw/media/outbound/generated.png",
    ]);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("drops managed outbound media symlinks escaping the shared media root without sandbox mapping", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-media-state-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-media-outside-"));
    const outsideFile = path.join(outsideDir, "secret.png");
    const symlinkPath = path.join(stateDir, "media", "outbound", "linked-secret.png");
    try {
      await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
      await fs.writeFile(outsideFile, "secret", "utf8");
      await fs.symlink(outsideFile, symlinkPath);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const normalize = createReplyMediaPathNormalizer({
        cfg: {},
        sessionKey: "session-key",
        workspaceDir: "/tmp/agent-workspace",
      });

      const result = await normalize({
        mediaUrls: [symlinkPath],
      });

      expectNoMedia(result);
      expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
    } finally {
      await fs.rm(symlinkPath, { force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("drops host-local media when shared outbound attachment policy rejects it", async () => {
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(
      new Error("Local media path is not under an allowed directory"),
    );
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/secrets/photo.png"],
    });

    expectNoMedia(result);
  });

  it("keeps reply text and appends a warning when all reply media is dropped", async () => {
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(new Error("file not found"));
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      text: "WA_MEDIA_DM_07",
      mediaUrls: ["./out/missing.png"],
    });

    expect(result.text).toBe("WA_MEDIA_DM_07\n⚠️ Media failed.");
    expectNoMedia(result);
  });

  it("returns a warning-only text reply when media-only output is dropped upstream", async () => {
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(new Error("file not found"));
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/missing.png"],
    });

    expect(result.text).toBe("⚠️ Media failed.");
    expectNoMedia(result);
  });

  it("threads requester context into shared outbound media access", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: undefined,
      workspaceDir: "/tmp/agent-workspace",
      messageProvider: "whatsapp",
      accountId: "source-account",
      groupId: "ops",
      groupChannel: "whatsapp",
      groupSpace: "team",
      requesterSenderId: "sender-1",
      requesterSenderName: "Sender Name",
      requesterSenderUsername: "sender-user",
      requesterSenderE164: "+15551234567",
    });

    await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expect(resolveAgentScopedOutboundMediaAccess).toHaveBeenCalledTimes(1);
    expect(expectAgentScopedMediaAccessCall()).toEqual({
      cfg: {},
      agentId: undefined,
      workspaceDir: "/tmp/agent-workspace",
      mediaSources: [path.join("/tmp/agent-workspace", "out", "photo.png")],
      sessionKey: undefined,
      messageProvider: "whatsapp",
      accountId: "source-account",
      requesterSenderId: "sender-1",
      requesterSenderName: "Sender Name",
      requesterSenderUsername: "sender-user",
      requesterSenderE164: "+15551234567",
      groupId: "ops",
      groupChannel: "whatsapp",
      groupSpace: "team",
    });
  });

  it("passes absolute local media sources into shared outbound media access", async () => {
    const absolutePath = "/Users/peter/Pictures/chart.png";
    const normalize = createReplyMediaPathNormalizer({
      cfg: { tools: { fs: { workspaceOnly: false } } },
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await normalize({
      mediaUrls: [absolutePath],
    });

    expect(resolveAgentScopedOutboundMediaAccess).toHaveBeenCalledTimes(1);
    const accessRequest = expectAgentScopedMediaAccessCall();
    expect(typeof accessRequest.agentId).toBe("string");
    expect({ ...accessRequest, agentId: undefined }).toEqual({
      cfg: { tools: { fs: { workspaceOnly: false } } },
      agentId: undefined,
      workspaceDir: "/tmp/agent-workspace",
      mediaSources: [absolutePath],
      sessionKey: "session-key",
      messageProvider: undefined,
      accountId: undefined,
      requesterSenderId: undefined,
      requesterSenderName: undefined,
      requesterSenderUsername: undefined,
      requesterSenderE164: undefined,
      groupId: undefined,
      groupChannel: undefined,
      groupSpace: undefined,
    });
  });

  it("passes home-relative local media sources into shared outbound media access", async () => {
    const homeRelativePath = "~/Pictures/chart.png";
    const normalize = createReplyMediaPathNormalizer({
      cfg: { tools: { fs: { workspaceOnly: false } } },
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: [homeRelativePath],
    });

    expectMedia(result, "/tmp/outbound-media/chart.png", ["/tmp/outbound-media/chart.png"]);
    expect(resolveAgentScopedOutboundMediaAccess).toHaveBeenCalledTimes(1);
    const accessRequest = expectAgentScopedMediaAccessCall();
    expect(typeof accessRequest.agentId).toBe("string");
    expect({ ...accessRequest, agentId: undefined }).toEqual({
      cfg: { tools: { fs: { workspaceOnly: false } } },
      agentId: undefined,
      workspaceDir: "/tmp/agent-workspace",
      mediaSources: [homeRelativePath],
      sessionKey: "session-key",
      messageProvider: undefined,
      accountId: undefined,
      requesterSenderId: undefined,
      requesterSenderName: undefined,
      requesterSenderUsername: undefined,
      requesterSenderE164: undefined,
      groupId: undefined,
      groupChannel: undefined,
      groupSpace: undefined,
    });
  });
});
