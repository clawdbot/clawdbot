// MCP relay media tests cover byte-detected MIME trust boundaries in real staging.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { stageMcpRelayMedia } from "./mcp-tool-result-media.js";

describe("MCP relay media staging", () => {
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-mcp-relay-media-");
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  it("rejects MIME mismatches and fallback-only types before granting provenance", async () => {
    const zip = new JSZip();
    zip.file("payload.txt", "not audio");
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const outboundDir = path.join(tempHome.home, ".openclaw", "media", "outbound");
    await fs.mkdir(outboundDir, { recursive: true });

    const media = await stageMcpRelayMedia({
      serverName: "untrusted-server",
      toolName: "spoofed-media",
      content: [
        {
          type: "image",
          data: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"),
          mimeType: "image/png",
        },
        {
          type: "audio",
          data: zipBuffer.toString("base64"),
          mimeType: "audio/mpeg",
        },
        {
          type: "image",
          data: Buffer.from("plain text with no image signature").toString("base64"),
          mimeType: "image/png",
        },
        {
          type: "audio",
          data: Buffer.from("<!doctype html><title>not audio</title>").toString("base64"),
          mimeType: "audio/mpeg",
        },
      ],
    });

    expect(media).toBeUndefined();
    expect(await fs.readdir(outboundDir)).toEqual([]);
  });

  it("preserves constrained audio hints for byte-identified ambiguous containers", async () => {
    const isomContainer = Buffer.from("000000186674797069736f6d0000000069736f6d69736f6d", "hex");

    const media = await stageMcpRelayMedia({
      serverName: "trusted-server",
      toolName: "audio-container",
      content: [
        {
          type: "audio",
          data: isomContainer.toString("base64"),
          mimeType: "audio/mp4",
        },
      ],
    });

    const attachment = expectDefined(media?.attachments[0], "staged MCP audio attachment");
    expect(attachment).toMatchObject({
      type: "audio",
      mimeType: "audio/mp4",
      name: "trusted-server-audio-container-0.m4a",
      sizeBytes: isomContainer.byteLength,
    });
    expect(await fs.readFile(attachment.mediaUrl)).toEqual(isomContainer);
  });
});
