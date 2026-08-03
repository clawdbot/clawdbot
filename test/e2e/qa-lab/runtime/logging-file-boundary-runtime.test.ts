import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runLoggingFileBoundary } from "./logging-file-boundary-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("logging file boundary runtime", () => {
  it("rotates valid JSONL and preserves linked trace fields", async () => {
    const root = tempDirs.make("openclaw-logging-boundary-");
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
