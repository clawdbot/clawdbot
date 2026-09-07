// Discord tests cover sender-scoped media policy on guild asset uploads.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uploadEmojiDiscord, uploadStickerDiscord } from "./send.emojis-stickers.js";
import { makeDiscordRest, requestBody, type MockCallSource } from "./send.test-harness.js";

// 1x1 PNG so the real media loader sniffs an upload-eligible content type.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nKsAAAAASUVORK5CYII=",
  "base64",
);

const cfg = { channels: { discord: { token: "tok" } } } as OpenClawConfig;

describe("guild asset uploads enforce the sender-scoped media policy", () => {
  let tmpDir: string;
  let senderRoot: string;
  let otherRoot: string;
  let allowedFile: string;
  let deniedFile: string;

  beforeAll(async () => {
    // The denied source lives under a default media root, so only the sender-scoped
    // policy can keep it out of the outbound upload.
    const defaultRoot = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(defaultRoot, { recursive: true });
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(defaultRoot, "discord-media-policy-")));
    senderRoot = path.join(tmpDir, "sender-workspace");
    otherRoot = path.join(tmpDir, "other-workspace");
    await fs.mkdir(senderRoot, { recursive: true });
    await fs.mkdir(otherRoot, { recursive: true });
    allowedFile = path.join(senderRoot, "allowed.png");
    deniedFile = path.join(otherRoot, "denied.png");
    await fs.writeFile(allowedFile, PNG_BYTES);
    await fs.writeFile(deniedFile, PNG_BYTES);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects an emoji source outside the sender roots without issuing a request", async () => {
    const { rest, postMock } = makeDiscordRest();
    await expect(
      uploadEmojiDiscord(
        { guildId: "g1", name: "denied_blob", mediaUrl: deniedFile },
        { cfg, rest, token: "tok", mediaLocalRoots: [senderRoot] },
      ),
    ).rejects.toThrow(/not under an allowed directory/i);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("uploads an emoji source inside the sender roots", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "e1" });
    await uploadEmojiDiscord(
      { guildId: "g1", name: "allowed_blob", mediaUrl: allowedFile },
      { cfg, rest, token: "tok", mediaLocalRoots: [senderRoot] },
    );
    const body = requestBody(postMock as unknown as MockCallSource);
    expect(body.image).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
  });

  it("rejects a sticker source outside the sender roots without issuing a request", async () => {
    const { rest, postMock } = makeDiscordRest();
    await expect(
      uploadStickerDiscord(
        {
          guildId: "g1",
          name: "denied_blob",
          description: "denied",
          tags: "x",
          mediaUrl: deniedFile,
        },
        { cfg, rest, token: "tok", mediaLocalRoots: [senderRoot] },
      ),
    ).rejects.toThrow(/not under an allowed directory/i);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("uploads a sticker source inside the sender roots", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "s1" });
    await uploadStickerDiscord(
      {
        guildId: "g1",
        name: "allowed_blob",
        description: "allowed",
        tags: "x",
        mediaUrl: allowedFile,
      },
      { cfg, rest, token: "tok", mediaLocalRoots: [senderRoot] },
    );
    const body = requestBody(postMock as unknown as MockCallSource);
    const files = body.files as Array<{ data: Buffer }>;
    expect(files[0]?.data).toEqual(PNG_BYTES);
  });
});
