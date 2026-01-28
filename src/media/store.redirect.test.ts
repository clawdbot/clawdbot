import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const realOs = await vi.importActual<typeof import("node:os")>("node:os");
const HOME = path.join(realOs.tmpdir(), "moltbot-home-redirect");
const mockRequest = vi.fn();

vi.doMock("node:os", () => ({
  default: { homedir: () => HOME, tmpdir: () => realOs.tmpdir() },
  homedir: () => HOME,
  tmpdir: () => realOs.tmpdir(),
}));

vi.doMock("node:https", () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));
vi.doMock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

const loadStore = async () => await import("./store.js");

describe("media store redirects", () => {
  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockRequest.mockReset();
    vi.resetModules();
  });

  afterAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("follows redirects and keeps detected mime/extension", async () => {
    const { saveMediaSource } = await loadStore();
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

  it("sniffs xlsx from zip content when headers and url extension are missing", async () => {
    const { saveMediaSource } = await loadStore();
    mockRequest.mockImplementationOnce((_url, _opts, cb) => {
      const res = new PassThrough();
      const req = {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          if (event === "error") res.on("error", handler);
          return req;
        },
        end: () => undefined,
        destroy: () => res.destroy(),
      } as const;

      res.statusCode = 200;
      res.headers = {};
      setImmediate(() => {
        cb(res as unknown as Parameters<typeof cb>[0]);
        const zip = new JSZip();
        zip.file(
          "[Content_Types].xml",
          '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        );
        zip.file("xl/workbook.xml", "<workbook/>");
        void zip
          .generateAsync({ type: "nodebuffer" })
          .then((buf) => {
            res.write(buf);
            res.end();
          })
          .catch((err) => {
            res.destroy(err);
          });
      });

      return req;
    });

    const saved = await saveMediaSource("https://example.com/download");
    expect(saved.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(path.extname(saved.path)).toBe(".xlsx");
  });
});
