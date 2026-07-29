import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { resolveByteResponse, writeByteHeaders } from "./http-byte-range.js";

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
