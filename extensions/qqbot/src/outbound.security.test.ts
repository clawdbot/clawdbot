import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedQQBotAccount } from "./types.js";
import { getQQBotDataDir, getQQBotMediaDir } from "./utils/platform.js";

const apiMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => "token"),
  sendC2CFileMessage: vi.fn(async () => ({ id: "msg-c2c-file", timestamp: "ts" })),
  sendC2CImageMessage: vi.fn(async () => ({ id: "msg-c2c-image", timestamp: "ts" })),
  sendC2CMessage: vi.fn(async () => ({ id: "msg-c2c-text", timestamp: "ts" })),
  sendC2CVideoMessage: vi.fn(async () => ({ id: "msg-c2c-video", timestamp: "ts" })),
  sendC2CVoiceMessage: vi.fn(async () => ({ id: "msg-c2c-voice", timestamp: "ts" })),
  sendChannelMessage: vi.fn(async () => ({ id: "msg-channel", timestamp: "ts" })),
  sendDmMessage: vi.fn(async () => ({ id: "msg-dm", timestamp: "ts" })),
  sendGroupFileMessage: vi.fn(async () => ({ id: "msg-group-file", timestamp: "ts" })),
  sendGroupImageMessage: vi.fn(async () => ({ id: "msg-group-image", timestamp: "ts" })),
  sendGroupMessage: vi.fn(async () => ({ id: "msg-group-text", timestamp: "ts" })),
  sendGroupVideoMessage: vi.fn(async () => ({ id: "msg-group-video", timestamp: "ts" })),
  sendGroupVoiceMessage: vi.fn(async () => ({ id: "msg-group-voice", timestamp: "ts" })),
  sendProactiveC2CMessage: vi.fn(async () => ({ id: "msg-proactive-c2c", timestamp: "ts" })),
  sendProactiveGroupMessage: vi.fn(async () => ({ id: "msg-proactive-group", timestamp: "ts" })),
}));

const audioConvertMocks = vi.hoisted(() => ({
  audioFileToSilkBase64: vi.fn(async () => "c2lsaw=="),
  isAudioFile: vi.fn((filePath: string, mimeType?: string) => {
    if (mimeType === "voice" || mimeType?.startsWith("audio/")) {
      return true;
    }
    return (
      filePath.endsWith(".mp3") ||
      filePath.endsWith(".wav") ||
      filePath.endsWith(".amr") ||
      filePath.endsWith(".ogg")
    );
  }),
  shouldTranscodeVoice: vi.fn(() => false),
  waitForFile: vi.fn(async (_filePath: string) => 1024),
}));

const fileUtilsMocks = vi.hoisted(() => ({
  checkFileSize: vi.fn(() => ({ ok: true })),
  downloadFile: vi.fn(),
  fileExistsAsync: vi.fn(async () => true),
  formatFileSize: vi.fn((size: number) => `${size}`),
  readFileAsync: vi.fn(async () => Buffer.from("file-data")),
}));

vi.mock("./api.js", () => apiMocks);

vi.mock("./utils/audio-convert.js", () => ({
  audioFileToSilkBase64: audioConvertMocks.audioFileToSilkBase64,
  isAudioFile: audioConvertMocks.isAudioFile,
  shouldTranscodeVoice: audioConvertMocks.shouldTranscodeVoice,
  waitForFile: audioConvertMocks.waitForFile,
}));

vi.mock("./utils/file-utils.js", () => ({
  checkFileSize: fileUtilsMocks.checkFileSize,
  downloadFile: fileUtilsMocks.downloadFile,
  fileExistsAsync: fileUtilsMocks.fileExistsAsync,
  formatFileSize: fileUtilsMocks.formatFileSize,
  readFileAsync: fileUtilsMocks.readFileAsync,
}));

vi.mock("./utils/debug-log.js", () => ({
  debugError: vi.fn(),
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

import {
  sendDocument,
  sendMedia,
  sendPhoto,
  sendVideoMsg,
  sendVoice,
  type MediaOutboundContext,
  type MediaTargetContext,
  type OutboundResult,
} from "./outbound.js";

const createdRoots: string[] = [];

const account: ResolvedQQBotAccount = {
  accountId: "default",
  enabled: true,
  appId: "app-id",
  clientSecret: "secret",
  secretSource: "config",
  markdownSupport: true,
  config: {},
};

function buildTarget(): MediaTargetContext {
  return {
    targetType: "c2c",
    targetId: "user-1",
    account,
    replyToId: "msg-1",
    logPrefix: "[qqbot:test]",
  };
}

function buildMediaContext(mediaUrl: string): MediaOutboundContext {
  return {
    to: "qqbot:c2c:user-1",
    text: "",
    account,
    mediaUrl,
    replyToId: "msg-1",
  };
}

function createOutsideFile(ext: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-outbound-security-"));
  createdRoots.push(root);
  const filePath = path.join(root, `payload${ext}`);
  fs.writeFileSync(filePath, "payload", "utf8");
  return filePath;
}

function createAllowedCommandDownloadPath(ext: string): string {
  const root = fs.mkdtempSync(path.join(getQQBotDataDir("downloads"), "command-download-"));
  createdRoots.push(root);
  const filePath = path.join(root, `download${ext}`);
  fs.writeFileSync(filePath, "payload", "utf8");
  return filePath;
}

function createAllowedMediaPath(
  ext: string,
  options: { createFile?: boolean; content?: string } = {},
): string {
  const root = fs.mkdtempSync(path.join(getQQBotMediaDir(), "outbound-security-"));
  createdRoots.push(root);
  const filePath = path.join(root, `allowed${ext}`);
  if (options.createFile !== false) {
    fs.writeFileSync(filePath, options.content ?? "payload", "utf8");
  }
  return filePath;
}

function createDelayedMissingMediaPath(ext: string): string {
  const root = fs.mkdtempSync(path.join(getQQBotMediaDir(), "outbound-delayed-security-"));
  createdRoots.push(root);
  return path.join(root, "pending", `delayed${ext}`);
}

function createMissingSymlinkEscapePath(ext: string): string | null {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-outbound-symlink-outside-"));
  createdRoots.push(outsideRoot);

  const inMediaRoot = fs.mkdtempSync(path.join(getQQBotMediaDir(), "outbound-symlink-"));
  createdRoots.push(inMediaRoot);

  const linkPath = path.join(inMediaRoot, "link");
  try {
    fs.symlinkSync(outsideRoot, linkPath, "dir");
  } catch {
    return null;
  }

  return path.join(linkPath, `delayed${ext}`);
}

function writeFileWithParents(filePath: string, content: string = "payload"): number {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return fs.statSync(filePath).size;
}

function installMissingSegmentSymlinkRace(
  delayedVoicePath: string,
  outsideRootPrefix: string,
): boolean {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), outsideRootPrefix));
  createdRoots.push(outsideRoot);

  const symlinkProbe = path.join(path.dirname(path.dirname(delayedVoicePath)), "probe-link");
  try {
    fs.symlinkSync(outsideRoot, symlinkProbe, "dir");
    fs.unlinkSync(symlinkProbe);
  } catch {
    return false;
  }

  audioConvertMocks.waitForFile.mockImplementationOnce(async (candidatePath: string) => {
    const symlinkParent = path.dirname(candidatePath);
    fs.symlinkSync(outsideRoot, symlinkParent, "dir");
    const outsideFile = path.join(outsideRoot, path.basename(candidatePath));
    return writeFileWithParents(outsideFile);
  });

  return true;
}

function expectBlocked(result: OutboundResult, expectedError: string): void {
  expect(result.channel).toBe("qqbot");
  expect(result.error).toBe(expectedError);
  expect(apiMocks.getAccessToken).not.toHaveBeenCalled();
}

const nonDotRelativeTraversalPath = "src/../../../../etc/passwd";

afterEach(() => {
  vi.clearAllMocks();
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("qqbot outbound local media path security", () => {
  it("allows local image paths inside QQ Bot media storage", async () => {
    const allowedPath = createAllowedMediaPath(".png");
    const result = await sendPhoto(buildTarget(), allowedPath);

    expect(result.error).toBeUndefined();
    expect(apiMocks.getAccessToken).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendC2CImageMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks local image paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".png");
    const result = await sendPhoto(buildTarget(), outsidePath);

    expectBlocked(result, "Image path must be inside QQ Bot media storage");
  });

  it("blocks local voice paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".mp3");
    const result = await sendVoice(buildTarget(), outsidePath, undefined, false);

    expectBlocked(result, "Voice path must be inside QQ Bot media storage");
  });

  it("allows delayed local voice paths inside QQ Bot media storage", async () => {
    const delayedVoicePath = createAllowedMediaPath(".mp3", { createFile: false });
    audioConvertMocks.waitForFile.mockImplementationOnce(async (candidatePath: string) =>
      writeFileWithParents(candidatePath),
    );
    const result = await sendVoice(buildTarget(), delayedVoicePath, undefined, true);

    expect(result.error).toBeUndefined();
    expect(apiMocks.getAccessToken).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendC2CVoiceMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks delayed voice paths when a missing segment is replaced by a symlink after precheck", async () => {
    const delayedVoicePath = createDelayedMissingMediaPath(".mp3");
    if (!installMissingSegmentSymlinkRace(delayedVoicePath, "qqbot-outbound-race-outside-")) {
      return;
    }

    const result = await sendVoice(buildTarget(), delayedVoicePath, undefined, true);

    expectBlocked(result, "Voice path must be inside QQ Bot media storage");
  });

  it("returns a blocked result when missing-path canonicalization cannot resolve root", async () => {
    const originalExistsSync = fs.existsSync.bind(fs);
    const originalRealpathSync = fs.realpathSync.bind(fs);

    const existsSpy = vi.spyOn(fs, "existsSync");
    existsSpy.mockImplementation((candidate: fs.PathLike) => {
      const candidateText = typeof candidate === "string" ? candidate : candidate.toString();
      const root = path.parse(candidateText).root;
      if (candidateText === root) {
        return false;
      }
      return originalExistsSync(candidate);
    });

    const realpathSpy = vi.spyOn(fs, "realpathSync");
    realpathSpy.mockImplementation(((candidate: fs.PathLike) => {
      const candidateText = typeof candidate === "string" ? candidate : candidate.toString();
      const root = path.parse(candidateText).root;
      if (candidateText === root) {
        throw new Error("missing-root");
      }
      return originalRealpathSync(candidate);
    }) as typeof fs.realpathSync);

    try {
      const result = await sendVoice(
        buildTarget(),
        "/qqbot-missing-root/sub/path.mp3",
        undefined,
        true,
      );
      expectBlocked(result, "Voice path must be inside QQ Bot media storage");
    } finally {
      existsSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });

  it("blocks delayed voice paths that escape via symlinked parent directories", async () => {
    const delayedVoicePath = createMissingSymlinkEscapePath(".mp3");
    if (!delayedVoicePath) {
      return;
    }

    const result = await sendVoice(buildTarget(), delayedVoicePath, undefined, true);

    expectBlocked(result, "Voice path must be inside QQ Bot media storage");
  });

  it("blocks local video paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".mp4");
    const result = await sendVideoMsg(buildTarget(), outsidePath);

    expectBlocked(result, "Video path must be inside QQ Bot media storage");
  });

  it("blocks local document paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".txt");
    const result = await sendDocument(buildTarget(), outsidePath);

    expectBlocked(result, "File path must be inside QQ Bot media storage");
  });

  it("blocks QQ Bot command-download paths for sendDocument by default", async () => {
    const commandDownloadPath = createAllowedCommandDownloadPath(".txt");
    const result = await sendDocument(buildTarget(), commandDownloadPath);

    expectBlocked(result, "File path must be inside QQ Bot media storage");
  });

  it("allows QQ Bot command-download paths for sendDocument when explicitly enabled", async () => {
    const commandDownloadPath = createAllowedCommandDownloadPath(".txt");
    const result = await sendDocument(buildTarget(), commandDownloadPath, {
      allowQQBotDataDownloads: true,
    });

    expect(result.error).toBeUndefined();
    expect(apiMocks.getAccessToken).toHaveBeenCalledTimes(2);
    expect(apiMocks.sendC2CFileMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks non-dot relative traversal paths for document sends", async () => {
    const result = await sendDocument(buildTarget(), nonDotRelativeTraversalPath);

    expectBlocked(result, "File path must be inside QQ Bot media storage");
  });

  it("blocks sendMedia local paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".txt");
    const result = await sendMedia(buildMediaContext(outsidePath));

    expectBlocked(result, "Media path must be inside QQ Bot media storage");
  });

  it("allows delayed local audio paths in sendMedia inside QQ Bot media storage", async () => {
    const delayedVoicePath = createAllowedMediaPath(".mp3", { createFile: false });
    audioConvertMocks.waitForFile.mockImplementationOnce(async (candidatePath: string) =>
      writeFileWithParents(candidatePath),
    );
    const result = await sendMedia(buildMediaContext(delayedVoicePath));

    expect(result.error).toBeUndefined();
    expect(apiMocks.getAccessToken).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendC2CVoiceMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks sendMedia delayed audio paths when a missing segment is replaced by a symlink", async () => {
    const delayedVoicePath = createDelayedMissingMediaPath(".mp3");
    if (!installMissingSegmentSymlinkRace(delayedVoicePath, "qqbot-outbound-race-sendmedia-")) {
      return;
    }

    const result = await sendMedia(buildMediaContext(delayedVoicePath));

    expectBlocked(
      result,
      "voice: Voice path must be inside QQ Bot media storage | fallback file: File path must be inside QQ Bot media storage",
    );
  });

  it("blocks sendMedia delayed audio paths that escape via symlinked parents", async () => {
    const delayedVoicePath = createMissingSymlinkEscapePath(".mp3");
    if (!delayedVoicePath) {
      return;
    }

    const result = await sendMedia(buildMediaContext(delayedVoicePath));

    expectBlocked(result, "Media path must be inside QQ Bot media storage");
  });

  it("blocks non-dot relative traversal paths in sendMedia", async () => {
    const result = await sendMedia(buildMediaContext(nonDotRelativeTraversalPath));

    expectBlocked(result, "Media path must be inside QQ Bot media storage");
  });
});
