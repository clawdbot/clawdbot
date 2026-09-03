// Nodes camera tests cover camera node command media handling and file inputs.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFileUtf8AndCleanup,
  stubFetchResponse,
} from "../test-utils/camera-url-test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";

type PublishOutputFileAtomically =
  typeof import("./output-file.runtime.js").publishOutputFileAtomically;
type FsOpen = typeof import("node:fs/promises").open;

const fsMocks = vi.hoisted(() => ({
  actualOpen: undefined as FsOpen | undefined,
  open: vi.fn<FsOpen>(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  fsMocks.actualOpen = actual.open;
  fsMocks.open.mockImplementation(actual.open);
  return { ...actual, open: fsMocks.open };
});

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: { url: string; timeoutMs?: number; requireHttps?: boolean }) => {
      return {
        response: await globalThis.fetch(params.url),
        finalUrl: params.url,
        release: async () => {},
      };
    },
  ),
}));

const outputFileMocks = vi.hoisted(() => ({
  publishOutputFileAtomically: vi.fn<PublishOutputFileAtomically>(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
}));

vi.mock("./output-file.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
    "./output-file.runtime.js",
  );
  outputFileMocks.publishOutputFileAtomically.mockImplementation(
    actual.publishOutputFileAtomically,
  );
  return {
    ...actual,
    publishOutputFileAtomically: outputFileMocks.publishOutputFileAtomically,
  };
});

let cameraTempPath: typeof import("./nodes-camera.js").cameraTempPath;
let parseCameraClipPayload: typeof import("./nodes-camera.js").parseCameraClipPayload;
let parseCameraSnapPayload: typeof import("./nodes-camera.js").parseCameraSnapPayload;
let resolveCameraClipTarget: typeof import("./nodes-camera.js").resolveCameraClipTarget;
let resolveCameraSnapTargets: typeof import("./nodes-camera.js").resolveCameraSnapTargets;
let writeCameraClipPayloadToFile: typeof import("./nodes-camera.js").writeCameraClipPayloadToFile;
let writeCameraPayloadToFile: typeof import("./nodes-camera.js").writeCameraPayloadToFile;
let writeBase64ToFile: typeof import("./nodes-camera.js").writeBase64ToFile;
let parseScreenRecordPayload: typeof import("./nodes-screen.js").parseScreenRecordPayload;
let parseScreenSnapshotPayload: typeof import("./nodes-screen.js").parseScreenSnapshotPayload;
let screenRecordTempPath: typeof import("./nodes-screen.js").screenRecordTempPath;
let screenSnapshotFormatForPath: typeof import("./nodes-screen.js").screenSnapshotFormatForPath;
let screenSnapshotTempPath: typeof import("./nodes-screen.js").screenSnapshotTempPath;
let writeScreenRecordToFile: typeof import("./nodes-screen.js").writeScreenRecordToFile;
let writeScreenSnapshotToFile: typeof import("./nodes-screen.js").writeScreenSnapshotToFile;
let publishOutputFileAtomically: PublishOutputFileAtomically;

async function withCameraTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  return await withTempDir("openclaw-test-", run);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected missing path: ${targetPath}`);
}

function cancelTrackedResponse(init?: ResponseInit): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ignored"));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("nodes camera helpers", () => {
  beforeAll(async () => {
    ({
      cameraTempPath,
      parseCameraClipPayload,
      parseCameraSnapPayload,
      resolveCameraClipTarget,
      resolveCameraSnapTargets,
      writeCameraClipPayloadToFile,
      writeCameraPayloadToFile,
      writeBase64ToFile,
    } = await import("./nodes-camera.js"));
    ({
      parseScreenRecordPayload,
      parseScreenSnapshotPayload,
      screenRecordTempPath,
      screenSnapshotFormatForPath,
      screenSnapshotTempPath,
      writeScreenRecordToFile,
      writeScreenSnapshotToFile,
    } = await import("./nodes-screen.js"));
    ({ publishOutputFileAtomically } = await vi.importActual("./output-file.runtime.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    if (!fsMocks.actualOpen) {
      throw new Error("expected actual fs.open implementation");
    }
    fsMocks.open.mockImplementation(fsMocks.actualOpen);
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

  it.each([
    {
      name: "malformed base64",
      payload: { format: "jpg", base64: "not-base64!", width: 1, height: 1 },
      expectedError: /invalid base64/i,
    },
    {
      name: "insecure URL",
      payload: { format: "jpg", url: "http://198.51.100.42/photo.jpg", width: 1, height: 1 },
      expectedHost: "198.51.100.42",
      expectedError: /only https/i,
    },
    {
      name: "mismatched URL host",
      payload: { format: "jpg", url: "https://198.51.100.43/photo.jpg", width: 1, height: 1 },
      expectedHost: "198.51.100.42",
      expectedError: /must match node host/i,
    },
    {
      name: "missing URL node host",
      payload: { format: "jpg", url: "https://198.51.100.42/photo.jpg", width: 1, height: 1 },
      expectedError: /node remoteip/i,
    },
    {
      name: "valid URL with malformed base64",
      payload: {
        format: "jpg",
        url: "https://198.51.100.42/photo.jpg",
        base64: "not-base64!",
        width: 1,
        height: 1,
      },
      expectedHost: "198.51.100.42",
      expectedError: /invalid base64/i,
    },
  ])("rejects $name while parsing a camera.snap payload", (testCase) => {
    expect(() =>
      parseCameraSnapPayload(testCase.payload, { expectedHost: testCase.expectedHost }),
    ).toThrow(testCase.expectedError);
  });

  it.each([undefined, "front", "back", "both"] as const)(
    "collapses Linux facing=%s into one unknown-position capture",
    (facing) => {
      expect(resolveCameraSnapTargets({ facing, platform: "linux" })).toEqual([
        { artifactFacing: "unknown" },
      ]);
    },
  );

  it("keeps Linux device selection facing-less", () => {
    expect(
      resolveCameraSnapTargets({ facing: "front", platform: "linux", deviceId: "/dev/video2" }),
    ).toEqual([{ artifactFacing: "unknown" }]);
    expect(
      resolveCameraSnapTargets({ facing: "both", platform: "linux", deviceId: "/dev/video2" }),
    ).toEqual([{ artifactFacing: "unknown" }]);
  });

  it("uses one unknown target when facing is omitted on a positioned camera platform", () => {
    expect(resolveCameraSnapTargets({ platform: "macos" })).toEqual([
      { artifactFacing: "unknown" },
    ]);
    expect(resolveCameraSnapTargets({ platform: "macos", deviceId: "camera-device" })).toEqual([
      { artifactFacing: "unknown" },
    ]);
  });

  it("keeps explicit facing requests for positioned camera platforms", () => {
    expect(resolveCameraSnapTargets({ facing: "front", platform: "macos" })).toEqual([
      { requestFacing: "front", artifactFacing: "front" },
    ]);
    expect(resolveCameraSnapTargets({ facing: "back", platform: "macos" })).toEqual([
      { requestFacing: "back", artifactFacing: "back" },
    ]);
    expect(resolveCameraSnapTargets({ facing: "both", platform: "macos" })).toEqual([
      { requestFacing: "front", artifactFacing: "front" },
      { requestFacing: "back", artifactFacing: "back" },
    ]);
    expect(() =>
      resolveCameraSnapTargets({ facing: "both", platform: "macos", deviceId: "camera-device" }),
    ).toThrow("facing=both is not allowed when deviceId is set");
  });

  it("labels Linux clips as unknown without sending unsupported facing", () => {
    expect(resolveCameraClipTarget({ facing: "back", platform: "linux" })).toEqual({
      artifactFacing: "unknown",
    });
    expect(resolveCameraClipTarget({ facing: "back", platform: "macos" })).toEqual({
      requestFacing: "back",
      artifactFacing: "back",
    });
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

  it("rejects media format path traversal", () => {
    expect(() =>
      cameraTempPath({
        kind: "snap",
        ext: "../escaped",
        tmpDir: "/tmp",
        id: "id1",
      }),
    ).toThrow(/invalid media format/i);
    expect(() =>
      screenRecordTempPath({
        ext: "mp4/../../escaped",
        tmpDir: "/tmp",
        id: "id1",
      }),
    ).toThrow(/invalid media format/i);
    expect(() =>
      screenSnapshotTempPath({
        ext: "png/../../escaped",
        tmpDir: "/tmp",
        id: "id1",
      }),
    ).toThrow(/invalid media format/i);
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

  it("normalizes valid base64 and preserves the destination mode", async () => {
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await fs.writeFile(out, "existing-screen");
      await fs.chmod(out, 0o640);

      await writeBase64ToFile(out, " aGk\n");

      await expect(fs.readFile(out, "utf8")).resolves.toBe("hi");
      if (process.platform !== "win32") {
        expect((await fs.stat(out)).mode & 0o777).toBe(0o640);
      }
      expect(await fs.readdir(dir)).toEqual(["x.bin"]);
    });
  });

  it("preserves an existing output when the decoded media write fails", async () => {
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await fs.writeFile(out, "existing-screen");
      await fs.chmod(out, 0o640);
      outputFileMocks.publishOutputFileAtomically.mockImplementationOnce(async (params) => {
        return await publishOutputFileAtomically({
          ...params,
          writeTemp: async (tempPath) => {
            await params.writeTemp(tempPath);
            await fs.truncate(tempPath, 1);
            throw new Error("injected node media write failure");
          },
        });
      });

      await expect(writeScreenRecordToFile(out, "aGk=")).rejects.toThrow(
        "injected node media write failure",
      );

      await expect(fs.readFile(out, "utf8")).resolves.toBe("existing-screen");
      if (process.platform !== "win32") {
        expect((await fs.stat(out)).mode & 0o777).toBe(0o640);
      }
      expect(await fs.readdir(dir)).toEqual(["x.bin"]);
    });
  });

  it("rejects oversized base64 payloads before writing", async () => {
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await expect(writeBase64ToFile(out, "aGk=", { maxBytes: 1 })).rejects.toThrow(/exceeds max/i);
      await expectPathMissing(out);
      await expect(writeScreenRecordToFile(out, "aGk=", { maxBytes: 1 })).rejects.toThrow(
        /exceeds max/i,
      );
      await expectPathMissing(out);
      await expect(writeScreenSnapshotToFile(out, "aGk=", { maxBytes: 1 })).rejects.toThrow(
        /exceeds max/i,
      );
      await expectPathMissing(out);
    });
  });

  it("rejects empty and malformed base64 payloads before writing", async () => {
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      for (const base64 of ["", " \n", "a", "a===", "not-base64!"]) {
        await expect(writeBase64ToFile(out, base64)).rejects.toThrow(/invalid base64/i);
        await expectPathMissing(out);
      }
      await expect(writeScreenRecordToFile(out, "not-base64!")).rejects.toThrow(/invalid base64/i);
      await expectPathMissing(out);
      await expect(writeScreenSnapshotToFile(out, "not-base64!")).rejects.toThrow(
        /invalid base64/i,
      );
      await expectPathMissing(out);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("writes url payload to file", async () => {
    stubFetchResponse(new Response("url-content", { status: 200 }));
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await writeCameraPayloadToFile({
        filePath: out,
        payload: { url: "https://198.51.100.42/clip.mp4" },
        expectedHost: "198.51.100.42",
      });
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("url-content");
      expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({ requireHttps: true, timeoutMs: 15 * 60_000 }),
      );
    });
  });

  it("fully publishes url chunks after a positive short write", async () => {
    const chunks = [Buffer.from("positive short "), Buffer.from("write")];
    const expected = Buffer.concat(chunks);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    stubFetchResponse(new Response(stream, { status: 200 }));

    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "short-write.bin");
      await fs.writeFile(out, "existing-camera");
      const stagingRoot = `${await fs.realpath(dir)}${path.sep}`;
      const originalOpen = fsMocks.actualOpen;
      if (!originalOpen) {
        throw new Error("expected actual fs.open implementation");
      }
      let shortWriteObserved = false;
      fsMocks.open.mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (typeof args[0] !== "string" || !args[0].startsWith(stagingRoot) || args[1] !== "wx") {
          return handle;
        }

        let injectShortWrite = true;
        const injectedHandle = Object.create(handle) as typeof handle;
        injectedHandle.close = handle.close.bind(handle);
        injectedHandle.write = (async (
          buffer: Uint8Array,
          offset = 0,
          length = buffer.byteLength - offset,
        ) => {
          const writeLength = injectShortWrite ? Math.max(1, Math.floor(length / 2)) : length;
          injectShortWrite = false;
          shortWriteObserved ||= writeLength < length;
          return await handle.write(buffer, offset, writeLength);
        }) as typeof handle.write;
        injectedHandle.writeFile = (async (data: string | NodeJS.ArrayBufferView) => {
          const buffer =
            typeof data === "string"
              ? Buffer.from(data)
              : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          let offset = 0;
          while (offset < buffer.byteLength) {
            const { bytesWritten } = await injectedHandle.write(
              buffer,
              offset,
              buffer.byteLength - offset,
            );
            offset += bytesWritten;
          }
        }) as typeof handle.writeFile;
        return injectedHandle;
      });

      await writeCameraPayloadToFile({
        filePath: out,
        payload: { url: "https://198.51.100.42/short-write.bin" },
        expectedHost: "198.51.100.42",
      });

      expect(shortWriteObserved).toBe(true);
      await expect(fs.readFile(out)).resolves.toEqual(expected);
      await expect(fs.stat(out)).resolves.toMatchObject({ size: expected.byteLength });
      expect(await fs.readdir(dir)).toEqual(["short-write.bin"]);
    });
  });

  it("rejects url host mismatches", async () => {
    stubFetchResponse(new Response("url-content", { status: 200 }));
    await expect(
      writeCameraPayloadToFile({
        filePath: "/tmp/ignored",
        payload: { url: "https://198.51.100.42/clip.mp4" },
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
      name: "malformed content-length",
      url: "https://198.51.100.42/weird.bin",
      response: new Response("tiny", {
        status: 200,
        headers: { "content-length": "0x3" },
      }),
      expectedMessage: /invalid content-length header: 0x3/i,
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
        writeCameraPayloadToFile({
          filePath: "/tmp/ignored",
          payload: { url },
          expectedHost: "198.51.100.42",
        }),
      ).rejects.toThrow(expectedMessage);
    },
  );

  it.each([
    {
      name: "non-ok status",
      response: () => cancelTrackedResponse({ status: 503, statusText: "Service Unavailable" }),
      expectedMessage: /503/i,
    },
    {
      name: "oversized content-length",
      response: () =>
        cancelTrackedResponse({
          status: 200,
          headers: { "content-length": String(999_999_999) },
        }),
      expectedMessage: /exceeds max/i,
    },
    {
      name: "malformed content-length",
      response: () =>
        cancelTrackedResponse({
          status: 200,
          headers: { "content-length": "0x3" },
        }),
      expectedMessage: /invalid content-length/i,
    },
  ] as const)(
    "cancels rejected url response bodies: $name",
    async ({ response, expectedMessage }) => {
      const tracked = response();
      stubFetchResponse(tracked.response);

      await expect(
        writeCameraPayloadToFile({
          filePath: "/tmp/ignored",
          payload: { url: "https://198.51.100.42/down.bin" },
          expectedHost: "198.51.100.42",
        }),
      ).rejects.toThrow(expectedMessage);
      expect(tracked.wasCanceled()).toBe(true);
    },
  );

  it("cancels response bodies when a redirect changes host", async () => {
    const tracked = cancelTrackedResponse({ status: 200 });
    fetchGuardMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: tracked.response,
      finalUrl: "https://198.51.100.43/clip.mp4",
      release: async () => {},
    });

    await expect(
      writeCameraPayloadToFile({
        filePath: "/tmp/ignored",
        payload: { url: "https://198.51.100.42/clip.mp4" },
        expectedHost: "198.51.100.42",
      }),
    ).rejects.toThrow(/redirect host/i);
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("preserves an existing file when url stream fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("stream exploded"));
      },
    });
    stubFetchResponse(new Response(stream, { status: 200 }));

    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "broken.bin");
      const sentinel = Buffer.from("existing-camera");
      await fs.writeFile(out, sentinel);
      await fs.chmod(out, 0o640);

      await expect(
        writeCameraPayloadToFile({
          filePath: out,
          payload: { url: "https://198.51.100.42/broken.bin" },
          expectedHost: "198.51.100.42",
        }),
      ).rejects.toThrow(/stream exploded/i);
      await expect(fs.readFile(out)).resolves.toEqual(sentinel);
      if (process.platform !== "win32") {
        expect((await fs.stat(out)).mode & 0o777).toBe(0o640);
      }
      expect(await fs.readdir(dir)).toEqual(["broken.bin"]);
    });
  });

  it("rejects a url stream that closes without data", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    stubFetchResponse(new Response(stream, { status: 200 }));

    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "empty.bin");
      const sentinel = Buffer.from("existing-camera");
      await fs.writeFile(out, sentinel);
      await fs.chmod(out, 0o640);

      await expect(
        writeCameraPayloadToFile({
          filePath: out,
          payload: { url: "https://198.51.100.42/empty.bin" },
          expectedHost: "198.51.100.42",
        }),
      ).rejects.toThrow(/empty download/i);
      await expect(fs.readFile(out)).resolves.toEqual(sentinel);
      if (process.platform !== "win32") {
        expect((await fs.stat(out)).mode & 0o777).toBe(0o640);
      }
      expect(await fs.readdir(dir)).toEqual(["empty.bin"]);
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

  it("parses screen.snapshot payload", () => {
    expect(
      parseScreenSnapshotPayload({
        format: "png",
        base64: "Zm9v",
        displayFrameId: "display-42-frame",
        screenIndex: 1,
        width: 1200,
        height: 800,
      }),
    ).toEqual({
      format: "png",
      base64: "Zm9v",
      displayFrameId: "display-42-frame",
      screenIndex: 1,
      width: 1200,
      height: 800,
    });
  });

  it("rejects invalid screen.snapshot payload", () => {
    expect(() => parseScreenSnapshotPayload({ format: "png" })).toThrow(
      /invalid screen\.snapshot payload/i,
    );
  });

  it("maps a snapshot output path to the encoding the node should produce", () => {
    expect(screenSnapshotFormatForPath("/workspace/shot.png")).toBe("png");
    expect(screenSnapshotFormatForPath("/workspace/shot.PNG")).toBe("png");
    expect(screenSnapshotFormatForPath("/workspace/shot.jpg")).toBe("jpeg");
    expect(screenSnapshotFormatForPath("/workspace/shot.jpeg")).toBe("jpeg");
    // Nothing recognizable is claimed, so the node's own default should stand.
    expect(screenSnapshotFormatForPath("/workspace/shot")).toBeUndefined();
    expect(screenSnapshotFormatForPath("/workspace/shot.webp")).toBeUndefined();
  });

  it("builds screen snapshot temp path from the reported format", () => {
    expect(screenSnapshotTempPath({ ext: "jpg", tmpDir: "/tmp", id: "id1" })).toBe(
      path.join("/tmp", "openclaw-screen-snapshot-id1.jpg"),
    );
    expect(screenSnapshotTempPath({ ext: "png", tmpDir: "/tmp", id: "id1" })).toBe(
      path.join("/tmp", "openclaw-screen-snapshot-id1.png"),
    );
  });
});
