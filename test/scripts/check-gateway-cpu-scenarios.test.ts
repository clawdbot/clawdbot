import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/check-gateway-cpu-scenarios.mjs";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const artifactRoot = path.join(process.cwd(), ".artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(path.join(artifactRoot, "gateway-cpu-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("gateway CPU scenario guard", () => {
  it("prepares CLI startup artifacts before running the startup bench", async () => {
    const outputDir = makeTempRoot();
    const calls: Array<{ command: string; args: string[] }> = [];
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--runs",
      "1",
      "--warmup",
      "0",
      "--skip-qa",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      silent: true,
      spawnSync: (command: string, args: string[]) => {
        calls.push({ command, args });
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.args[0])).toEqual([
      "scripts/ensure-cli-startup-build.mjs",
      "--import",
    ]);
    expect(calls[1]?.args).toContain("scripts/bench-gateway-startup.ts");
  });

  it("does not run the startup bench when the startup build fails", async () => {
    const outputDir = makeTempRoot();
    const calls: string[][] = [];
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--skip-qa",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      silent: true,
      spawnSync: (_command: string, args: string[]) => {
        calls.push(args);
        return { status: 1 };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(calls).toEqual([["scripts/ensure-cli-startup-build.mjs"]]);
    expect(result.summary.steps).toEqual([
      { name: "startup build", signal: null, status: 1 },
      { name: "startup bench", signal: null, status: 1 },
    ]);
  });
});
