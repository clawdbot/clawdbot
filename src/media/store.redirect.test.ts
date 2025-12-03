import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const realOs = await vi.importActual<typeof import("node:os")>("node:os");
const HOME = path.join(realOs.tmpdir(), "warelay-home-redirect");
const mockRequest = vi.fn();

vi.doMock("node:os", () => ({
  default: { homedir: () => HOME },
  homedir: () => HOME,
}));

vi.doMock("node:https", () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

const { saveMediaSource } = await import("./store.js");

describe("media store redirects", () => {
  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("follows redirects and keeps detected mime/extension", async () => {
    let call = 0;
    mockRequest.mockImplementation((_url, _opts, cb) => {
      call += 1;
      const res = new PassThrough();
      const req = {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          if (event === "error") res.on("error", handler);
          return req;
        },
        end: () => undefined,
        destroy: () => res.destroy(),
      } as const;

      if (call === 1) {
        res.statusCode = 302;
        res.headers = { location: "https://example.com/final" };
        setImmediate(() => {
          cb(res as unknown as Parameters<typeof cb>[0]);
          res.end();
        });
      } else {
        res.statusCode = 200;
        res.headers = { "content-type": "text/plain" };
        setImmediate(() => {
          cb(res as unknown as Parameters<typeof cb>[0]);
          res.write("redirected");
          res.end();
        });
      }

      return req;
    });

    const saved = await saveMediaSource("https://example.com/start");

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(saved.contentType).toBe("text/plain");
    expect(path.extname(saved.path)).toBe(".txt");
    expect(await fs.readFile(saved.path, "utf8")).toBe("redirected");
  });
});
