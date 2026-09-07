import type { ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
  resolveLlamaCppDataDir: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
vi.mock("./defaults.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./defaults.js")>()),
  resolveLlamaCppDataDir: mocks.resolveLlamaCppDataDir,
}));

import {
  LLAMA_SERVER_BUILD,
  LLAMA_SERVER_COMMIT,
  type LlamaServerAsset,
} from "./llama-server-assets.js";
import {
  downloadVerifiedFile,
  ensureLlamaServerInstalled,
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
  sha256File,
} from "./llama-server-install.js";

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.execFile.mockReset();
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.resolveLlamaCppDataDir.mockReset();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createDestination(): Promise<{ destination: string; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-download-"));
  tempRoots.push(root);
  return { destination: path.join(root, "model.gguf"), root };
}

async function createInstalledServer(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-installed-"));
  tempRoots.push(root);
  mocks.resolveLlamaCppDataDir.mockReturnValue(root);
  const asset = selectLlamaServerAsset();
  const { command } = resolveManagedLlamaServerPaths(asset);
  await fs.mkdir(path.dirname(command), { recursive: true });
  await fs.writeFile(command, "");
  return command;
}

function mockVersionOutput(output: string): void {
  mocks.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, output, "");
    },
  );
}

function mockDownload(payload: Buffer): ReturnType<typeof vi.fn> {
  const release = vi.fn();
  mocks.fetchWithSsrFGuard.mockResolvedValue({
    response: new Response(new Uint8Array(payload), {
      headers: { "content-length": String(payload.byteLength) },
    }),
    release,
  });
  return release;
}

function injectFileHandle(customize: (handle: FileHandle) => void): void {
  const actualOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    customize(handle);
    return handle;
  });
}

function installWriteFileThroughWrite(handle: FileHandle): void {
  handle.writeFile = (async (data: string | NodeJS.ArrayBufferView) => {
    const buffer =
      typeof data === "string"
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
      if (bytesWritten === 0) {
        throw new Error("injected zero-byte write");
      }
      offset += bytesWritten;
    }
  }) as typeof handle.writeFile;
}

describe("cached file integrity", () => {
  it("reuses unchanged verified bytes but detects replacement, edits, and deletion", async () => {
    const { destination } = await createDestination();
    const original = Buffer.from("GGUFverified");
    const digest = createHash("sha256").update(original).digest("hex");
    await fs.writeFile(destination, original);
    let scans = 0;
    const createReadStream = nodeFs.createReadStream.bind(nodeFs);
    vi.spyOn(nodeFs, "createReadStream").mockImplementation((...args) => {
      scans += 1;
      return createReadStream(...args);
    });
    injectFileHandle((handle) => {
      const stream = handle.createReadStream.bind(handle);
      handle.createReadStream = (...args) => {
        scans += 1;
        return stream(...args);
      };
    });

    expect(await sha256File(destination)).toBe(digest);
    expect(await sha256File(destination)).toBe(digest);
    expect(scans).toBe(1);
    // Preserve length and mtime: inode/ctime changes must still invalidate verification.
    const previous = await fs.stat(destination);
    const replacement = `${destination}.replacement`;
    await fs.writeFile(replacement, "GGUFcorrupt!");
    await fs.utimes(replacement, previous.atime, previous.mtime);
    await fs.rename(replacement, destination);
    expect(await sha256File(destination)).not.toBe(digest);
    await fs.writeFile(destination, original);
    expect(await sha256File(destination)).toBe(digest);
    await fs.rm(destination);
    await expect(sha256File(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(scans).toBe(3);
  });

  it.each(["replacement", "cancellation"] as const)(
    "does not retain a digest after %s during the scan",
    async (mode) => {
      const { destination } = await createDestination();
      const replacement = `${destination}.replacement`;
      await fs.writeFile(destination, Buffer.alloc(2 * 1024 * 1024, 1));
      await fs.writeFile(replacement, "replacement bytes");
      const controller = new AbortController();
      injectFileHandle((handle) => {
        const createReadStream = handle.createReadStream.bind(handle);
        handle.createReadStream = (...args) => {
          const stream = createReadStream(...args);
          stream.once("data", () => {
            if (mode === "cancellation") {
              controller.abort();
            } else {
              nodeFs.renameSync(replacement, destination);
            }
          });
          return stream;
        };
      });
      await expect(sha256File(destination, controller.signal)).rejects.toThrow(
        mode === "cancellation" ? /abort/iu : "File changed during integrity verification",
      );
      vi.restoreAllMocks();
      const actual = createHash("sha256")
        .update(await fs.readFile(destination))
        .digest("hex");
      expect(await sha256File(destination)).toBe(actual);
    },
  );

  it("reuses the download's verified publication without reading it again", async () => {
    const { destination } = await createDestination();
    const payload = Buffer.from("GGUFdownload");
    const digest = createHash("sha256").update(payload).digest("hex");
    mockDownload(payload);
    await downloadVerifiedFile({
      url: "https://downloads.example/model.gguf",
      destination,
      expectedSha256: digest,
    });
    const directScan = vi.spyOn(nodeFs, "createReadStream");
    const opened = vi.spyOn(fs, "open");
    expect(await sha256File(destination)).toBe(digest);
    expect(directScan).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("downloadVerifiedFile", () => {
  it("persists complete chunks before reporting progress under positive short writes", async () => {
    const payload = Buffer.from("short writes must not truncate verified downloads");
    const { destination, root } = await createDestination();
    const release = mockDownload(payload);
    const onProgress = vi.fn();
    const writes: number[] = [];
    injectFileHandle((handle) => {
      const actualWrite = handle.write.bind(handle);
      let firstWrite = true;
      handle.write = (async (
        buffer: Uint8Array,
        offset?: number | null,
        length?: number | null,
        position?: number | null,
      ) => {
        const start = offset ?? 0;
        const requested = length ?? buffer.byteLength - start;
        const result = await actualWrite(
          buffer,
          start,
          firstWrite ? Math.min(7, requested) : requested,
          position,
        );
        firstWrite = false;
        writes.push(result.bytesWritten);
        return result;
      }) as typeof handle.write;
      installWriteFileThroughWrite(handle);
    });

    await downloadVerifiedFile({
      url: "https://downloads.example/model.gguf",
      destination,
      expectedSha256: createHash("sha256").update(payload).digest("hex"),
      expectedSize: payload.byteLength,
      onProgress,
    });

    expect(await fs.readFile(destination)).toEqual(payload);
    expect(writes[0]).toBe(7);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.reduce((total, size) => total + size, 0)).toBe(payload.byteLength);
    const published = await fs.stat(destination);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ downloadedSize: published.size, totalSize: payload.byteLength }),
    );
    if (process.platform !== "win32") {
      expect(published.mode & 0o777).toBe(0o600);
    }
    expect(release).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual(["model.gguf"]);
  });

  it("keeps the destination absent and removes the partial file after a write failure", async () => {
    const payload = Buffer.from("a download that cannot be persisted");
    const { destination, root } = await createDestination();
    const release = mockDownload(payload);
    injectFileHandle((handle) => {
      handle.write = vi.fn(async () => {
        throw new Error("injected write failure");
      }) as typeof handle.write;
      installWriteFileThroughWrite(handle);
    });

    await expect(
      downloadVerifiedFile({
        url: "https://downloads.example/model.gguf",
        destination,
        expectedSha256: createHash("sha256").update(payload).digest("hex"),
        expectedSize: payload.byteLength,
      }),
    ).rejects.toThrow("injected write failure");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("ensureLlamaServerInstalled", () => {
  it("cancels a queued setup without cancelling another installation or poisoning reuse", async () => {
    const command = await createInstalledServer();
    const started = createDeferred<void>();
    const versionReply = createDeferred<string>();
    mocks.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => {
        started.resolve();
        void versionReply.promise.then((output) => callback(null, output, ""));
      },
    );
    const first = ensureLlamaServerInstalled();
    await started.promise;
    const controller = new AbortController();
    const queued = ensureLlamaServerInstalled({ signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    versionReply.resolve(
      `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
    );
    await expect(first).resolves.toMatchObject({ command });
    await expect(ensureLlamaServerInstalled()).resolves.toMatchObject({ command });
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("accepts only the pinned build and commit from the version line", async () => {
    const command = await createInstalledServer();
    mockVersionOutput(
      `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})\nbuilt with test compiler`,
    );

    await expect(ensureLlamaServerInstalled()).resolves.toMatchObject({ command });
  });

  it("rejects a different active build even when output mentions the pinned build later", async () => {
    await createInstalledServer();
    mockVersionOutput(
      `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD + 1}, commit deadbeef0)\ncompatibility note: (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
    );

    await expect(ensureLlamaServerInstalled()).rejects.toThrow(
      `expected b${LLAMA_SERVER_BUILD} (${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
    );
  });

  it("uses the wider version timeout only for a freshly extracted CPU ZIP", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-cpu-install-")));
    tempRoots.push(root);
    mocks.resolveLlamaCppDataDir.mockReturnValue(root);
    const source = selectLlamaServerAsset("win32", "arm64", { kind: "cpu" });
    const serverBytes = await new JSZip()
      .file(source.executable, "server")
      .generateAsync({ type: "nodebuffer" });
    const asset: LlamaServerAsset = {
      ...source,
      sha256: createHash("sha256").update(serverBytes).digest("hex"),
    };
    mockDownload(serverBytes);
    const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
    mocks.execFile.mockImplementation(
      (
        command: string,
        args: string[],
        options: { timeout?: number },
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => {
        calls.push({ command, args, timeout: options.timeout });
        callback(
          null,
          `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
          "",
        );
      },
    );

    const { command } = resolveManagedLlamaServerPaths(asset);
    await expect(ensureLlamaServerInstalled({ asset })).resolves.toMatchObject({ command });
    await expect(ensureLlamaServerInstalled({ asset })).resolves.toMatchObject({ command });

    expect(
      calls.map((call) => ({
        published: call.command === command,
        args: call.args,
        timeout: call.timeout,
      })),
    ).toEqual([
      { published: false, args: ["--version"], timeout: 120_000 },
      { published: true, args: ["--version"], timeout: 15_000 },
      { published: true, args: ["--version"], timeout: 15_000 },
    ]);
    expect(await fs.readFile(command, "utf8")).toBe("server");
    expect((await fs.readdir(root)).every((entry) => !entry.startsWith("."))).toBe(true);
  });

  it("aborts fresh validation and removes the unpublished CPU ZIP files", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-cpu-abort-")));
    tempRoots.push(root);
    mocks.resolveLlamaCppDataDir.mockReturnValue(root);
    const source = selectLlamaServerAsset("win32", "arm64", { kind: "cpu" });
    const serverBytes = await new JSZip()
      .file(source.executable, "server")
      .generateAsync({ type: "nodebuffer" });
    const asset: LlamaServerAsset = {
      ...source,
      sha256: createHash("sha256").update(serverBytes).digest("hex"),
    };
    mockDownload(serverBytes);
    const controller = new AbortController();
    const timeouts: Array<number | undefined> = [];
    mocks.execFile.mockImplementation(
      (
        command: string,
        _args: string[],
        options: { timeout?: number },
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => {
        timeouts.push(options.timeout);
        controller.abort();
        const error = new Error("The operation was aborted") as ExecFileException;
        error.cmd = `${command} --version`;
        callback(error, "", "");
      },
    );

    const { command } = resolveManagedLlamaServerPaths(asset);
    await expect(
      ensureLlamaServerInstalled({ asset, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(timeouts).toEqual([120_000]);
    await expect(fs.stat(command)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["ready", "corrupt-runtime", "missing-runtime", "no-device", "cancelled"] as const)(
    "publishes the complete CUDA installation only after verification: %s",
    async (outcome) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "llama-cuda-install-")),
      );
      tempRoots.push(root);
      mocks.resolveLlamaCppDataDir.mockReturnValue(root);
      const source = selectLlamaServerAsset("win32", "x64", {
        kind: "cuda",
        devices: [{ driverVersion: "551.78", computeCapability: 8.6 }],
      });
      const runtime = source.dependencies![0]!;
      const serverZip = new JSZip()
        .file(source.executable, "server")
        .file("ggml-cuda.dll", "backend");
      const runtimeZip = new JSZip();
      for (const file of runtime.files) {
        if (outcome !== "missing-runtime" || file !== "cudart64_12.dll") {
          runtimeZip.file(file, `runtime:${file}`);
        }
      }
      const serverBytes = await serverZip.generateAsync({ type: "nodebuffer" });
      const runtimeBytes = await runtimeZip.generateAsync({ type: "nodebuffer" });
      const asset: LlamaServerAsset = {
        ...source,
        sha256: createHash("sha256").update(serverBytes).digest("hex"),
        dependencies: [
          {
            ...runtime,
            sha256:
              outcome === "corrupt-runtime"
                ? "0".repeat(64)
                : createHash("sha256").update(runtimeBytes).digest("hex"),
          },
        ],
      };
      const controller = new AbortController();
      const release = vi.fn();
      mocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => {
        const payload = url.endsWith(runtime.name) ? runtimeBytes : serverBytes;
        return { response: new Response(new Uint8Array(payload)), release };
      });
      const validatedFiles: string[][] = [];
      const commandCalls: Array<{ args: string[]; timeout?: number }> = [];
      mocks.execFile.mockImplementation(
        (
          command: string,
          args: string[],
          options: { timeout?: number },
          callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
        ) => {
          commandCalls.push({ args, timeout: options.timeout });
          void fs.readdir(path.dirname(command)).then((files) => {
            validatedFiles.push(files);
            const stdout =
              args[0] === "--version"
                ? `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`
                : outcome === "no-device"
                  ? "Available devices:\n  (none)"
                  : "Available devices:\n  CUDA0: Test GPU (12288 MiB, 11264 MiB free)";
            callback(null, stdout, "");
          });
        },
      );
      const result = ensureLlamaServerInstalled({
        asset,
        signal: controller.signal,
        onProgress: () => {
          if (outcome === "cancelled") {
            controller.abort();
          }
        },
      });
      const { command, installDir } = resolveManagedLlamaServerPaths(asset);
      if (outcome === "ready") {
        await expect(result).resolves.toMatchObject({ command, asset: { backend: "cuda" } });
        for (const file of runtime.files) {
          expect(await fs.readFile(path.join(installDir, file), "utf8")).toBe(`runtime:${file}`);
        }
        expect(validatedFiles.length).toBeGreaterThan(0);
        expect(
          validatedFiles.every((files) => runtime.files.every((file) => files.includes(file))),
        ).toBe(true);
        expect(commandCalls).toEqual([
          { args: ["--version"], timeout: 120_000 },
          { args: ["--list-devices"], timeout: 15_000 },
          { args: ["--version"], timeout: 15_000 },
          { args: ["--list-devices"], timeout: 15_000 },
        ]);
      } else {
        const expected = {
          "corrupt-runtime": /SHA-256 mismatch/u,
          "missing-runtime": /regular file cudart64_12\.dll/u,
          "no-device": /could not initialize an NVIDIA CUDA device/u,
          cancelled: /abort/iu,
        }[outcome];
        await expect(result).rejects.toThrow(expected);
        await expect(fs.stat(command)).rejects.toMatchObject({ code: "ENOENT" });
        if (outcome === "no-device") {
          expect(commandCalls).toEqual([
            { args: ["--version"], timeout: 120_000 },
            { args: ["--list-devices"], timeout: 15_000 },
          ]);
        } else {
          expect(commandCalls).toEqual([]);
        }
      }
      expect((await fs.readdir(root)).every((entry) => !entry.startsWith("."))).toBe(true);
      expect(
        mocks.fetchWithSsrFGuard.mock.calls.every(([request]) => !request.url.includes("win-cpu")),
      ).toBe(true);
    },
  );
});

describe("CUDA runtime selection", () => {
  it("pins the verified archives and extraction limit", () => {
    const asset = selectLlamaServerAsset("win32", "x64", {
      kind: "cuda",
      devices: [{ driverVersion: "551.78", computeCapability: 8.6 }],
    });
    const mebibyte = 1024 * 1024;

    expect(asset).toMatchObject({
      name: "llama-b10809-bin-win-cuda-12.4-x64.zip",
      sha256: "c77bfcd9ed8d91e8721a2d6a290b907fddd4fa5412a47b21c6fa1709116b85f9",
      limits: {
        maxArchiveBytes: 400 * mebibyte,
        maxExtractedBytes: 600 * mebibyte,
        maxEntryBytes: 521 * mebibyte,
      },
      dependencies: [
        {
          name: "cudart-llama-bin-win-cuda-12.4-x64.zip",
          sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
          limits: { maxEntries: 3, maxEntryBytes: 521 * mebibyte },
        },
      ],
    });
  });

  it.each([
    ["551.78", 5, true],
    ["580.1", 8.9, true],
    ["551.77", 8.6, false],
    ["535.1", 8.6, false],
    ["unknown", 8.6, false],
    ["580.1", 3.5, false],
  ] as const)(
    "checks the upstream driver and device contract for %s / SM %s",
    (driverVersion, computeCapability, supported) => {
      const choose = () =>
        selectLlamaServerAsset("win32", "x64", {
          kind: "cuda",
          devices: [{ driverVersion, computeCapability }],
        });
      if (supported) {
        mocks.resolveLlamaCppDataDir.mockReturnValue(os.tmpdir());
        const asset = choose();
        expect(asset.backend).toBe("cuda");
        expect(asset.dependencies?.[0]?.files).toContain("cudart64_12.dll");
        expect(resolveManagedLlamaServerPaths(asset).command).not.toBe(
          resolveManagedLlamaServerPaths(selectLlamaServerAsset("win32", "x64")).command,
        );
      } else {
        expect(choose).toThrow(/driver 551\.78/u);
      }
    },
  );

  it.each(["linux", "win32"] as const)(
    "does not silently replace unavailable CUDA on %s/arm64 with CPU",
    (platform) => {
      expect(() =>
        selectLlamaServerAsset(platform, "arm64", {
          kind: "cuda",
          devices: [{ driverVersion: "580.1" }],
        }),
      ).toThrow(/No verified CUDA/u);
    },
  );
});
