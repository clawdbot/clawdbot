import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLoggingFileBoundary } from "./logging-file-boundary-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("logging file boundary runtime", () => {
  it("rotates valid JSONL and preserves linked trace fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-logging-boundary-"));
    roots.push(root);
    const result = await runLoggingFileBoundary(root);

    expect(result.currentRecords).toBeGreaterThan(0);
    expect(result.archivedRecords).toBeGreaterThan(0);
    expect(result.trace).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      parentSpanId: "1111111111111111",
      traceFlags: "01",
    });
  });
});
