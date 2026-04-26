import fs from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  LOOPBACK_FETCH_ENV,
  startMediaServerTestHarness,
  type MediaServerTestHarness,
} from "./server.test-support.js";

let MEDIA_DIR = "";
const cleanOldMedia = vi.fn().mockResolvedValue(undefined);

vi.mock("./store.js", async () => {
  const actual = await vi.importActual<typeof import("./store.js")>("./store.js");
  return {
    ...actual,
    getMediaDir: () => MEDIA_DIR,
    cleanOldMedia,
  };
});

let MEDIA_MAX_BYTES: typeof import("./store.js").MEDIA_MAX_BYTES;
let mediaHarness: MediaServerTestHarness | undefined;
const mediaRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-media-test-" });

async function waitForFileRemoval(filePath: string, maxTicks = 1000) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    try {
      await fs.stat(filePath);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${filePath} removal`);
}

describe("media server", () => {
  function mediaUrl(id: string) {
    return mediaHarness?.url(id) ?? "";
  }

  async function writeMediaFile(id: string, contents: string) {
    const filePath = path.join(MEDIA_DIR, id);
    await fs.writeFile(filePath, contents);
    return filePath;
  }

  async function ageMediaFile(filePath: string) {
    const past = Date.now() - 10_000;
    await fs.utimes(filePath, past / 1000, past / 1000);
  }

  async function expectMissingMediaFile(filePath: string) {
    await expect(fs.stat(filePath)).rejects.toThrow();
  }

  async function expectExistingMediaFile(filePath: string) {
    await expect(fs.stat(filePath)).resolves.toEqual(expect.anything());
  }

  function expectFetchedResponse(
    response: Awaited<ReturnType<MediaServerTestHarness["fetch"]>>,
    expected: { status: number; noSniff?: boolean },
  ) {
    expect(response.status).toBe(expected.status);
    if (expected.noSniff) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  }

  async function expectMediaFileLifecycleCase(params: {
    id: string;
    contents: string;
    expectedStatus: number;
    expectedBody?: string;
    mutateFile?: (filePath: string) => Promise<void>;
    assertAfterFetch?: (filePath: string) => Promise<void>;
  }) {
    const file = await writeMediaFile(params.id, params.contents);
    await params.mutateFile?.(file);
    const res = await withEnvAsync(LOOPBACK_FETCH_ENV, () =>
      mediaHarness!.fetch(mediaUrl(params.id)),
    );
    expectFetchedResponse(res, { status: params.expectedStatus });
    if (params.expectedBody !== undefined) {
      expect(await res.text()).toBe(params.expectedBody);
    }
    await params.assertAfterFetch?.(file);
  }

  async function expectFetchedMediaCase(params: {
    mediaPath: string;
    expectedStatus: number;
    expectedBody?: string;
    expectedNoSniff?: boolean;
    setup?: () => Promise<void>;
  }) {
    await params.setup?.();
    const res = await withEnvAsync(LOOPBACK_FETCH_ENV, () =>
      mediaHarness!.fetch(mediaUrl(params.mediaPath)),
    );
    expectFetchedResponse(res, {
      status: params.expectedStatus,
      ...(params.expectedNoSniff ? { noSniff: true } : {}),
    });
    if (params.expectedBody !== undefined) {
      expect(await res.text()).toBe(params.expectedBody);
    }
  }

  async function requestAndAbort(url: string) {
    await new Promise<void>((resolve, reject) => {
      const req = request(url, (res) => {
        res.destroy();
        resolve();
      });
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNRESET") {
          resolve();
          return;
        }
        reject(error);
      });
      req.end();
    });
  }

  beforeAll(async () => {
    ({ MEDIA_MAX_BYTES } = await import("./store.js"));
    mediaHarness = await startMediaServerTestHarness({
      setupMediaRoot: async () => {
        await mediaRootTracker.setup();
        MEDIA_DIR = await mediaRootTracker.make("case");
      },
      cleanupMediaRoot: async () => {
        await mediaRootTracker.cleanup();
        MEDIA_DIR = "";
      },
    });
  });

  afterAll(async () => {
    await mediaHarness?.cleanup();
    mediaHarness = undefined;
  });

  it.each([
    {
      name: "serves media and cleans up after send",
      id: "file1",
      contents: "hello",
      expectedStatus: 200,
      expectedBody: "hello",
      assertAfterFetch: async (filePath: string) => {
        await waitForFileRemoval(filePath);
      },
    },
    {
      name: "expires old media",
      id: "old",
      contents: "stale",
      expectedStatus: 410,
      mutateFile: ageMediaFile,
      assertAfterFetch: expectMissingMediaFile,
    },
  ] as const)("$name", async (testCase) => {
    if (mediaHarness?.listenBlocked) {
      return;
    }
    await expectMediaFileLifecycleCase(testCase);
  });

  it("sets safe fallback headers for untyped media bytes", async () => {
    if (mediaHarness?.listenBlocked) {
      return;
    }
    await writeMediaFile("raw", "hello");

    const res = await withEnvAsync(LOOPBACK_FETCH_ENV, () => mediaHarness!.fetch(mediaUrl("raw")));

    expectFetchedResponse(res, { status: 200, noSniff: true });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe("5");
    expect(await res.text()).toBe("hello");
  });

  it("answers HEAD media probes without consuming the media file", async () => {
    if (mediaHarness?.listenBlocked) {
      return;
    }
    const file = await writeMediaFile("head-probe", "hello");

    const res = await withEnvAsync(LOOPBACK_FETCH_ENV, () =>
      mediaHarness!.fetch(mediaUrl("head-probe"), { method: "HEAD" }),
    );

    expectFetchedResponse(res, { status: 200, noSniff: true });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe("5");
    expect(await res.text()).toBe("");
    await expectExistingMediaFile(file);
  });

  it("forces active text media to download as opaque bytes", async () => {
    if (mediaHarness?.listenBlocked) {
      return;
    }
    await writeMediaFile("page.html", "<script>alert(1)</script>");

    const res = await withEnvAsync(LOOPBACK_FETCH_ENV, () =>
      mediaHarness!.fetch(mediaUrl("page.html")),
    );

    expectFetchedResponse(res, { status: 200, noSniff: true });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="page.html"');
    expect(await res.text()).toBe("<script>alert(1)</script>");
  });

  it("cleans up served media when the client aborts the response", async () => {
    if (mediaHarness?.listenBlocked) {
      return;
    }
    const file = await writeMediaFile("abort", "hello");

    await withEnvAsync(LOOPBACK_FETCH_ENV, () => requestAndAbort(mediaUrl("abort")));

    await waitForFileRemoval(file);
  });

  it.each([
    {
      testName: "blocks path traversal attempts",
      mediaPath: "%2e%2e%2fpackage.json",
      expectedStatus: 400,
      expectedBody: "invalid path",
    },
    {
      testName: "rejects invalid media ids",
      mediaPath: "invalid%20id",
      expectedStatus: 400,
      expectedBody: "invalid path",
      setup: async () => {
        await writeMediaFile("file2", "hello");
      },
    },
    {
      testName: "blocks symlink escaping outside media dir",
      mediaPath: "link-out",
      setup: async () => {
        const target = path.join(process.cwd(), "package.json"); // outside MEDIA_DIR
        const link = path.join(MEDIA_DIR, "link-out");
        await fs.symlink(target, link);
      },
      expectedStatus: 400,
      expectedBody: "invalid path",
    },
    {
      name: "rejects oversized media files",
      mediaPath: "big",
      expectedStatus: 413,
      expectedBody: "too large",
      setup: async () => {
        const file = await writeMediaFile("big", "");
        await fs.truncate(file, MEDIA_MAX_BYTES + 1);
      },
    },
    {
      name: "returns not found for missing media IDs",
      mediaPath: "missing-file",
      expectedStatus: 404,
      expectedBody: "not found",
      expectedNoSniff: true,
    },
    {
      name: "returns 404 when route param is missing (dot path)",
      mediaPath: ".",
      expectedStatus: 404,
    },
    {
      name: "rejects overlong media id",
      mediaPath: `${"a".repeat(201)}.txt`,
      expectedStatus: 400,
      expectedBody: "invalid path",
    },
  ] as const)("%#", async (testCase) => {
    if (mediaHarness?.listenBlocked) {
      return;
    }
    await expectFetchedMediaCase(testCase);
  });
});
