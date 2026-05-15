import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultLocalRoots } from "../../media/local-media-access.js";
import {
  buildWebchatAssistantMessageFromReplyPayloads,
  buildWebchatAudioContentBlocksFromReplyPayloads,
} from "./chat-webchat-media.js";

describe("buildWebchatAudioContentBlocksFromReplyPayloads", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = undefined;
  });

  it("exposes a local audio file as a media-ticketed attachment when it is under localRoots", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: audioPath, trustedLocalMedia: true }],
      { localRoots: [tmpDir] },
    );

    expect(blocks).toHaveLength(1);
    const block = blocks[0] as {
      type?: string;
      attachment?: { url?: string; kind?: string; label?: string; mimeType?: string };
    };
    expect(block.type).toBe("attachment");
    expect(block.attachment).toEqual({
      url: fs.realpathSync(audioPath),
      kind: "audio",
      label: "clip.mp3",
      mimeType: "audio/mpeg",
    });
  });

  it("preserves voice-note metadata on local audio attachments", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: audioPath, trustedLocalMedia: true, audioAsVoice: true }],
      { localRoots: [tmpDir] },
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "attachment",
      attachment: {
        isVoiceNote: true,
      },
    });
  });

  it("suppresses reasoning payload audio", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [
        {
          text: "step",
          mediaUrl: audioPath,
          trustedLocalMedia: true,
          isReasoning: true,
        },
      ],
      { localRoots: [tmpDir] },
    );

    expect(blocks).toHaveLength(0);
  });

  it("skips remote URLs", async () => {
    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads([
      { mediaUrl: "https://example.com/a.mp3", trustedLocalMedia: true },
    ]);
    expect(blocks).toHaveLength(0);
  });

  it("skips non-audio local files", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const imagePath = path.join(tmpDir, "clip.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: imagePath, trustedLocalMedia: true }],
      { localRoots: [tmpDir] },
    );

    expect(blocks).toHaveLength(0);
  });

  it("dedupes repeated paths", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x00]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [
        { mediaUrl: audioPath, trustedLocalMedia: true },
        { mediaUrl: audioPath, trustedLocalMedia: true },
      ],
      { localRoots: [tmpDir] },
    );
    expect(blocks).toHaveLength(1);
  });

  it("embeds file:// URLs pointing at a local file within localRoots", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x01]));

    const fileUrl = pathToFileURL(audioPath).href;
    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: fileUrl, trustedLocalMedia: true }],
      {
        localRoots: [tmpDir],
      },
    );

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type?: string }).type).toBe("attachment");
  });

  it("drops tool-result file:// URLs with remote hosts before touching the filesystem", async () => {
    const openSpy = vi.spyOn(fsPromises, "open");

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads([
      {
        text: "MEDIA:file://attacker/share/probe.mp3",
        mediaUrl: "file://attacker/share/probe.mp3",
        trustedLocalMedia: true,
      },
    ]);

    expect(blocks).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
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
      [{ mediaUrl: audioPath, trustedLocalMedia: true }],
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
    if (defaultRoot === undefined) {
      throw new Error("expected default local media root");
    }

    fs.mkdirSync(defaultRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(defaultRoot, "openclaw-webchat-audio-default-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x04]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads([
      { mediaUrl: audioPath, trustedLocalMedia: true },
    ]);

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type?: string }).type).toBe("attachment");
  });

  it("skips local audio when the opened file stat is over the cap", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "huge.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0x02]));
    fs.truncateSync(audioPath, 16 * 1024 * 1024);

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: audioPath, trustedLocalMedia: true }],
      { localRoots: [tmpDir] },
    );

    expect(blocks).toHaveLength(0);
  });

  it("rejects untrusted local audio paths", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-audio-"));
    const audioPath = path.join(tmpDir, "clip.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));

    const blocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: audioPath }],
      { localRoots: [tmpDir] },
    );

    expect(blocks).toHaveLength(0);
  });
});

describe("buildWebchatAssistantMessageFromReplyPayloads", () => {
  it("converts image data URLs into webchat image blocks", async () => {
    const message = await buildWebchatAssistantMessageFromReplyPayloads([
      {
        text: "Scan this QR code with the OpenClaw iOS app:",
        mediaUrl: "data:image/png;base64,cG5n",
      },
    ]);

    expect(message).toEqual({
      transcriptText: "Scan this QR code with the OpenClaw iOS app:",
      content: [
        { type: "text", text: "Scan this QR code with the OpenClaw iOS app:" },
        { type: "input_image", image_url: "data:image/png;base64,cG5n" },
      ],
    });
  });

  it("suppresses reasoning payload media transcripts", async () => {
    const message = await buildWebchatAssistantMessageFromReplyPayloads([
      {
        text: "Reasoning:\n_step_",
        mediaUrl: "data:image/png;base64,cG5n",
        isReasoning: true,
      },
    ]);

    expect(message).toBeNull();
  });

  it("suppresses control tokens and falls back to synthetic image text", async () => {
    const message = await buildWebchatAssistantMessageFromReplyPayloads([
      {
        text: "NO_REPLY",
        mediaUrl: "data:image/png;base64,cG5n",
      },
    ]);

    expect(message).toEqual({
      transcriptText: "Image reply",
      content: [
        { type: "text", text: "Image reply" },
        { type: "input_image", image_url: "data:image/png;base64,cG5n" },
      ],
    });
  });

  it("preserves reply directives in transcript text for media replies", async () => {
    const message = await buildWebchatAssistantMessageFromReplyPayloads([
      {
        replyToCurrent: true,
        mediaUrl: "data:image/png;base64,cG5n",
      },
    ]);

    expect(message).toEqual({
      transcriptText: "[[reply_to_current]]Image reply",
      content: [
        { type: "text", text: "[[reply_to_current]]Image reply" },
        { type: "input_image", image_url: "data:image/png;base64,cG5n" },
      ],
    });
  });

  it("drops oversized data image URLs", async () => {
    const hugeBase64 = "A".repeat(2_100_000);
    const message = await buildWebchatAssistantMessageFromReplyPayloads([
      {
        text: "too large",
        mediaUrl: `data:image/png;base64,${hugeBase64}`,
      },
    ]);

    expect(message).toBeNull();
  });

  it("rejects remote image URLs", async () => {
    const message = await buildWebchatAssistantMessageFromReplyPayloads([
      {
        text: "remote",
        mediaUrl: "https://example.com/final.png",
      },
    ]);

    expect(message).toBeNull();
  });

  it("rejects svg data URLs", async () => {
    const message = await buildWebchatAssistantMessageFromReplyPayloads([
      {
        text: "svg",
        mediaUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      },
    ]);

    expect(message).toBeNull();
  });

  it("sanitizes reply ids before embedding directive prefixes", async () => {
    const message = await buildWebchatAssistantMessageFromReplyPayloads([
      {
        replyToId: "abc]]\n[[audio_as_voice]]",
        mediaUrl: "data:image/png;base64,cG5n",
      },
    ]);

    expect(message).toEqual({
      transcriptText: "[[reply_to:abcaudio_as_voice]]Image reply",
      content: [
        { type: "text", text: "[[reply_to:abcaudio_as_voice]]Image reply" },
        { type: "input_image", image_url: "data:image/png;base64,cG5n" },
      ],
    });
  });
});
