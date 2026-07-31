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
const LAST_MODIFIED = new Date(FILE.mtimeMs).toUTCString();

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

  it("honors an If-Range HTTP-date at the file's fractional modification second", () => {
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        rangeHeader: "bytes=1-2",
        ifRangeHeader: LAST_MODIFIED,
      }),
    ).toMatchObject({
      kind: "partial",
      statusCode: 206,
      lastModified: LAST_MODIFIED,
      range: { start: 1, end: 2 },
    });
  });

  it.each([
    { label: "full GET", method: "GET", rangeHeader: undefined, statusCode: 200 },
    { label: "full HEAD", method: "HEAD", rangeHeader: undefined, statusCode: 200 },
    { label: "partial", method: "GET", rangeHeader: "bytes=1-2", statusCode: 206 },
    { label: "unsatisfiable", method: "GET", rangeHeader: "bytes=10-11", statusCode: 416 },
  ])("bounds a future file timestamp to the $label response origin", (params) => {
    const nowMs = FILE.mtimeMs - 60_000;
    const plan = resolveByteResponse({ file: FILE, nowMs, ...params });

    expect(plan.statusCode).toBe(params.statusCode);
    expect(plan.lastModified).toBe(new Date(nowMs).toUTCString());
  });

  it("uses one response-origin timestamp without changing the file identity ETag", () => {
    const nowMs = FILE.mtimeMs - 60_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const future = resolveByteResponse({ file: FILE, method: "GET" });

      expect(dateNow).toHaveBeenCalledOnce();
      expect(future.lastModified).toBe(new Date(nowMs).toUTCString());
      expect(future.etag).toBe(resolveByteResponse({ file: FILE, nowMs: FILE.mtimeMs }).etag);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("matches an If-Range date against the bounded emitted validator", () => {
    const nowMs = FILE.mtimeMs - 60_000;
    const emittedLastModified = new Date(nowMs).toUTCString();

    expect(
      resolveByteResponse({
        file: FILE,
        nowMs,
        method: "GET",
        rangeHeader: "bytes=1-2",
        ifRangeHeader: emittedLastModified,
      }),
    ).toMatchObject({ kind: "partial", statusCode: 206, lastModified: emittedLastModified });
    expect(
      resolveByteResponse({
        file: FILE,
        nowMs,
        method: "GET",
        rangeHeader: "bytes=1-2",
        ifRangeHeader: LAST_MODIFIED,
      }),
    ).toMatchObject({ kind: "full", statusCode: 200, lastModified: emittedLastModified });
  });

  it.each(["GET", "HEAD"])(
    "bounds the future Last-Modified validator on %s not-modified responses",
    (method) => {
      const nowMs = FILE.mtimeMs - 60_000;
      const etag = resolveByteResponse({ file: FILE, nowMs }).etag;

      expect(resolveByteResponse({ file: FILE, method, nowMs, ifNoneMatchHeader: etag })).toEqual({
        kind: "not-modified",
        statusCode: 304,
        etag,
        lastModified: new Date(nowMs).toUTCString(),
      });
    },
  );

  it.each([
    {
      label: "an earlier HTTP-date",
      header: new Date(Date.parse(LAST_MODIFIED) - 1000).toUTCString(),
    },
    {
      label: "a future HTTP-date",
      header: new Date(Date.parse(LAST_MODIFIED) + 1000).toUTCString(),
    },
    {
      label: "an ISO timestamp for the same second",
      header: new Date(Date.parse(LAST_MODIFIED)).toISOString(),
    },
    {
      label: "a non-HTTP timezone for the same second",
      header: LAST_MODIFIED.replace("GMT", "UTC"),
    },
    {
      label: "a lowercase weekday for the same second",
      header: LAST_MODIFIED.replace("Tue", "tue"),
    },
    { label: "a malformed HTTP-date", header: "not-an-http-date" },
    { label: "a weak ETag", header: `W/${resolveByteResponse({ file: FILE }).etag}` },
    { label: "multiple validator values", header: [LAST_MODIFIED, LAST_MODIFIED] },
  ])("ignores a range for $label If-Range", ({ header }) => {
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        rangeHeader: "bytes=1-2",
        ifRangeHeader: header,
      }),
    ).toMatchObject({ kind: "full", statusCode: 200, contentLength: 10 });
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

    expect(plan).toEqual({
      kind: "not-modified",
      statusCode: 304,
      etag,
      lastModified: LAST_MODIFIED,
    });
    const setHeader = vi.fn();
    const res = { statusCode: 0, setHeader } as unknown as ServerResponse;
    writeByteHeaders(res, plan);
    expect(res.statusCode).toBe(304);
    expect(setHeader).toHaveBeenCalledWith("ETag", etag);
    expect(setHeader).toHaveBeenCalledWith("Last-Modified", LAST_MODIFIED);
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
      ).toEqual({ kind: "not-modified", statusCode: 304, etag, lastModified: LAST_MODIFIED });
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

  it.each([
    { label: "full", rangeHeader: undefined, statusCode: 200 },
    { label: "partial", rangeHeader: "bytes=1-2", statusCode: 206 },
    { label: "unsatisfiable", rangeHeader: "bytes=10-11", statusCode: 416 },
  ])(
    "emits the same Last-Modified validator on $label responses",
    ({ rangeHeader, statusCode }) => {
      const plan = resolveByteResponse({ file: FILE, method: "GET", rangeHeader });
      const setHeader = vi.fn();
      const res = { statusCode: 0, setHeader } as unknown as ServerResponse;

      writeByteHeaders(res, plan);

      expect(res.statusCode).toBe(statusCode);
      expect(setHeader).toHaveBeenCalledWith("Last-Modified", LAST_MODIFIED);
    },
  );
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
