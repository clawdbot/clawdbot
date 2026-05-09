import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFileUtf8AndCleanup,
  stubFetchResponse,
} from "../test-utils/camera-url-test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(async (params: { url: string }) => {
    return {
      response: await globalThis.fetch(params.url),
      finalUrl: params.url,
      release: async () => {},
    };
  }),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
}));

let cameraTempPath: typeof import("./nodes-camera.js").cameraTempPath;
let parseCameraClipPayload: typeof import("./nodes-camera.js").parseCameraClipPayload;
let parseCameraSnapPayload: typeof import("./nodes-camera.js").parseCameraSnapPayload;
let writeCameraClipPayloadToFile: typeof import("./nodes-camera.js").writeCameraClipPayloadToFile;
let writeBase64ToFile: typeof import("./nodes-camera.js").writeBase64ToFile;
let writeUrlToFile: typeof import("./nodes-camera.js").writeUrlToFile;
let parseScreenRecordPayload: typeof import("./nodes-screen.js").parseScreenRecordPayload;
let screenRecordTempPath: typeof import("./nodes-screen.js").screenRecordTempPath;

async function withCameraTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  return await withTempDir("openclaw-test-", run);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("nodes camera helpers", () => {
  beforeAll(async () => {
    ({
      cameraTempPath,
      parseCameraClipPayload,
      parseCameraSnapPayload,
      writeCameraClipPayloadToFile,
      writeBase64ToFile,
      writeUrlToFile,
    } = await import("./nodes-camera.js"));
    ({ parseScreenRecordPayload, screenRecordTempPath } = await import("./nodes-screen.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses camera.snap payload", () => {
    expect(
      parseCameraSnapPayload({
        format: "jpg",
        base64: "aGk=",
        width: 10,
        height: 20,
      }),
    ).toEqual({ format: "jpg", base64: "aGk=", width: 10, height: 20 });
  });

  it("rejects invalid camera.snap payload", () => {
    expect(() => parseCameraSnapPayload({ format: "jpg" })).toThrow(
      /invalid camera\.snap payload/i,
    );
  });

  it("parses camera.clip payload", () => {
    expect(
      parseCameraClipPayload({
        format: "mp4",
        base64: "AAEC",
        durationMs: 1234,
        hasAudio: true,
      }),
    ).toEqual({
      format: "mp4",
      base64: "AAEC",
      durationMs: 1234,
      hasAudio: true,
    });
  });

  it("rejects invalid camera.clip payload", () => {
    expect(() =>
      parseCameraClipPayload({ format: "mp4", base64: "AAEC", durationMs: 1234 }),
    ).toThrow(/invalid camera\.clip payload/i);
  });

  it("builds stable temp paths when id provided", () => {
    const p = cameraTempPath({
      kind: "snap",
      facing: "front",
      ext: "jpg",
      tmpDir: "/tmp",
      id: "id1",
    });
    expect(p).toBe(path.join("/tmp", "openclaw-camera-snap-front-id1.jpg"));
  });

  it("writes camera clip payload to temp path", async () => {
    await withCameraTempDir(async (dir) => {
      const out = await writeCameraClipPayloadToFile({
        payload: {
          format: "mp4",
          base64: "aGk=",
          durationMs: 200,
          hasAudio: false,
        },
        facing: "front",
        tmpDir: dir,
        id: "clip1",
      });
      expect(out).toBe(path.join(dir, "openclaw-camera-clip-front-clip1.mp4"));
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("hi");
    });
  });

  it("writes camera clip payload from url", async () => {
    stubFetchResponse(new Response("url-clip", { status: 200 }));
    await withCameraTempDir(async (dir) => {
      const expectedHost = "198.51.100.42";
      const out = await writeCameraClipPayloadToFile({
        payload: {
          format: "mp4",
          url: `https://${expectedHost}/clip.mp4`,
          durationMs: 200,
          hasAudio: false,
        },
        facing: "back",
        tmpDir: dir,
        id: "clip2",
        expectedHost,
      });
      expect(out).toBe(path.join(dir, "openclaw-camera-clip-back-clip2.mp4"));
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("url-clip");
    });
  });

  it("rejects camera clip url payloads without node remoteIp", async () => {
    stubFetchResponse(new Response("url-clip", { status: 200 }));
    await expect(
      writeCameraClipPayloadToFile({
        payload: {
          format: "mp4",
          url: "https://198.51.100.42/clip.mp4",
          durationMs: 200,
          hasAudio: false,
        },
        facing: "back",
      }),
    ).rejects.toThrow(/node remoteip/i);
  });

  it("writes base64 to file", async () => {
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await writeBase64ToFile(out, "aGk=");
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("hi");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes url payload to file", async () => {
    stubFetchResponse(new Response("url-content", { status: 200 }));
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await writeUrlToFile(out, "https://198.51.100.42/clip.mp4", {
        expectedHost: "198.51.100.42",
      });
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("url-content");
    });
  });

  it("rejects url host mismatches", async () => {
    stubFetchResponse(new Response("url-content", { status: 200 }));
    await expect(
      writeUrlToFile("/tmp/ignored", "https://198.51.100.42/clip.mp4", {
        expectedHost: "198.51.100.43",
      }),
    ).rejects.toThrow(/must match node host/i);
  });

  it.each([
    {
      name: "non-https url",
      url: "http://198.51.100.42/x.bin",
      expectedMessage: /only https/i,
    },
    {
      name: "oversized content-length",
      url: "https://198.51.100.42/huge.bin",
      response: new Response("tiny", {
        status: 200,
        headers: { "content-length": String(999_999_999) },
      }),
      expectedMessage: /exceeds max/i,
    },
    {
      name: "non-ok status",
      url: "https://198.51.100.42/down.bin",
      response: new Response("down", { status: 503, statusText: "Service Unavailable" }),
      expectedMessage: /503/i,
    },
    {
      name: "empty response body",
      url: "https://198.51.100.42/empty.bin",
      response: new Response(null, { status: 200 }),
      expectedMessage: /empty response body/i,
    },
  ] as const)(
    "rejects invalid url payload response: $name",
    async ({ url, response, expectedMessage }) => {
      if (response) {
        stubFetchResponse(response);
      }
      await expect(
        writeUrlToFile("/tmp/ignored", url, { expectedHost: "198.51.100.42" }),
      ).rejects.toThrow(expectedMessage);
    },
  );

  it("removes partially written file when url stream fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("stream exploded"));
      },
    });
    stubFetchResponse(new Response(stream, { status: 200 }));

    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "broken.bin");
      await expect(
        writeUrlToFile(out, "https://198.51.100.42/broken.bin", { expectedHost: "198.51.100.42" }),
      ).rejects.toThrow(/stream exploded/i);
      await expectPathMissing(out);
    });
  });
});

describe("nodes screen helpers", () => {
  it("parses screen.record payload", () => {
    const payload = parseScreenRecordPayload({
      format: "mp4",
      base64: "Zm9v",
      durationMs: 1000,
      fps: 12,
      screenIndex: 0,
      hasAudio: true,
    });
    expect(payload.format).toBe("mp4");
    expect(payload.base64).toBe("Zm9v");
    expect(payload.durationMs).toBe(1000);
    expect(payload.fps).toBe(12);
    expect(payload.screenIndex).toBe(0);
    expect(payload.hasAudio).toBe(true);
  });

  it("drops invalid optional fields instead of throwing", () => {
    const payload = parseScreenRecordPayload({
      format: "mp4",
      base64: "Zm9v",
      durationMs: "nope",
      fps: null,
      screenIndex: "0",
      hasAudio: 1,
    });
    expect(payload.durationMs).toBeUndefined();
    expect(payload.fps).toBeUndefined();
    expect(payload.screenIndex).toBeUndefined();
    expect(payload.hasAudio).toBeUndefined();
  });

  it("rejects invalid screen.record payload", () => {
    expect(() => parseScreenRecordPayload({ format: "mp4" })).toThrow(
      /invalid screen\.record payload/i,
    );
  });

  it("builds screen record temp path", () => {
    const p = screenRecordTempPath({
      ext: "mp4",
      tmpDir: "/tmp",
      id: "id1",
    });
    expect(p).toBe(path.join("/tmp", "openclaw-screen-record-id1.mp4"));
  });
});
