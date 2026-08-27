import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFixturePlugin,
  runCachedHealthSnapshotBoundariesProof,
  runHandlerBoundaryProof,
  withFixturePlugin,
} from "./cached-health-snapshot-boundaries.js";

describe("cached health snapshot boundary producer", () => {
  it("proves deterministic cache reuse and invalidation boundaries", async () => {
    await expect(runHandlerBoundaryProof()).resolves.toEqual({
      cacheHitSameTimestamp: true,
      cachedMeta: true,
      passiveRefreshBounded: true,
      staleRefresh: true,
      explicitProbeRefresh: true,
      lifecycleMismatchRefresh: true,
      liveOverlayMerged: true,
      publicSensitiveOmitted: true,
    });
  });

  it("builds the fixture plugin configuration used by the real-Gateway lane", async () => {
    const fixture = await createFixturePlugin();
    try {
      const config = withFixturePlugin({} as never, fixture.pluginDir);
      expect(config.plugins).toMatchObject({
        enabled: true,
        allow: ["qa-cached-health-tool"],
        entries: { "qa-cached-health-tool": { enabled: true } },
      });
      expect(config.plugins?.load?.paths).toContain(fixture.pluginDir);
    } finally {
      await fixture.cleanup();
    }
  });

  it.runIf(process.env.OPENCLAW_QA_REAL_GATEWAY === "1")(
    "crosses the real Gateway plugin-tool boundary",
    async () => {
      const proof = await runCachedHealthSnapshotBoundariesProof(
        path.resolve(import.meta.dirname, "../../../.."),
      );

      expect(proof.pluginLoaded).toBe(true);
      expect(proof.pluginToolCataloged).toBe(true);
      expect(proof.pluginToolInvoked).toBe(true);
      expect(proof.healthAfterTool).toBe(true);
    },
    180_000,
  );
});
