import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "../../test/helpers/promise.js";
import { runUtf8CommandWithTimeout } from "./exec-runner.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const emittedBytes = 128 * 1024;
const cap = 16;
const observed = [];
for (const mode of ["head", "combined-head", "tail"] as const) {
  let clipped: WeakRef<ArrayBufferLike> | undefined;
  let bytes = 0;
  const output = createDeferred();
  const control = new WeakRef(new ArrayBuffer(1024));
  const abort = new AbortController();
  const command = runUtf8CommandWithTimeout(
    [
      process.execPath,
      "-e",
      `process.stdout.write(Buffer.alloc(${emittedBytes}, 88)); setInterval(() => {}, 1000);`,
    ],
    {
      baseEnv: {},
      timeoutMs: 10_000,
      signal: abort.signal,
      outputCapture: mode === "tail" ? "tail" : "head",
      maxOutputBytes: mode === "combined-head" ? emittedBytes : cap,
      ...(mode === "combined-head" ? { maxCombinedOutputBytes: cap } : {}),
      onOutputChunk(chunk, stream) {
        assert.equal(stream, "stdout");
        if (bytes < cap && bytes + chunk.byteLength > cap) {
          clipped = new WeakRef(chunk.buffer);
        }
        bytes += chunk.byteLength;
        if (bytes === emittedBytes) {
          output.resolve();
        }
      },
    },
  );
  try {
    await Promise.race([
      output.promise,
      command.then(() => {
        throw new Error("Command finished before the retention checkpoint");
      }),
    ]);
    assert.ok(clipped, "The child must emit a buffer crossing the capture boundary");
    // Dereferencing during collection would keep the target alive for that job.
    for (let pass = 0; pass < 8; pass += 1) {
      await setImmediate();
      gc();
    }
    assert.equal(control.deref(), undefined, "The uncached GC control must be collected");
    observed.push({ mode, retained: clipped.deref() !== undefined });
  } finally {
    abort.abort();
    const result = await command;
    assert.equal(result.stdout, "X".repeat(cap));
    assert.equal(result.stderr, "");
    assert.equal(result.stdoutTruncatedBytes, emittedBytes - cap);
    assert.equal(result.termination, "signal");
  }
}
process.stdout.write(JSON.stringify(observed));
