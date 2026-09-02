import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = new Set<string>();
const serviceModuleUrl = new URL("./service.ts", import.meta.url).href;

afterEach(() => {
  for (const tempDir of tempDirs) {
    tempDirs.delete(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runServiceStartChild(params: { tempRoot: string; programPath: string }) {
  const script = `
    const { startGatewayService } = await import(${JSON.stringify(serviceModuleUrl)});
    let running = false;
    const service = {
      label: "test service",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      isLoaded: async () => true,
      readCommand: async () => ({
        programArguments: [${JSON.stringify(params.programPath)}, "gateway", "run"],
      }),
      readRuntime: async () => ({ status: running ? "running" : "stopped" }),
      start: async () => {
        running = true;
      },
    };
    const result = await startGatewayService(service, { env: {}, stdout: process.stdout });
    process.stdout.write(JSON.stringify({
      outcome: result.outcome,
      issues: "issues" in result ? result.issues : [],
    }));
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      TEMP: params.tempRoot,
      TMP: params.tempRoot,
      TMPDIR: params.tempRoot,
      VITEST: undefined,
    },
    timeout: 30_000,
  });
}

function expectChildResult(
  result: ReturnType<typeof runServiceStartChild>,
  expected: { outcome: string; issueCode?: string },
) {
  const diagnostics = `${result.stderr}\n${result.stdout}`;
  expect(result.error, diagnostics).toBeUndefined();
  expect(result.status, diagnostics).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    outcome: string;
    issues: Array<{ code: string }>;
  };
  expect(payload.outcome, diagnostics).toBe(expected.outcome);
  if (expected.issueCode) {
    expect(payload.issues, diagnostics).toContainEqual(
      expect.objectContaining({ code: expected.issueCode }),
    );
  }
}

describe("service temporary program paths", () => {
  it("does not treat the filesystem root as a temporary program directory", () => {
    const result = runServiceStartChild({
      tempRoot: path.parse(process.execPath).root,
      programPath: process.execPath,
    });

    expectChildResult(result, { outcome: "started" });
  });

  it.runIf(process.platform === "win32")(
    "detects temporary programs when Windows path casing differs",
    () => {
      const tempRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-daemon-temp-")),
      );
      tempDirs.add(tempRoot);
      const programPath = path.join(tempRoot, "Gateway", "entry.js");
      fs.mkdirSync(path.dirname(programPath), { recursive: true });
      fs.writeFileSync(programPath, "");
      const caseVariant = tempRoot.replace(/[A-Za-z]/g, (char) =>
        char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
      );

      const result = runServiceStartChild({ tempRoot: caseVariant, programPath });

      expectChildResult(result, {
        outcome: "repair-required",
        issueCode: "temporary-program",
      });
    },
  );
});
