import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
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
const HTTP_DATE_VARIANTS = [
  { label: "IMF-fixdate", value: LAST_MODIFIED },
  { label: "obsolete RFC 850", value: "Tuesday, 08-Jul-25 18:40:00 GMT" },
  { label: "ANSI C asctime", value: "Tue Jul  8 18:40:00 2025" },
] as const;

function createByteRequest(
  headers: Record<string, string | string[] | undefined>,
): Pick<IncomingMessage, "headers" | "headersDistinct"> {
  const entries = Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, value] as const],
  );
  return {
    headers: Object.fromEntries(
      entries.map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]),
    ),
    headersDistinct: Object.fromEntries(
      entries.map(([name, value]) => [name, Array.isArray(value) ? value : [value]]),
    ),
  };
}

describe("resolveByteResponse", () => {
  it("resolves an open-ended range", () => {
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        request: createByteRequest({ range: "bytes=4-" }),
      }),
    ).toMatchObject({
      kind: "partial",
      statusCode: 206,
      contentLength: 6,
      range: { start: 4, end: 9 },
    });
  });

  it("resolves a suffix range", () => {
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        request: createByteRequest({ range: "bytes=-3" }),
      }),
    ).toMatchObject({
      kind: "partial",
      statusCode: 206,
      contentLength: 3,
      range: { start: 7, end: 9 },
    });
  });

  it("resolves an exact range", () => {
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        request: createByteRequest({ range: "bytes=2-5" }),
      }),
    ).toMatchObject({
      kind: "partial",
      statusCode: 206,
      contentLength: 4,
      range: { start: 2, end: 5 },
    });
  });

  it("returns 416 with the complete file size for an out-of-bounds range", () => {
    const plan = resolveByteResponse({
      file: FILE,
      method: "GET",
      request: createByteRequest({ range: "bytes=10-20" }),
    });
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
      expect(
        resolveByteResponse({
          file: FILE,
          method: "GET",
          request: createByteRequest({ range: rangeHeader }),
        }),
      ).toMatchObject({
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
        request: createByteRequest({ range: "bytes=1-2", "if-range": etag }),
      }),
    ).toMatchObject({ kind: "partial", statusCode: 206, range: { start: 1, end: 2 } });
  });

  it("honors an If-Range HTTP-date at the file's fractional modification second", () => {
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        request: createByteRequest({ range: "bytes=1-2", "if-range": LAST_MODIFIED }),
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
    const { rangeHeader, ...rest } = params;
    const plan = resolveByteResponse({
      file: FILE,
      nowMs,
      ...rest,
      request: createByteRequest({ range: rangeHeader }),
    });

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
        request: createByteRequest({ range: "bytes=1-2", "if-range": emittedLastModified }),
      }),
    ).toMatchObject({ kind: "partial", statusCode: 206, lastModified: emittedLastModified });
    expect(
      resolveByteResponse({
        file: FILE,
        nowMs,
        method: "GET",
        request: createByteRequest({ range: "bytes=1-2", "if-range": LAST_MODIFIED }),
      }),
    ).toMatchObject({ kind: "full", statusCode: 200, lastModified: emittedLastModified });
  });

  it.each(["GET", "HEAD"])(
    "bounds the future Last-Modified validator on %s not-modified responses",
    (method) => {
      const nowMs = FILE.mtimeMs - 60_000;
      const etag = resolveByteResponse({ file: FILE, nowMs }).etag;

      expect(
        resolveByteResponse({
          file: FILE,
          method,
          nowMs,
          request: createByteRequest({ "if-none-match": etag }),
        }),
      ).toEqual({
        kind: "not-modified",
        statusCode: 304,
        etag,
        lastModified: new Date(nowMs).toUTCString(),
      });
    },
  );

  it.each(
    HTTP_DATE_VARIANTS.flatMap(({ label, value }) =>
      (["GET", "HEAD"] as const).map((method) => ({ label, value, method })),
    ),
  )("revalidates $method using a $label If-Modified-Since date", ({ value, method }) => {
    expect(
      resolveByteResponse({
        file: FILE,
        method,
        request: createByteRequest({ "if-modified-since": value }),
      }),
    ).toMatchObject({ kind: "not-modified", statusCode: 304, lastModified: LAST_MODIFIED });
  });

  it.each(["GET", "HEAD"] as const)(
    "honors a later If-Modified-Since date before ranges for %s",
    (method) => {
      expect(
        resolveByteResponse({
          file: FILE,
          method,
          request: createByteRequest({
            "if-modified-since": new Date(Date.parse(LAST_MODIFIED) + 1_000).toUTCString(),
            range: "bytes=1-2",
            "if-range": '"stale"',
          }),
        }),
      ).toMatchObject({ kind: "not-modified", statusCode: 304, lastModified: LAST_MODIFIED });
    },
  );

  it.each(["GET", "HEAD"] as const)(
    "compares If-Modified-Since against the future-clamped %s validator",
    (method) => {
      const nowMs = FILE.mtimeMs - 60_000;
      const emittedLastModified = new Date(nowMs).toUTCString();

      expect(
        resolveByteResponse({
          file: FILE,
          nowMs,
          method,
          request: createByteRequest({ "if-modified-since": emittedLastModified }),
        }),
      ).toMatchObject({ kind: "not-modified", statusCode: 304, lastModified: emittedLastModified });
    },
  );

  it("interprets an obsolete RFC 850 year within the RFC's rolling 50-year window", () => {
    expect(
      resolveByteResponse({
        file: FILE,
        nowMs: Date.UTC(2026, 0, 1),
        method: "GET",
        request: createByteRequest({ "if-modified-since": "Sunday, 06-Nov-50 00:00:00 GMT" }),
      }),
    ).toMatchObject({ kind: "not-modified", statusCode: 304 });
  });

  it("includes a leap second when applying the RFC 850 rolling-year boundary", () => {
    expect(
      resolveByteResponse({
        file: { size: 10, mtimeMs: Date.UTC(1977, 0, 1) },
        nowMs: Date.UTC(2026, 11, 31, 23, 59, 59),
        method: "GET",
        request: createByteRequest({ "if-modified-since": "Friday, 31-Dec-76 23:59:60 GMT" }),
      }),
    ).toMatchObject({ kind: "not-modified", statusCode: 304 });
  });

  it("accepts a valid HTTP-date leap second without JavaScript date normalization", () => {
    expect(
      resolveByteResponse({
        file: { size: 10, mtimeMs: Date.UTC(2017, 0, 1) },
        method: "GET",
        request: createByteRequest({ "if-modified-since": "Sat, 31 Dec 2016 23:59:60 GMT" }),
      }),
    ).toMatchObject({ kind: "not-modified", statusCode: 304 });
  });

  it.each([
    { label: "an ISO timestamp", value: new Date(FILE.mtimeMs).toISOString() },
    { label: "the wrong timezone", value: LAST_MODIFIED.replace("GMT", "UTC") },
    { label: "a lowercase weekday", value: LAST_MODIFIED.replace("Tue", "tue") },
    { label: "the wrong calendar weekday", value: LAST_MODIFIED.replace("Tue", "Wed") },
    { label: "a four-digit IMF year before 1900", value: "Tue, 08 Jul 0025 18:40:00 GMT" },
    { label: "a four-digit asctime year before 1900", value: "Tue Jul  8 18:40:00 0025" },
    { label: "a four-digit IMF year zero", value: "Tue, 08 Jul 0000 18:40:00 GMT" },
    { label: "a four-digit asctime year zero", value: "Tue Jul  8 18:40:00 0000" },
    { label: "a four-digit IMF year 0099", value: "Tue, 08 Jul 0099 18:40:00 GMT" },
    { label: "a four-digit asctime year 0099", value: "Tue Jul  8 18:40:00 0099" },
    { label: "a normalized invalid calendar day", value: "Tue, 32 Jul 2025 18:40:00 GMT" },
    { label: "trailing content", value: `${LAST_MODIFIED} trailing` },
    { label: "multiple date members", value: `${LAST_MODIFIED}, ${LAST_MODIFIED}` },
    { label: "multiple header fields", value: [LAST_MODIFIED, LAST_MODIFIED] },
  ])("ignores $label in If-Modified-Since", ({ value }) => {
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        request: createByteRequest({ "if-modified-since": value }),
      }),
    ).toMatchObject({ kind: "full", statusCode: 200 });
  });

  it.each(["", '"different"', ['"different"']] as Array<string | string[]>)(
    "ignores If-Modified-Since whenever any If-None-Match field is present (%j)",
    (ifNoneMatch) => {
      expect(
        resolveByteResponse({
          file: FILE,
          method: "GET",
          request: createByteRequest({
            "if-none-match": ifNoneMatch,
            "if-modified-since": LAST_MODIFIED,
          }),
        }),
      ).toMatchObject({ kind: "full", statusCode: 200 });
    },
  );

  it("ignores duplicate singleton dates hidden by Node's normalized headers", () => {
    const headers = { "if-modified-since": LAST_MODIFIED };

    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        request: {
          headers,
          headersDistinct: {
            "if-modified-since": [
              LAST_MODIFIED,
              new Date(Date.parse(LAST_MODIFIED) - 1_000).toUTCString(),
            ],
          },
        },
      }),
    ).toMatchObject({ kind: "full", statusCode: 200 });
  });

  it("interprets asctime dates as UTC rather than the host's local timezone", () => {
    expect(
      resolveByteResponse({
        file: { size: 10, mtimeMs: Date.UTC(1994, 10, 6, 12) },
        method: "GET",
        request: createByteRequest({ "if-modified-since": "Sun Nov  6 08:49:37 1994" }),
      }),
    ).toMatchObject({ kind: "full", statusCode: 200 });
  });

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
        request: createByteRequest({ range: "bytes=1-2", "if-range": header }),
      }),
    ).toMatchObject({ kind: "full", statusCode: 200, contentLength: 10 });
  });

  it("falls back to a full response for a mismatched If-Range ETag", () => {
    expect(
      resolveByteResponse({
        file: FILE,
        method: "GET",
        request: createByteRequest({ range: "bytes=1-2", "if-range": '"different"' }),
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
      request: createByteRequest({ "if-none-match": header(etag) }),
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
          request: createByteRequest({
            range: "bytes=1-2",
            "if-range": '"stale"',
            "if-none-match": etag,
          }),
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
        request: createByteRequest({
          range: "bytes=1-2",
          "if-range": etag,
          "if-none-match": '"stale"',
        }),
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
      const plan = resolveByteResponse({
        file: FILE,
        method: "GET",
        request: createByteRequest({ range: rangeHeader }),
      });
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
