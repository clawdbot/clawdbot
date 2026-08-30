// OutputAccumulator tests cover bounded UTF-8 tails and private spill files.
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../../../test-utils/node-process.js";
import { OutputAccumulator } from "./output-accumulator.js";

describe("OutputAccumulator", () => {
  it("stores spilled full output in an owner-only temp file", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 8,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    accumulator.append(Buffer.from("secret output"));
    accumulator.finish();
    const snapshot = accumulator.snapshot({ persistIfTruncated: true });
    await accumulator.closeTempFile();
    await accumulator.closeTempFile();

    expect(snapshot.fullOutputPath).toBeDefined();
    // Spilled output can include command secrets, so temp files must be
    // owner-only even though their path is returned to the local operator.
    const mode = (await stat(snapshot.fullOutputPath!)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
    await rm(snapshot.fullOutputPath!, { force: true });
  });

  it("reports an early native spill error when closed later and again", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "openclaw-output-error-")));
    const ownerUrl = new URL("./output-accumulator.ts", import.meta.url).href;
    try {
      const result = spawnNodeEvalSync(
        `import assert from "node:assert/strict";
         import { errorMonitor } from "node:events";
         import fs from "node:fs";
         import { syncBuiltinESMExports } from "node:module";
         import { tmpdir } from "node:os";
         import { dirname, join } from "node:path";
         import { setImmediate } from "node:timers/promises";
         const { OutputAccumulator } = await import(${JSON.stringify(ownerUrl)});
         assert.equal(process.listenerCount("uncaughtException"), 0);
         assert.equal(process.listenerCount("unhandledRejection"), 0);
         assert.equal(process.hasUncaughtExceptionCaptureCallback(), false);
         const missing = join(${JSON.stringify(root)}, "missing");
         process.env.TMPDIR = process.env.TMP = process.env.TEMP = missing;
         assert.equal(tmpdir(), missing);
         assert.equal(fs.existsSync(missing), false);
         const createWriteStream = fs.createWriteStream;
         let observeFailure;
         const failure = new Promise((resolve) => { observeFailure = resolve; });
         fs.createWriteStream = function (...args) {
           const stream = Reflect.apply(createWriteStream, this, args);
           stream.once(errorMonitor, observeFailure);
           return stream;
         };
         syncBuiltinESMExports();
         try {
           const output = new OutputAccumulator({ maxBytes: 8, tempFilePrefix: "openclaw-output-test" });
           output.append(Buffer.from("output before finalization"), "stdout");
           const error = await failure;
           await setImmediate();
           assert.equal(error.code, "ENOENT");
           assert.equal(error.syscall, "open");
           assert.equal(dirname(error.path), missing);
           output.finish();
           await assert.rejects(output.closeTempFile(), (actual) => actual === error);
           await assert.rejects(output.closeTempFile(), (actual) => actual === error);
           console.log("native spill error retained through repeated close");
         } finally {
           fs.createWriteStream = createWriteStream;
           syncBuiltinESMExports();
         }`,
        {
          imports: ["tsx"],
          timeout: 20_000,
          maxBuffer: 64 * 1024,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: root,
            TMPDIR: root,
            TMP: root,
            TEMP: root,
            NODE_DISABLE_COMPILE_CACHE: "1",
            TSX_DISABLE_CACHE: "1",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("native spill error retained through repeated close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps complete UTF-8 characters in a byte-bounded tail", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 5,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    accumulator.append(Buffer.from("a🙂b"));
    accumulator.finish();
    const snapshot = accumulator.snapshot({ persistIfTruncated: true });
    await accumulator.closeTempFile();

    expect(snapshot.content).toBe("🙂b");
    expect(snapshot.truncation.totalBytes).toBe(6);
    expect(snapshot.truncation.outputBytes).toBe(5);
    expect(snapshot.fullOutputPath).toBeDefined();
    await rm(snapshot.fullOutputPath!, { force: true });
  });

  it("flushes pending bytes held by every stream lane", () => {
    // Each lane decodes independently, so a truncated character left on one
    // pipe must not stop the other pipe's tail from being flushed.
    const accumulator = new OutputAccumulator();

    accumulator.append(Buffer.from([0xe6, 0x97]), "stdout"); // leading bytes of 日
    accumulator.append(Buffer.from([0xe6, 0x97]), "stderr");

    const flushed = accumulator.finish();

    expect(flushed).toBe("��");
  });

  it("spills tagged streams in decoded delivery order", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 1,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    accumulator.append(Buffer.from([0xe6, 0x97]), "stdout"); // leading bytes of 日
    accumulator.append(Buffer.from("E"), "stderr");
    accumulator.append(Buffer.from([0xa5]), "stdout");
    accumulator.finish();
    const snapshot = accumulator.snapshot({ persistIfTruncated: true });
    await accumulator.closeTempFile();

    expect(snapshot.fullOutputPath).toBeDefined();
    expect(await readFile(snapshot.fullOutputPath!, "utf8")).toBe("E日");
    await rm(snapshot.fullOutputPath!, { force: true });
  });
});
