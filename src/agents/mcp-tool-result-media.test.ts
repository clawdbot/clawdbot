// MCP relay media tests cover byte-detected MIME trust boundaries in real staging.
import fs from "node:fs/promises";
import path from "node:path";
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

  it("rejects and removes staged files whose detected MIME family conflicts with the block", async () => {
    const zip = new JSZip();
    zip.file("payload.txt", "not audio");
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

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
      ],
    });

    expect(media).toBeUndefined();
    expect(await fs.readdir(path.join(tempHome.home, ".openclaw", "media", "outbound"))).toEqual(
      [],
    );
  });
});
