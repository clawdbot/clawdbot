import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultLocalRoots } from "../../media/local-media-access.js";
import { buildWebchatAudioContentBlocksFromReplyPayloads } from "./chat-webchat-media.js";

describe("buildWebchatAudioContentBlocksFromReplyPayloads", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = undefined;
  });

  it("embeds a local audio file as a base64 gateway chat block when it is under localRoots", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: audioPath }],
      { localRoots: [tmpDir] },
    );

    expect(blocks).toHaveLength(1);
    const block = blocks[0] as {
      type?: string;
      source?: { type?: string; media_type?: string; data?: string };
    };
    expect(block.type).toBe("audio");
    expect(block.source?.type).toBe("base64");
    expect(block.source?.media_type).toBe("audio/mpeg");
    expect(block.source?.data?.includes("data:")).toBe(false);
    expect(Buffer.from(block.source?.data ?? "", "base64")).toEqual(
      Buffer.from([0xff, 0xfb, 0x90, 0x00]),
    );
  });

  it("skips remote URLs", async () => {
    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads([
      { mediaUrl: "https://example.com/a.mp3" },
    ]);
    expect(blocks).toHaveLength(0);
  });

  it("skips non-audio local files", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const imagePath = path.join(tmpDir, "clip.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: imagePath }],
      { localRoots: [tmpDir] },
    );

    expect(blocks).toHaveLength(0);
  });

  it("dedupes repeated paths", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x00]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: audioPath }, { mediaUrl: audioPath }],
      { localRoots: [tmpDir] },
    );
    expect(blocks).toHaveLength(1);
  });

  it("embeds file:// URLs pointing at a local file within localRoots", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x01]));

    const fileUrl = pathToFileURL(audioPath).href;
    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads([{ mediaUrl: fileUrl }], {
      localRoots: [tmpDir],
    });

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type?: string }).type).toBe("audio");
  });

  it("drops tool-result file:// URLs with remote hosts before touching the filesystem", async () => {
    const statSpy = vi.spyOn(fs, "statSync");
    const readSpy = vi.spyOn(fs, "readFileSync");

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads([
      {
        text: "MEDIA:file://attacker/share/probe.mp3",
        mediaUrl: "file://attacker/share/probe.mp3",
      },
    ]);

    expect(blocks).toHaveLength(0);
    expect(statSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();

    statSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("rejects a local audio file outside configured localRoots", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const allowedRoot = path.join(tmpDir, "allowed");
    const outsideRoot = path.join(tmpDir, "outside");
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    const audioPath = path.join(outsideRoot, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x03]));

    const onLocalAudioAccessDenied = vi.fn();
    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: audioPath }],
      {
        localRoots: [allowedRoot],
        onLocalAudioAccessDenied,
      },
    );

    expect(blocks).toHaveLength(0);
    expect(onLocalAudioAccessDenied).toHaveBeenCalledOnce();
  });

  it("falls back to default localRoots when explicit roots are omitted", async () => {
    const [defaultRoot] = getDefaultLocalRoots();
    expect(defaultRoot).toBeTruthy();

    fs.mkdirSync(defaultRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(defaultRoot, "openclaw-webchat-audio-default-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x04]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads([{ mediaUrl: audioPath }]);

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type?: string }).type).toBe("audio");
  });

  it("does not read file contents when stat reports size over the cap", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "huge.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x02]));

    const origStat = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((p: fs.PathLike) => {
      if (String(p) === audioPath) {
        return { isFile: () => true, size: 16 * 1024 * 1024 } as fs.Stats;
      }
      return origStat(p);
    });
    const readSpy = vi.spyOn(fs, "readFileSync");

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: audioPath }],
      { localRoots: [tmpDir] },
    );

    expect(blocks).toHaveLength(0);
    expect(readSpy).not.toHaveBeenCalled();

    statSpy.mockRestore();
    readSpy.mockRestore();
  });
});
