// Tests media path normalization and attachment metadata generation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostReadMediaTypeError, LocalMediaAccessError } from "../../media/local-media-access.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrl = vi.hoisted(() => vi.fn());
const resolveAgentScopedOutboundMediaAccess = vi.hoisted(() => vi.fn());
const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl,
}));

vi.mock("../../media/read-capability.js", () => ({
  resolveAgentScopedOutboundMediaAccess,
}));

import { parseReplyDirectives } from "./reply-directives.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

type NormalizedReply = {
  attachments?: Array<{ name?: string; trustedLocalMedia?: boolean }>;
  mediaUrl?: string;
  mediaUrls?: string[];
  text?: string;
  trustedLocalMedia?: boolean;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isObjectRecord(value)).toBe(true);
  if (!isObjectRecord(value)) {
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
  const call = resolveOutboundAttachmentFromUrl.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`missing outbound attachment call ${index + 1}`);
  }
  expect(call[0]).toBe(mediaUrl);
  expect(call[1]).toBe(mediaMaxBytes);
  return requireRecord(call[2], "outbound attachment options");
}

function expectAgentScopedMediaAccessCall(): Record<string, unknown> {
  const call = resolveAgentScopedOutboundMediaAccess.mock.calls[0] as unknown[] | undefined;
  if (!call) {
    throw new Error("missing agent scoped media access call");
  }
  return requireRecord(call[0], "agent scoped media access request");
}

function createTestReplyMediaNormalizer(
  overrides: Omit<
    Parameters<typeof createReplyMediaPathNormalizer>[0],
    "cfg" | "sessionKey" | "workspaceDir"
  > = {},
) {
  return createReplyMediaPathNormalizer({
    cfg: {},
    sessionKey: "session-key",
    workspaceDir: "/tmp/agent-workspace",
    ...overrides,
  });
}

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    resolveOutboundAttachmentFromUrl.mockReset().mockImplementation(async (mediaUrl: string) => ({
      path: path.join("/tmp/outbound-media", path.basename(mediaUrl.replace(/^file:\/\//i, ""))),
      contentType: mediaUrl.endsWith(".mp3") ? "audio/mpeg" : "image/png",
    }));
    resolveAgentScopedOutboundMediaAccess
      .mockReset()
      .mockImplementation(({ workspaceDir }: { workspaceDir?: string }) => ({
        workspaceDir,
        localRoots: workspaceDir ? [workspaceDir] : undefined,
        readFile: async () => Buffer.from("image"),
      }));
  });

  afterEach(() => {
    stateDirEnvSnapshot.restore();
  });

  it("stages workspace-relative media through shared outbound attachment loading", async () => {
    const normalize = createTestReplyMediaNormalizer();

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
    expect(result.trustedLocalMedia).toBe(true);
    expect(result.attachments).toEqual([
      { name: "photo.png", mimeType: "image/png", trustedLocalMedia: true },
    ]);
  });

  it.each([
    { name: "plain", fileName: "photo.png", prefix: "file://" },
    { name: "encoded", fileName: "café 100% image.png", prefix: "file://" },
    { name: "localhost", fileName: "café 100% image.png", prefix: "file://localhost" },
    { name: "uppercase single-slash", fileName: "café 100% image.png", prefix: "FILE:" },
  ])("stages $name file URL directives without allowing raw host file URLs", async (testCase) => {
    const workspaceDir = path.resolve("agent-workspace");
    const filePath = path.join(workspaceDir, testCase.fileName);
    const fileUrl = pathToFileURL(filePath).href.replace(/^file:\/\//u, testCase.prefix);
    const normalize = createReplyMediaPathNormalizer({ cfg: {}, workspaceDir });

    const result = await normalize(parseReplyDirectives(`Caption\nMEDIA:${fileUrl}`));

    const stagedPath = path.join("/tmp/outbound-media", testCase.fileName);
    expectMedia(result, stagedPath, [stagedPath]);
    expect(result.text).toBe("Caption");
    expectOutboundAttachmentCall(0, filePath, 5 * 1024 * 1024);

    expectNoMedia(await normalize({ mediaUrls: [fileUrl] }));
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledTimes(1);
  });

  it("does not grant local-media trust to remote-only replies", async () => {
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({ mediaUrls: ["https://example.com/voice.mp3"] });

    expect(result.trustedLocalMedia).toBeUndefined();
  });

  it("preserves reply metadata when media normalization clones the payload", async () => {
    const normalize = createTestReplyMediaNormalizer();
    const payload = setReplyPayloadMetadata(
      {
        text: "Here is the image",
        mediaUrls: ["./out/photo.png"],
      },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: "main",
          text: "Here is the image",
          mediaUrls: ["./out/photo.png"],
          idempotencyKey: "source-reply:0",
        },
      },
    );

    const result = await normalize(payload);

    expect(result).not.toBe(payload);
    expectMedia(result, "/tmp/outbound-media/photo.png", ["/tmp/outbound-media/photo.png"]);
    expect(getReplyPayloadMetadata(result)?.sourceReplyTranscriptMirror).toEqual({
      sessionKey: "main",
      text: "Here is the image",
      mediaUrls: ["./out/photo.png"],
      idempotencyKey: "source-reply:0",
    });
  });

  it.each([
    { name: "Docker", containerWorkdir: "/workspace" },
    { name: "OpenShell", containerWorkdir: "/sandbox" },
    { name: "custom remote backend", containerWorkdir: "/remote/agent" },
  ])(
    "maps $name media to the host sandbox workspace before staging",
    async ({ containerWorkdir }) => {
      ensureSandboxWorkspaceForSession.mockResolvedValue({
        workspaceDir: "/tmp/sandboxes/session-1",
        containerWorkdir,
      });
      const normalize = createTestReplyMediaNormalizer({ agentId: "finance" });
      const fileUrl = `file://${containerWorkdir}/screens/final%20image.png`;

      const result = await normalize({
        mediaUrls: [
          "./out/photo.png",
          fileUrl,
          ...(parseReplyDirectives(`MEDIA:${fileUrl}`).mediaUrls ?? []),
        ],
      });

      expect(ensureSandboxWorkspaceForSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "finance" }),
      );
      expectMedia(result, "/tmp/outbound-media/photo.png", [
        "/tmp/outbound-media/photo.png",
        "/tmp/outbound-media/final image.png",
      ]);
      expectOutboundAttachmentCall(
        0,
        path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
        5 * 1024 * 1024,
      );
      expectOutboundAttachmentCall(
        1,
        path.join("/tmp/sandboxes/session-1", "screens", "final image.png"),
        5 * 1024 * 1024,
      );
    },
  );

  it("maps explicitly supplied backend workdirs without rediscovering the sandbox", async () => {
    const normalize = createTestReplyMediaNormalizer({
      sandboxRoot: "/tmp/sandboxes/session-1",
      sandboxContainerWorkdir: "/sandbox",
    });

    const result = await normalize({
      mediaUrls: ["/sandbox/screens/final.png"],
    });

    expectMedia(result, "/tmp/outbound-media/final.png", ["/tmp/outbound-media/final.png"]);
    expectOutboundAttachmentCall(
      0,
      path.join("/tmp/sandboxes/session-1", "screens", "final.png"),
      5 * 1024 * 1024,
    );
    expect(ensureSandboxWorkspaceForSession).not.toHaveBeenCalled();
  });

  it("drops sandbox-mapped media when staging fails instead of retrying the workspace fallback", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(new Error("media too large"));
    const normalize = createTestReplyMediaNormalizer();

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
    expect(result.text).toBe("⚠️ photo.png: Delivery failed. Try sending this file again.");
  });

  it.each([
    ["lowercase triple-slash", "file:///Users/peter/Documents/report.pdf"],
    ["uppercase triple-slash", "FILE:///Users/peter/Documents/report.pdf"],
    ["lowercase single-slash", "file:/Users/peter/Documents/report.pdf"],
    ["uppercase single-slash", "FILE:/Users/peter/Documents/report.pdf"],
    ["remote host", "file://server/share/report.pdf"],
    ["network path", "FILE:////server/share/report.pdf"],
    ["encoded slash", "file:/Users/peter/Documents/%2Freport.pdf"],
    ["encoded backslash", "FILE:/Users/peter/Documents/%5Creport.pdf"],
  ])("drops %s host file URLs when no sandbox mapping applies", async (_label, mediaUrl) => {
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({
      mediaUrls: [mediaUrl],
    });

    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("drops host file URLs even when sandbox exists", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createTestReplyMediaNormalizer();

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

  it("stages absolute workspace media paths before sandbox mapping", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const absolutePath = "/Users/peter/.openclaw/workspace/reports/screenshot.png";
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/Users/peter/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: [absolutePath],
    });

    expectMedia(result, "/tmp/outbound-media/screenshot.png", [
      "/tmp/outbound-media/screenshot.png",
    ]);
    expectOutboundAttachmentCall(0, absolutePath, 5 * 1024 * 1024);
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
    const normalize = createTestReplyMediaNormalizer();

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
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({
      mediaUrls: ["../../etc/passwd"],
    });

    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("keeps managed generated media under the shared media root", async () => {
    setTestEnvValue("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
    const normalize = createTestReplyMediaNormalizer();

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
    setTestEnvValue("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
    const normalize = createTestReplyMediaNormalizer();

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
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const normalize = createTestReplyMediaNormalizer();

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
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({
      mediaUrls: ["/Users/peter/secrets/photo.png"],
    });

    expectNoMedia(result);
  });

  it("keeps reply text and appends a named receipt when all reply media is dropped", async () => {
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(
      new LocalMediaAccessError("not-found", "missing test fixture"),
    );
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({
      text: "WA_MEDIA_DM_07",
      mediaUrls: ["./out/missing.png"],
    });

    expect(result.text).toBe(
      "WA_MEDIA_DM_07\n⚠️ missing.png: File not found. Check the path and try again.",
    );
    expectNoMedia(result);
  });

  it("keeps surviving media and appends a named receipt for each dropped item", async () => {
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(
      new LocalMediaAccessError("not-found", "missing test fixture"),
    );
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({
      text: "Here is the surviving attachment",
      mediaUrls: ["./out/missing.png", "https://example.com/ok.png"],
    });

    expect(result.text).toBe(
      "Here is the surviving attachment\n⚠️ missing.png: File not found. Check the path and try again.",
    );
    expectMedia(result, "https://example.com/ok.png", ["https://example.com/ok.png"]);
  });

  it("returns a warning-only text reply when media-only output is dropped upstream", async () => {
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(
      new LocalMediaAccessError("not-found", "missing test fixture"),
    );
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({
      mediaUrls: ["./out/missing.png"],
    });

    expect(result.text).toBe("⚠️ missing.png: File not found. Check the path and try again.");
    expectNoMedia(result);
    expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toEqual([
      {
        code: "file-not-found",
        kind: "image",
        label: "missing.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("keeps host-read media type rejection internal to the reply outcome", async () => {
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(
      new HostReadMediaTypeError("unsupported test fixture"),
    );
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({ mediaUrls: ["./out/settings.toml"] });

    expect(result.text).toBe(
      "⚠️ settings.toml: Rejected by the local attachment allowlist. Send a supported file type.",
    );
    expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toMatchObject([
      { code: "unsupported-format", label: "settings.toml" },
    ]);
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
