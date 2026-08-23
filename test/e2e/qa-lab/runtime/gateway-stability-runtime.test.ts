import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runGatewayStabilityRuntime } from "./gateway-stability-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("gateway stability runtime evidence", () => {
  it(
    "proves live RPC, bounded retention, bundle filtering, and export",
    { timeout: 240_000 },
    async () => {
      const artifactBase = tempDirs.make("gateway-stability-runtime-");
      const evidence = await runGatewayStabilityRuntime({
        artifactBase,
        repoRoot: process.cwd(),
      });

      const result = evidence.entries[0]?.result;
      expect(result?.status, result?.failure?.reason).toBe("pass");
      const summary = JSON.parse(
        await fs.readFile(path.join(artifactBase, "gateway-stability-summary.json"), "utf8"),
      ) as {
        liveRpcCapacity: number;
        retainedCount: number;
        droppedCount: number;
        filteredEvents: number;
        bundleReason: string;
        supportBytes: number;
      };
      expect(summary.liveRpcCapacity).toBe(1000);
      expect(summary.retainedCount).toBe(1000);
      expect(summary.droppedCount).toBeGreaterThan(0);
      expect(summary.filteredEvents).toBe(3);
      expect(summary.bundleReason).toBe("qa_gateway_stability");
      expect(summary.supportBytes).toBeGreaterThan(0);
    },
  );
});
