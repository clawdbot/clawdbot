import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runGatewaySupportExportRuntime } from "./gateway-support-export-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("gateway support export runtime evidence", () => {
  it("runs the real CLI and writes a private payload-free zip", { timeout: 240_000 }, async () => {
    const artifactBase = tempDirs.make("gateway-support-export-");
    const evidence = await runGatewaySupportExportRuntime({
      artifactBase,
      repoRoot: process.cwd(),
    });

    const result = evidence.entries[0]?.result;
    expect(result?.status, result?.failure?.reason).toBe("pass");
    const summary = JSON.parse(
      await fs.readFile(path.join(artifactBase, "gateway-support-export-summary.json"), "utf8"),
    ) as {
      bytes: number;
      entries: string[];
      payloadFree: boolean;
      privateMode: boolean;
      rawLogsIncluded: boolean;
    };
    expect(summary).toMatchObject({
      payloadFree: true,
      privateMode: true,
      rawLogsIncluded: false,
    });
    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.entries).toContain("health/gateway-health.json");
    expect(summary.entries).toContain("status/gateway-status.json");
  });
});
