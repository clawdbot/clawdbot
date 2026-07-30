// Qqbot tests cover outbound-media-send host-read error handling behavior.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { audioPortMock } = vi.hoisted(() => ({
  audioPortMock: {
    audioFileToSilkBase64: vi.fn(),
    isAudioFile: vi.fn(),
    shouldTranscodeVoice: vi.fn(),
    waitForFile: vi.fn(),
  },
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: vi.fn(),
}));

vi.mock("../adapter/index.js", () => ({
  getPlatformAdapter: () => ({ getTempDir: () => "/tmp" }),
}));

vi.mock("./outbound-audio-port.js", () => ({
  audioFileToSilkBase64: audioPortMock.audioFileToSilkBase64,
  isAudioFile: audioPortMock.isAudioFile,
  shouldTranscodeVoice: audioPortMock.shouldTranscodeVoice,
  waitForFile: audioPortMock.waitForFile,
}));

const { MockUploadDailyLimitExceededError } = vi.hoisted(() => {
  class HoistedUploadDailyLimitExceededError extends Error {
    override readonly name = "UploadDailyLimitExceededError";

    constructor(
      readonly filePath: string,
      readonly fileSize: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { MockUploadDailyLimitExceededError: HoistedUploadDailyLimitExceededError };
});

vi.mock("./sender.js", () => ({
  accountToCreds: (account: { appId: string; clientSecret: string }) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  initApiConfig: vi.fn(),
  sendMedia: vi.fn(),
  sendText: vi.fn(),
  UploadDailyLimitExceededError: MockUploadDailyLimitExceededError,
}));

import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveLocalPathFromRootsSync } from "openclaw/plugin-sdk/security-runtime";
import {
  resolveOutboundMediaLocalRoots,
  resolveWorkspaceScopedLocalRoots,
} from "./outbound-media-path.js";
import {
  resolveOutboundMediaPath,
  sendDocument,
  sendPhoto,
  sendVideoMsg,
  sendVoice,
} from "./outbound-media-send.js";
import { OUTBOUND_ERROR_CODES } from "./outbound-types.js";
import { sendMedia as sendOutboundMedia } from "./outbound.js";
import { sendMedia as senderSendMedia } from "./sender.js";

vi.mock("openclaw/plugin-sdk/security-runtime", { spy: true });

const mockedLoadOutboundMediaFromUrl = vi.mocked(loadOutboundMediaFromUrl);
const mockedSenderSendMedia = vi.mocked(senderSendMedia);

let openclawHome: string;
let originalOpenClawHome: string | undefined;

function makeCtx() {
  return {
    targetType: "c2c" as const,
    targetId: "user-openid",
    account: {
      accountId: "qq-main",
      appId: "app-x",
      clientSecret: "secret-x",
      markdownSupport: false,
      config: {},
    },
    mediaAccess: {
      localRoots: ["/tmp/openclaw-sandbox"],
      workspaceDir: "/tmp/workspace",
      readFile: async () => Buffer.from("report"),
    },
    mediaLocalRoots: ["/tmp/openclaw-sandbox"],
    mediaReadFile: async () => Buffer.from("report"),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  originalOpenClawHome = process.env.OPENCLAW_HOME;
  // realpath: macOS tmpdir is a /var -> /private/var symlink and trusted-root
  // resolution returns canonicalized paths that assertions compare against.
  openclawHome = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-host-read-voice-")),
  );
  process.env.OPENCLAW_HOME = openclawHome;
  audioPortMock.audioFileToSilkBase64.mockResolvedValue(undefined);
  audioPortMock.isAudioFile.mockReturnValue(true);
  audioPortMock.shouldTranscodeVoice.mockReturnValue(false);
  audioPortMock.waitForFile.mockResolvedValue(12);
});

afterEach(async () => {
  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
  if (openclawHome) {
    await fs.rm(openclawHome, { recursive: true, force: true });
  }
});

describe("resolveOutboundMediaPath", () => {
  it("maps virtual /workspace paths before checking host local roots", () => {
    const resolveLocalPathSpy = vi
      .mocked(resolveLocalPathFromRootsSync)
      .mockImplementation(({ filePath }) =>
        filePath === "/tmp/agent-workspace/attachments/report.docx"
          ? { path: "/tmp/agent-workspace/attachments/report.docx", root: "/tmp/agent-workspace" }
          : null,
      );
    try {
      const result = resolveOutboundMediaPath("/workspace/attachments/report.docx", "media", {
        extraLocalRoots: ["/workspace/attachments", "/tmp/agent-workspace"],
        workspaceDir: "/tmp/agent-workspace",
        allowMissingLocalPath: true,
      });

      expect(result).toEqual({
        ok: true,
        mediaPath: "/tmp/agent-workspace/attachments/report.docx",
      });
      expect(resolveLocalPathSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "/workspace/attachments/report.docx" }),
      );
      expect(resolveLocalPathSpy).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "/tmp/agent-workspace/attachments/report.docx" }),
      );
    } finally {
      resolveLocalPathSpy.mockRestore();
    }
  });

  it("resolves relative paths only against the virtual workspace", () => {
    const resolveLocalPathSpy = vi
      .mocked(resolveLocalPathFromRootsSync)
      .mockImplementation(({ filePath }) =>
        filePath === "/tmp/agent-workspace/report.docx"
          ? { path: "/tmp/agent-workspace/report.docx", root: "/tmp/agent-workspace" }
          : null,
      );
    try {
      const result = resolveOutboundMediaPath("report.docx", "media", {
        extraLocalRoots: ["/tmp/agent-workspace"],
        workspaceDir: "/tmp/agent-workspace",
        allowMissingLocalPath: true,
      });

      expect(result).toEqual({ ok: true, mediaPath: "/tmp/agent-workspace/report.docx" });
      expect(resolveLocalPathSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "report.docx" }),
      );
    } finally {
      resolveLocalPathSpy.mockRestore();
    }
  });

  it("does not treat workspaceDir as an allowed host absolute root", () => {
    expect(
      resolveOutboundMediaLocalRoots({
        mediaAccess: {
          localRoots: ["/tmp/openclaw-sandbox"],
          workspaceDir: "/tmp/agent-workspace",
        },
        mediaLocalRoots: ["/tmp/openclaw-sandbox"],
      }),
    ).toEqual(["/tmp/openclaw-sandbox"]);
  });

  it("maps only authorized virtual workspace roots for host-read loading", () => {
    expect(
      resolveWorkspaceScopedLocalRoots(
        ["/workspace/attachments", "/tmp/openclaw-sandbox", "/workspace/../media"],
        "/tmp/agent-workspace",
      ),
    ).toEqual(["/tmp/agent-workspace/attachments", "/tmp/openclaw-sandbox"]);
  });

  it.each(["/workspace/../media/secret.pdf", "../media/secret.pdf"])(
    "rejects virtual workspace escapes before checking sibling media roots: %s",
    (mediaPath) => {
      const resolveLocalPathSpy = vi
        .mocked(resolveLocalPathFromRootsSync)
        .mockImplementation(({ filePath }) =>
          filePath === "/tmp/media/secret.pdf"
            ? { path: "/tmp/media/secret.pdf", root: "/tmp/media" }
            : null,
        );
      try {
        const result = resolveOutboundMediaPath(mediaPath, "media", {
          extraLocalRoots: ["/tmp/media", "/tmp/agent-workspace"],
          workspaceDir: "/tmp/agent-workspace",
        });

        expect(result.ok).toBe(false);
        expect(resolveLocalPathSpy).not.toHaveBeenCalledWith(
          expect.objectContaining({ filePath: "/tmp/media/secret.pdf" }),
        );
      } finally {
        resolveLocalPathSpy.mockRestore();
      }
    },
  );
});

describe("trySendViaHostRead error handling", () => {
  it("returns OutboundResult.error when loadOutboundMediaFromUrl rejects", async () => {
    mockedLoadOutboundMediaFromUrl.mockRejectedValue(new Error("sandbox host read failed"));

    const result = await sendPhoto(makeCtx(), "/tmp/openclaw-sandbox/report.docx");

    expect(result).toMatchObject({ channel: "qqbot", error: expect.any(String) });
    expect(result.error).toContain("sandbox host read failed");
    expect(mockedSenderSendMedia).not.toHaveBeenCalled();
  });

  it("falls back to normal local sends for trusted media paths outside host-read roots", async () => {
    const trustedMediaDir = path.join(openclawHome, ".openclaw", "media", "qqbot");
    await fs.mkdir(trustedMediaDir, { recursive: true });
    const trustedMediaPath = path.join(trustedMediaDir, "trusted-report.docx");
    await fs.writeFile(trustedMediaPath, Buffer.from("trusted report"));
    mockedLoadOutboundMediaFromUrl.mockRejectedValue(new Error("sandbox host read failed"));
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendDocument(makeCtx(), trustedMediaPath);

    expect(result).toMatchObject({ channel: "qqbot", messageId: "media-1" });
    expect(mockedLoadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(mockedSenderSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        source: { localPath: trustedMediaPath },
      }),
    );
  });

  it("rejects host-read image sends when the loaded media is not an image", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.pdf",
      contentType: "application/pdf",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendPhoto(makeCtx(), "/workspace/report.pdf");

    expect(result).toMatchObject({
      channel: "qqbot",
      error: expect.stringContaining("Unsupported image"),
    });
    expect(mockedSenderSendMedia).not.toHaveBeenCalled();
  });

  it("rejects host-read video sends when the loaded media is not a video", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.pdf",
      contentType: "application/pdf",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendVideoMsg(makeCtx(), "/workspace/report.pdf");

    expect(result).toMatchObject({
      channel: "qqbot",
      error: expect.stringContaining("Unsupported video"),
    });
    expect(mockedSenderSendMedia).not.toHaveBeenCalled();
  });

  it("rejects host-read voice sends when the loaded media is not audio", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.pdf",
      contentType: "application/pdf",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "voice-1", timestamp: 123 });

    const result = await sendVoice(makeCtx(), "/workspace/report.pdf", [".mp3"], true);

    expect(result).toMatchObject({
      channel: "qqbot",
      error: expect.stringContaining("Unsupported voice"),
    });
    expect(mockedSenderSendMedia).not.toHaveBeenCalled();
  });

  it("rejects empty host-read file buffers before upload", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.alloc(0),
      kind: "document",
      fileName: "empty.pdf",
      contentType: "application/pdf",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendDocument(makeCtx(), "/workspace/empty.pdf");

    expect(result).toMatchObject({
      channel: "qqbot",
      error: expect.stringContaining("File is empty"),
    });
    expect(mockedSenderSendMedia).not.toHaveBeenCalled();
  });

  it("returns OutboundResult.error when senderSendMedia rejects", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("image"),
      kind: "image",
      fileName: "chart.png",
      contentType: "image/png",
    });
    mockedSenderSendMedia.mockRejectedValue(new Error("qq upload quota exceeded"));

    const result = await sendPhoto(makeCtx(), "/tmp/openclaw-sandbox/chart.png");

    expect(result).toMatchObject({ channel: "qqbot", error: expect.any(String) });
    expect(result.error).toContain("qq upload quota exceeded");
  });

  it("preserves daily upload quota metadata from senderSendMedia", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.docx",
      contentType: "application/octet-stream",
    });
    mockedSenderSendMedia.mockRejectedValue(
      new MockUploadDailyLimitExceededError("<buffer>", 2048, "daily quota"),
    );

    const result = await sendDocument(makeCtx(), "report.docx");

    expect(result).toMatchObject({
      channel: "qqbot",
      errorCode: OUTBOUND_ERROR_CODES.UPLOAD_DAILY_LIMIT_EXCEEDED,
      qqBizCode: 40093002,
    });
    expect(result.error).toContain("/tmp/workspace/report.docx");
    expect(result.error).not.toContain("<buffer>");
  });

  it("maps sandbox /workspace paths before host-read media loading", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.docx",
      contentType: "application/octet-stream",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendDocument(makeCtx(), "/workspace/report.docx");

    expect(result).toMatchObject({ channel: "qqbot", messageId: "media-1" });
    expect(mockedLoadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/report.docx",
      expect.objectContaining({
        mediaAccess: expect.objectContaining({
          localRoots: ["/tmp/openclaw-sandbox"],
          workspaceDir: "/tmp/workspace",
        }),
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("does not host-read virtual /workspace paths without a workspaceDir", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.docx",
      contentType: "application/octet-stream",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendPhoto(
      {
        ...makeCtx(),
        mediaAccess: {
          localRoots: ["/tmp/openclaw-sandbox"],
          readFile: async () => Buffer.from("report"),
        },
        mediaLocalRoots: [],
      },
      "/workspace/report.docx",
    );

    expect(result).toMatchObject({ channel: "qqbot", error: expect.any(String) });
    expect(mockedLoadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(mockedSenderSendMedia).not.toHaveBeenCalled();
  });

  it("does not host-read relative paths without a workspaceDir", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("image"),
      kind: "image",
      fileName: "chart.png",
      contentType: "image/png",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendPhoto(
      {
        ...makeCtx(),
        mediaAccess: {
          localRoots: ["/tmp/openclaw-sandbox"],
          readFile: async () => Buffer.from("image"),
        },
        mediaLocalRoots: [],
      },
      "chart.png",
    );

    expect(result).toMatchObject({ channel: "qqbot", error: expect.any(String) });
    expect(mockedLoadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(mockedSenderSendMedia).not.toHaveBeenCalled();
  });

  it("does not host-read virtual /workspace escapes through sibling local roots", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("secret"),
      kind: "document",
      fileName: "secret.pdf",
      contentType: "application/pdf",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendDocument(
      {
        ...makeCtx(),
        mediaAccess: {
          localRoots: ["/media"],
          workspaceDir: "/tmp/workspace",
          readFile: async () => Buffer.from("secret"),
        },
        mediaLocalRoots: [],
      },
      "/workspace/../media/secret.pdf",
    );

    expect(result).toMatchObject({ channel: "qqbot", error: expect.any(String) });
    expect(mockedLoadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(mockedSenderSendMedia).not.toHaveBeenCalled();
  });

  it("maps virtual /workspace host-read paths through the scoped workspace", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.docx",
      contentType: "application/octet-stream",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendDocument(
      {
        ...makeCtx(),
        mediaAccess: {
          localRoots: ["/workspace/attachments"],
          workspaceDir: "/tmp/agent-workspace",
          readFile: async () => Buffer.from("report"),
        },
        mediaLocalRoots: ["/workspace/attachments"],
      },
      "/workspace/attachments/report.docx",
    );

    expect(result).toMatchObject({ channel: "qqbot", messageId: "media-1" });
    expect(mockedLoadOutboundMediaFromUrl).not.toHaveBeenCalledWith(
      "/workspace/attachments/report.docx",
      expect.anything(),
    );
    expect(mockedLoadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/agent-workspace/attachments/report.docx",
      expect.objectContaining({
        mediaAccess: expect.objectContaining({
          localRoots: ["/tmp/agent-workspace/attachments"],
          workspaceDir: "/tmp/agent-workspace",
        }),
        workspaceDir: "/tmp/agent-workspace",
      }),
    );
  });

  it("loads virtual-root workspace media through the real outbound loader", async () => {
    const actualOutboundMedia = await vi.importActual<
      typeof import("openclaw/plugin-sdk/outbound-media")
    >("openclaw/plugin-sdk/outbound-media");
    mockedLoadOutboundMediaFromUrl.mockImplementation(actualOutboundMedia.loadOutboundMediaFromUrl);
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });
    const workspaceDir = path.join(openclawHome, "agent-workspace");
    const reportPath = path.join(workspaceDir, "attachments", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "hello");
    const readFile = async (filePath: string) => await fs.readFile(filePath);

    const result = await sendDocument(
      {
        ...makeCtx(),
        mediaAccess: {
          localRoots: ["/workspace/attachments"],
          workspaceDir,
          readFile,
        },
        mediaLocalRoots: ["/workspace/attachments"],
        mediaReadFile: readFile,
      },
      "/workspace/attachments/report.txt",
    );

    expect(result).toMatchObject({ channel: "qqbot", messageId: "media-1" });
    expect(mockedSenderSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        source: expect.objectContaining({
          buffer: Buffer.from("hello"),
          fileName: "report.txt",
        }),
      }),
    );
  });

  it("auto-routes extensionless host-read images by loaded media kind", async () => {
    audioPortMock.isAudioFile.mockReturnValue(false);
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("image bytes"),
      kind: "image",
      fileName: "chart",
      contentType: "image/png",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendOutboundMedia({
      to: "qqbot:c2c:user-openid",
      text: "",
      mediaUrl: "chart",
      accountId: "qq-main",
      replyToId: "msg-1",
      account: makeCtx().account,
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        workspaceDir: "/tmp/workspace",
        readFile: async () => Buffer.from("image bytes"),
      },
    });

    expect(result).toMatchObject({ channel: "qqbot", messageId: "media-1" });
    expect(mockedLoadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/chart",
      expect.objectContaining({
        mediaAccess: expect.objectContaining({ workspaceDir: "/tmp/workspace" }),
      }),
    );
    expect(mockedSenderSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "image",
        source: expect.objectContaining({
          buffer: Buffer.from("image bytes"),
          fileName: "chart",
        }),
      }),
    );
  });

  it("auto-routes extensionless host-read audio by loaded media kind", async () => {
    audioPortMock.isAudioFile.mockReturnValue(false);
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("audio bytes"),
      kind: "audio",
      fileName: "clip",
      contentType: "audio/mpeg",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "voice-1", timestamp: 123 });

    const result = await sendOutboundMedia({
      to: "qqbot:c2c:user-openid",
      text: "",
      mediaUrl: "clip",
      accountId: "qq-main",
      replyToId: "msg-1",
      account: makeCtx().account,
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        workspaceDir: "/tmp/workspace",
        readFile: async () => Buffer.from("audio bytes"),
      },
    });

    expect(result).toMatchObject({ channel: "qqbot", messageId: "voice-1" });
    expect(mockedLoadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/clip",
      expect.objectContaining({
        mediaAccess: expect.objectContaining({ workspaceDir: "/tmp/workspace" }),
      }),
    );
    expect(mockedSenderSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "voice",
        source: { base64: Buffer.from("audio bytes").toString("base64") },
        localPathForMeta: expect.stringMatching(/clip-.*\.mp3$/),
      }),
    );
  });

  it("stages host-read audio before using the voice upload path", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("audio bytes"),
      kind: "audio",
      fileName: "clip.mp3",
      contentType: "audio/mpeg",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "voice-1", timestamp: 123 });

    const result = await sendVoice(makeCtx(), "clip.mp3", [".mp3"], true);

    expect(result).toMatchObject({ channel: "qqbot", messageId: "voice-1" });
    expect(mockedLoadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/clip.mp3",
      expect.objectContaining({
        maxBytes: expect.any(Number),
        mediaAccess: expect.objectContaining({
          localRoots: ["/tmp/openclaw-sandbox"],
          workspaceDir: "/tmp/workspace",
        }),
      }),
    );
    expect(audioPortMock.waitForFile).toHaveBeenCalledWith(expect.stringMatching(/clip-.*\.mp3$/));
    expect(mockedSenderSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "voice",
        source: { base64: Buffer.from("audio bytes").toString("base64") },
        localPathForMeta: expect.stringMatching(/clip-.*\.mp3$/),
      }),
    );
  });
});
