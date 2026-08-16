import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PERF_SCRIPTS = [
  "apps/android/scripts/perf-online-benchmark.sh",
  "apps/android/scripts/perf-startup-hotspots.sh",
];

describe("Android performance scripts", () => {
  it.each(PERF_SCRIPTS)("installs the Play debug variant in %s", (scriptPath) => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain(":app:installPlayDebug");
    expect(script).not.toContain(":app:installDebug");
  });
});
