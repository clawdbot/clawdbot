import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  settlePlaybackTranscodeJobsForTest,
  waitForPlaybackTranscodeJobsForTest,
} from "./playback-transcode.test-support.js";

const { runFfmpeg } = vi.hoisted(() => ({ runFfmpeg: vi.fn() }));
vi.mock("./ffmpeg-exec.js", () => ({ runFfmpeg }));
vi.mock("./media-probe.js", () => ({
  probePlaybackMediaFileDescriptor: vi.fn(async () => ({
    durationMs: 1000,
    audioCodec: "pcm_s16le",
    audioStreamIndex: 0,
  })),
}));

let playback: typeof import("./playback-transcode.js");
let tempHome: TempHomeEnv;

beforeAll(async () => {
  vi.resetModules();
  tempHome = await createTempHomeEnv("openclaw-playback-staging-");
  playback = await import("./playback-transcode.js");
});

afterAll(async () => {
  try {
    await tempHome.restore();
  } finally {
    vi.doUnmock("./ffmpeg-exec.js");
    vi.doUnmock("./media-probe.js");
    vi.resetModules();
  }
});

beforeEach(() => {
  runFfmpeg.mockReset();
});

async function createSource(fileName: string, contents: string) {
  const fixturePath = path.join(tempHome.home, fileName);
  await fs.writeFile(fixturePath, contents);
  const sourcePath = await fs.realpath(fixturePath);
  return { sourcePath, sourceStat: await fs.stat(sourcePath) };
}

describe("playback input staging", () => {
  it.each(["grow", "truncate", "rewrite", "replace"] as const)(
    "rejects a source that changes after open via %s before starting ffmpeg",
    async (change) => {
      const source = await createSource(`changed-${change}.caf`, "stable-source");
      let changed = false;
      __setFsSafeTestHooksForTest({
        afterOpenedPathIdentityCheck: async (filePath) => {
          if (filePath !== source.sourcePath || changed) {
            return;
          }
          changed = true;
          if (change === "grow") {
            await fs.appendFile(filePath, "growth");
          } else if (change === "truncate") {
            await fs.truncate(filePath, 1);
          } else if (change === "rewrite") {
            await fs.writeFile(filePath, "edited-source");
            await fs.utimes(
              filePath,
              source.sourceStat.atime,
              new Date(source.sourceStat.mtimeMs + 2000),
            );
            expect((await fs.stat(filePath)).mtimeMs).not.toBe(source.sourceStat.mtimeMs);
          } else {
            await fs.rename(filePath, `${filePath}.old`);
            await fs.writeFile(filePath, "stable-source");
          }
        },
      });
      try {
        const params = {
          ...source,
          mimeType: "audio/x-caf",
          kind: "audio" as const,
          probe: { durationMs: 1000, audioStreamIndex: 0 },
        };
        expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "preparing" });
        await expect(waitForPlaybackTranscodeJobsForTest("all")).rejects.toThrow(
          /changed|mismatch/,
        );
        expect(changed).toBe(true);
        expect(runFfmpeg).not.toHaveBeenCalled();
        expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "fallback" });
      } finally {
        __setFsSafeTestHooksForTest(undefined);
        await settlePlaybackTranscodeJobsForTest();
      }
    },
  );

  it("rejects a moved input that no longer names its staging descriptor", async () => {
    const source = await createSource("replaced-staging.caf", "stable-source");
    const open = fs.open.bind(fs);
    const rename = fs.rename.bind(fs);
    let writer: FileHandle | undefined;
    let writerWasOpenAtMove = false;
    let replaced = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (
        path.basename(String(args[0])) === ".input.caf.stage" &&
        typeof args[1] === "number" &&
        (args[1] & fsConstants.O_WRONLY) !== 0
      ) {
        writer = handle;
      }
      return handle;
    });
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (
        path.basename(String(from)) === ".input.caf.stage" &&
        path.basename(String(to)) === "input.caf"
      ) {
        // Observe the producer's handle without opening another one that would pin the inode.
        writerWasOpenAtMove = writer !== undefined && writer.fd >= 0;
        await rename(from, to);
        await fs.unlink(to);
        await fs.writeFile(to, "stable-source", { mode: 0o600 });
        replaced = true;
      } else {
        await rename(from, to);
      }
    });
    try {
      expect(
        await playback.resolvePlaybackTranscode({
          ...source,
          mimeType: "audio/x-caf",
          kind: "audio",
          probe: { durationMs: 1000, audioStreamIndex: 0 },
        }),
      ).toEqual({ kind: "preparing" });
      const outcome = await waitForPlaybackTranscodeJobsForTest("all").then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      expect(writerWasOpenAtMove).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: expect.objectContaining({ message: expect.stringMatching(/changed|mismatch/) }),
      });
      expect(replaced).toBe(true);
      expect(runFfmpeg).not.toHaveBeenCalled();
      expect(writer?.fd).toBe(-1);
    } finally {
      spy.mockRestore();
      openSpy.mockRestore();
      await settlePlaybackTranscodeJobsForTest();
    }
  });

  it("does not publish a cache entry when workspace cleanup fails", async () => {
    const source = await createSource("cleanup-failed.caf", "stable-source");
    const cleanupError = new Error("synthetic workspace cleanup failure");
    const remove = fs.rm.bind(fs);
    let quarantine: string | undefined;
    const spy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (path.basename(String(target)).startsWith(".fs-safe-workspace-cleanup-")) {
        quarantine = String(target);
        throw cleanupError;
      }
      return remove(target, options);
    });
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
      return "";
    });
    try {
      const params = {
        ...source,
        mimeType: "audio/x-caf",
        kind: "audio" as const,
        probe: { durationMs: 1000, audioStreamIndex: 0 },
      };
      expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "preparing" });
      await expect(waitForPlaybackTranscodeJobsForTest("all")).rejects.toBe(cleanupError);
      expect(runFfmpeg).toHaveBeenCalledOnce();
      expect(quarantine).toBeDefined();
      expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "fallback" });
    } finally {
      spy.mockRestore();
      await settlePlaybackTranscodeJobsForTest();
      if (quarantine) {
        await remove(quarantine, { recursive: true, force: true });
      }
    }
  });
});
