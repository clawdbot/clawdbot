// Discord tests cover send.voice plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDiscordRest } from "./send.test-harness.js";

const loadWebMediaRawMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMediaRaw: loadWebMediaRawMock,
}));

const voiceMocks = vi.hoisted(() => ({
  ensureOggOpus: vi.fn(),
  getVoiceMessageMetadata: vi.fn(),
  sendDiscordVoiceMessage: vi.fn(),
}));
vi.mock("./voice-message.js", () => voiceMocks);

const DISCORD_TEST_CFG = {
  channels: { discord: { token: "t" } },
};

let sendVoiceMessageDiscord: typeof import("./send.voice.js").sendVoiceMessageDiscord;

describe("sendVoiceMessageDiscord", () => {
  beforeAll(async () => {
    ({ sendVoiceMessageDiscord } = await import("./send.voice.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadWebMediaRawMock.mockResolvedValue({
      buffer: Buffer.from("voice"),
      fileName: "voice.ogg",
      contentType: "audio/ogg",
      kind: "audio",
    });
    voiceMocks.ensureOggOpus.mockImplementation(async (inputPath: string) => ({
      path: inputPath,
      cleanup: false,
    }));
    voiceMocks.getVoiceMessageMetadata.mockResolvedValue({ duration_secs: 1, waveform: "" });
    voiceMocks.sendDiscordVoiceMessage.mockResolvedValue({
      id: "msg1",
      channel_id: "273512430271856640",
    });
  });

  it("treats bare numeric voice targets as channels", async () => {
    const { rest } = makeDiscordRest();

    const result = await sendVoiceMessageDiscord(
      "273512430271856640",
      "https://example.com/voice.ogg",
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
      },
    );

    expect(result.channelId).toBe("273512430271856640");
    expect(voiceMocks.sendDiscordVoiceMessage).toHaveBeenCalledTimes(1);
    expect(voiceMocks.sendDiscordVoiceMessage.mock.calls[0]?.[1]).toBe("273512430271856640");
  });

  it("records the native reply target in voice receipts", async () => {
    const { rest } = makeDiscordRest();

    const result = await sendVoiceMessageDiscord(
      "273512430271856640",
      "https://example.com/voice.ogg",
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        reply: { messageId: "reply-1", scope: "first" },
      },
    );

    expect(voiceMocks.sendDiscordVoiceMessage.mock.calls[0]?.[4]).toBe("reply-1");
    expect(result.receipt.replyToId).toBe("reply-1");
    expect(result.receipt.parts[0]?.replyToId).toBe("reply-1");
  });

  it("reads relative voice files from the trusted reader-free workspace without widening its roots", async () => {
    const fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-voice-")),
    );
    const workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "voice.ogg"), Buffer.from("OggS trusted voice"));
    await fs.writeFile(path.join(fixtureRoot, "outside.ogg"), Buffer.from("OggS outside voice"));
    const mediaAccess = { localRoots: [workspaceDir], workspaceDir };
    const { loadWebMediaRaw } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/web-media")
    >("openclaw/plugin-sdk/web-media");
    loadWebMediaRawMock.mockImplementation(loadWebMediaRaw);
    const { rest } = makeDiscordRest();

    try {
      await sendVoiceMessageDiscord("273512430271856640", "./voice.ogg", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaAccess,
      });

      const [, loaderOptions] = loadWebMediaRawMock.mock.calls[0] ?? [];
      expect(loaderOptions).toMatchObject({ localRoots: mediaAccess.localRoots, workspaceDir });
      expect(loaderOptions.localRoots).toBe(mediaAccess.localRoots);
      expect(loaderOptions).not.toHaveProperty("readFile");
      expect(loaderOptions).not.toHaveProperty("hostReadCapability");
      expect(voiceMocks.sendDiscordVoiceMessage).toHaveBeenCalledTimes(1);

      await expect(
        sendVoiceMessageDiscord("273512430271856640", "../outside.ogg", {
          cfg: DISCORD_TEST_CFG,
          rest,
          token: "t",
          mediaAccess,
        }),
      ).rejects.toThrow(/not under an allowed directory/i);
      expect(voiceMocks.sendDiscordVoiceMessage).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each(["canonical", "split"] as const)(
    "preserves the trusted %s host reader and its explicit roots",
    async (capabilityShape) => {
      const mediaLocalRoots = ["/tmp/agent-workspace"];
      const mediaReadFile = vi.fn(async () => Buffer.from("trusted voice"));
      const mediaAccess = {
        localRoots: mediaLocalRoots,
        readFile: mediaReadFile,
        workspaceDir: "/tmp/agent-workspace",
      };
      const { rest } = makeDiscordRest();

      await sendVoiceMessageDiscord("273512430271856640", "./voice.ogg", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        ...(capabilityShape === "canonical" ? { mediaAccess } : { mediaLocalRoots, mediaReadFile }),
      });

      const [, loaderOptions] = loadWebMediaRawMock.mock.calls[0] ?? [];
      expect(loaderOptions.localRoots).toBe(mediaLocalRoots);
      expect(loaderOptions.readFile).toBe(mediaReadFile);
      expect(loaderOptions.hostReadCapability).toBe(true);
      if (capabilityShape === "canonical") {
        expect(loaderOptions.workspaceDir).toBe(mediaAccess.workspaceDir);
      } else {
        expect(loaderOptions).not.toHaveProperty("workspaceDir");
      }
    },
  );

  it("rejects a trusted host reader that has no explicit root boundary", async () => {
    const { rest } = makeDiscordRest();

    await expect(
      sendVoiceMessageDiscord("273512430271856640", "./voice.ogg", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaReadFile: vi.fn(async () => Buffer.from("voice")),
      }),
    ).rejects.toThrow(/Host media read requires explicit localRoots/i);
    expect(loadWebMediaRawMock).not.toHaveBeenCalled();
  });
});
