import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  nodeWorkspaceTransferInvalidReason,
  readNodeWorkspaceUpload,
} from "./node-workspace-upload-reader.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const temporaryRoot = temporary.make("workspace-upload-reader-");
  const file = Buffer.from("file\0bytes");
  const baseRaw = serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries: [] });
  const currentRaw = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit: null,
    entries: [
      {
        path: "result.bin",
        type: "file",
        mode: 0o644,
        size: file.length,
        sha256: createHash("sha256").update(file).digest("hex"),
      },
    ],
  });
  const bodies = [Buffer.from(baseRaw), Buffer.from(currentRaw), file];
  const payload = Buffer.concat(
    bodies.flatMap((body, index) => {
      const header = Buffer.alloc(index === 2 ? 8 : 4);
      if (header.length === 8) {
        header.writeBigUInt64BE(BigInt(body.length));
      } else {
        header.writeUInt32BE(body.length);
      }
      return [header, body];
    }),
  );
  const upload = (chunks: Buffer[], contentLength = payload.length) => {
    const request = Readable.from(chunks) as unknown as IncomingMessage;
    request.headers = { "content-length": String(contentLength) };
    return readNodeWorkspaceUpload({
      request,
      baseManifestRef: `sha256:${createHash("sha256").update(baseRaw).digest("hex")}`,
      temporaryRoot,
      signal: new AbortController().signal,
      assertCurrent: () => {},
      isAuthorized: () => true,
    });
  };
  return { temporaryRoot, file, baseRaw, currentRaw, payload, upload };
}

describe("workspace upload byte stream", () => {
  it.each(["coalesced", "fragmented"])(
    "stages consecutive manifest headers and file bodies in %s chunks",
    async (chunking) => {
      const f = fixture();
      const chunks =
        chunking === "coalesced"
          ? [f.payload]
          : Array.from(f.payload, (byte) => Buffer.from([byte]));
      const result = await f.upload(chunks);

      expect(result.baseRaw).toBe(f.baseRaw);
      expect(result.currentRaw).toBe(f.currentRaw);
      expect(await fs.readFile(path.join(result.stagingRoot, "result.bin"))).toEqual(f.file);
    },
  );

  it("rejects premature EOF across chunk boundaries", async () => {
    const f = fixture();

    await expect(
      f
        .upload([f.payload.subarray(0, 2), f.payload.subarray(2, 3)])
        .catch(nodeWorkspaceTransferInvalidReason),
    ).resolves.toBe("premature_eof");
    expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
  });

  it.each(["buffered", "next chunk"])("rejects trailing bytes in the %s suffix", async (suffix) => {
    const f = fixture();
    const chunks =
      suffix === "buffered"
        ? [Buffer.concat([f.payload, Buffer.from("!")])]
        : [f.payload, Buffer.from("!")];

    await expect(
      f.upload(chunks, f.payload.length + 1).catch(nodeWorkspaceTransferInvalidReason),
    ).resolves.toBe("trailing_bytes");
    expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
  });
});
