import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHeartbeatActiveHoursRuntime } from "./heartbeat-active-hours-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("heartbeat active-hours runtime evidence", () => {
  it("observes active fire, quiet-hours skip, and reload fire", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-active-hours-"));
    tempDirs.push(artifactBase);
    const evidence = await runHeartbeatActiveHoursRuntime({
      artifactBase,
      repoRoot: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(evidence.entries[0]?.result.status).toBe("pass");
    const summary = JSON.parse(
      await fs.readFile(path.join(artifactBase, "heartbeat-active-hours-summary.json"), "utf8"),
    ) as { observations: Array<{ outcome: string }> };
    expect(summary.observations.map((entry) => entry.outcome)).toEqual([
      "active-fire",
      "quiet-hours-skip",
      "active-fire",
    ]);
  });
});
