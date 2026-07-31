import fs from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGatewayByteStream,
  resolveByteResponse,
  writeByteHeaders,
} from "./http-byte-range.js";

const FILE = { size: 10, mtimeMs: 1_752_000_000_123.5 };

describe("resolveByteResponse", () => {
  it("resolves an open-ended range", () => {
    expect(
      resolveByteResponse({ file: FILE, method: "GET", rangeHeader: "bytes=4-" }),
    ).toMatchObject({
      kind: "partial",
      statusCode: 206,
      contentLength: 6,
      range: { start: 4, end: 9 },
    });
  });

  it("resolves a suffix range", () => {
    expect(
      resolveByteResponse({ file: FILE, method: "GET", rangeHeader: "bytes=-3" }),
    ).toMatchObject({
      kind: "partial",
      statusCode: 206,
      contentLength: 3,
      range: { start: 7, end: 9 },
    });
  });

  it("resolves an exact range", () => {
    expect(
      resolveByteResponse({ file: FILE, method: "GET", rangeHeader: "bytes=2-5" }),
    ).toMatchObject({
      kind: "partial",
      statusCode: 206,
      contentLength: 4,
      range: { start: 2, end: 5 },
    });
  });

  it("returns 416 with the complete file size for an out-of-bounds range", () => {
    const plan = resolveByteResponse({ file: FILE, method: "GET", rangeHeader: "bytes=10-20" });
    expect(plan).toMatchObject({
      kind: "unsatisfiable",
      statusCode: 416,
      contentLength: 0,
      size: 10,
    });

    const setHeader = vi.fn();
    const res = { statusCode: 0, setHeader } as unknown as ServerResponse;
    writeByteHeaders(res, plan);
    expect(res.statusCode).toBe(416);
    expect(setHeader).toHaveBeenCalledWith("Content-Range", "bytes */10");
  });

  it.each(["items=0-1", "bytes=broken", "bytes=0-1,4-5"])(
    "falls back to a full response for malformed or multipart range %s",
    (rangeHeader) => {
      expect(resolveByteResponse({ file: FILE, method: "GET", rangeHeader })).toMatchObject({
        kind: "full",
        statusCode: 200,
        contentLength: 10,
      });
    },
  );

  it("honors a matching If-Range ETag", () => {
    const etag = resolveByteResponse({ file: FILE }).etag;
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        rangeHeader: "bytes=1-2",
        ifRangeHeader: etag,
      }),
    ).toMatchObject({ kind: "partial", statusCode: 206, range: { start: 1, end: 2 } });
  });

  it("falls back to a full response for a mismatched If-Range ETag", () => {
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        rangeHeader: "bytes=1-2",
        ifRangeHeader: '"different"',
      }),
    ).toMatchObject({ kind: "full", statusCode: 200, contentLength: 10 });
  });

  it.each([
    { label: "exact", header: (etag: string) => etag },
    { label: "weak", header: (etag: string) => `W/${etag}` },
    { label: "wildcard", header: () => "*" },
    { label: "list", header: (etag: string) => `"other", ${etag}` },
    { label: "multiple headers", header: (etag: string) => ['"other"', `W/${etag}`] },
  ])("returns 304 for a matching $label If-None-Match validator", ({ header }) => {
    const etag = resolveByteResponse({ file: FILE }).etag;
    const plan = resolveByteResponse({
      file: FILE,
      method: "GET",
      ifNoneMatchHeader: header(etag),
    });

    expect(plan).toEqual({ kind: "not-modified", statusCode: 304, etag });
    const setHeader = vi.fn();
    const res = { statusCode: 0, setHeader } as unknown as ServerResponse;
    writeByteHeaders(res, plan);
    expect(res.statusCode).toBe(304);
    expect(setHeader).toHaveBeenCalledWith("ETag", etag);
    expect(setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
  });

  it.each(["GET", "HEAD"])(
    "evaluates matching If-None-Match before Range and If-Range for %s",
    (method) => {
      const etag = resolveByteResponse({ file: FILE }).etag;

      expect(
        resolveByteResponse({
          file: FILE,
          method,
          rangeHeader: "bytes=1-2",
          ifRangeHeader: '"stale"',
          ifNoneMatchHeader: etag,
        }),
      ).toEqual({ kind: "not-modified", statusCode: 304, etag });
    },
  );

  it("keeps the requested range when If-None-Match does not match", () => {
    const etag = resolveByteResponse({ file: FILE }).etag;

    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        rangeHeader: "bytes=1-2",
        ifRangeHeader: etag,
        ifNoneMatchHeader: '"stale"',
      }),
    ).toMatchObject({ kind: "partial", statusCode: 206, range: { start: 1, end: 2 } });
  });
});

describe("byte ETag generation", () => {
  it("is stable for the same file identity and changes with size or mtime", () => {
    const etag = resolveByteResponse({ file: FILE }).etag;
    expect(resolveByteResponse({ file: { ...FILE } }).etag).toBe(etag);
    expect(resolveByteResponse({ file: { ...FILE, size: FILE.size + 1 } }).etag).not.toBe(etag);
    expect(resolveByteResponse({ file: { ...FILE, mtimeMs: FILE.mtimeMs + 1 } }).etag).not.toBe(
      etag,
    );
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });
});

describe("Gateway byte response descriptor lifecycle", () => {
  it("destroys the real file stream and closes its descriptor once when its HTTP client disconnects", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-byte-stream-"));
    const filePath = path.join(directory, "media.bin");
    const body = Buffer.alloc(8 * 1024 * 1024, 7);
    await fs.writeFile(filePath, body);
    const handle = await fs.open(filePath, "r");
    const closeHandle = vi.spyOn(handle, "close");
    const createReadStream = vi.spyOn(handle, "createReadStream");
    let resolveResponseClose!: () => void;
    const responseClosed = new Promise<void>((resolve) => {
      resolveResponseClose = resolve;
    });
    const server = http.createServer((_request, response) => {
      const owner = createGatewayByteStream(response, handle, () => {
        response.statusCode = 404;
        response.end("not found");
      });
      const byteResponse = resolveByteResponse({
        file: { size: body.byteLength, mtimeMs: 1 },
        method: "GET",
      });
      writeByteHeaders(response, byteResponse);
      void owner.pipe(byteResponse, "GET");
      response.once("close", resolveResponseClose);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected test HTTP server to bind to a TCP port");
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ host: "127.0.0.1", port: address.port }, (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
        });
        request.once("error", reject);
      });
      await responseClosed;
      await vi.waitFor(() => {
        expect(closeHandle).toHaveBeenCalledOnce();
        expect(handle.fd).toBe(-1);
      });

      const streamedFile = createReadStream.mock.results[0]?.value;
      expect(streamedFile?.destroyed).toBe(true);
      expect(streamedFile?.readableEnded).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("closes a newly opened descriptor when its response ended before streaming began", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-byte-ended-"));
    const filePath = path.join(directory, "media.bin");
    await fs.writeFile(filePath, "media");
    const handle = await fs.open(filePath, "r");
    const closeHandle = vi.spyOn(handle, "close");
    const response = new http.ServerResponse({ method: "GET" } as http.IncomingMessage);
    response.end();
    const owner = createGatewayByteStream(response, handle, () => {});

    try {
      await owner.pipe(
        resolveByteResponse({ file: { size: 5, mtimeMs: 1 }, method: "GET" }),
        "GET",
      );
      expect(closeHandle).toHaveBeenCalledOnce();
      expect(handle.fd).toBe(-1);
    } finally {
      if (handle.fd >= 0) {
        await handle.close();
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
