import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WRAPPER = path.resolve("scripts/mantis/mantis-sut-container.sh");
const HARNESS = path.resolve("test/fixtures/mantis-lifecycle-port-harness.sh");
const GATEWAY_A = "a".repeat(64);
const GATEWAY_B = "b".repeat(64);
const tempRoots: string[] = [];

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function runHarness(portCase: string) {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-port-contract-test-"));
  tempRoots.push(outputRoot);
  const result = spawnSync("/bin/bash", [HARNESS, WRAPPER, portCase, outputRoot], {
    encoding: "utf8",
  });
  return {
    cleanupComplete: fs.existsSync(path.join(outputRoot, "cleanup-complete")),
    controllerCalls: readLines(path.join(outputRoot, "controller-calls.log")),
    dockerCalls: readLines(path.join(outputRoot, "docker-calls.log")),
    portMetadata: readLines(path.join(outputRoot, "port-metadata")),
    precreatedPreserved: fs.existsSync(path.join(outputRoot, "precreated-preserved")),
    runtimeMetadata: readLines(path.join(outputRoot, "runtime-metadata")),
    safeRuntimeExists: fs.existsSync(path.join(outputRoot, "safe-runtime")),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    tempResidue: readLines(path.join(outputRoot, "temp-residue")),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform !== "linux")("Mantis lifecycle gateway port contract", () => {
  it.each([
    ["valid", 18_789],
    ["valid-low", 1],
    ["valid-high", 65_535],
  ] as const)("publishes and consumes the root-owned %s port", (portCase, port) => {
    const result = runHarness(portCase);

    expect(result.status, result.stderr).toBe(0);
    expect(result.runtimeMetadata).toEqual(["0 1770"]);
    expect(result.portMetadata).toEqual([`0 400 1 ${String(port).length + 1}`]);
    expect(result.tempResidue).toEqual([]);
    expect(result.dockerCalls).toEqual([
      `exec --env OPENCLAW_MANTIS_GATEWAY_PORT=${port} ${GATEWAY_A} node -e process.exit(0)`,
      `stop --time 10 ${GATEWAY_A}`,
      `exec --env OPENCLAW_MANTIS_GATEWAY_PORT=${port} ${GATEWAY_B} node -e process.exit(0)`,
    ]);
    expect(result.controllerCalls.filter((call) => call.startsWith("request "))).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      containerId: GATEWAY_B,
      generation: 2,
      phase: "ready",
    });
    expect(result.cleanupComplete).toBe(true);
    expect(result.safeRuntimeExists).toBe(false);
  });

  it.each([
    ["missing", "missing or invalid runtime gateway port"],
    ["symlink", "missing or invalid runtime gateway port"],
    ["directory", "missing or invalid runtime gateway port"],
    ["wrong-owner", "runtime gateway port owner mismatch"],
    ["wrong-mode", "runtime gateway port mode mismatch"],
    ["hardlink", "runtime gateway port must not be hard-linked"],
    ["empty", "invalid runtime gateway port contents"],
    ["multiline", "invalid runtime gateway port contents"],
    ["no-lf", "invalid runtime gateway port contents"],
    ["zero", "invalid port"],
    ["overflow", "invalid port"],
    ["too-long", "invalid runtime gateway port contents"],
    ["leading-zero", "invalid non-canonical port"],
  ] as const)("rejects %s before any Docker I/O", (portCase, diagnostic) => {
    const result = runHarness(portCase);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).not.toContain("Permission denied");
    expect(result.stdout).toBe("");
    expect(result.dockerCalls).toEqual([]);
    expect(result.controllerCalls[0]).toMatch(/^status /u);
    expect(result.controllerCalls.some((call) => call.startsWith("request "))).toBe(false);
    expect(result.cleanupComplete).toBe(true);
    expect(result.safeRuntimeExists).toBe(false);
  });

  it.each([
    "producer-precreated-file",
    "producer-precreated-symlink",
    "producer-precreated-directory",
  ] as const)("rejects %s without replacing the target", (portCase) => {
    const result = runHarness(portCase);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("runtime gateway port already exists");
    expect(result.dockerCalls).toEqual([]);
    expect(result.controllerCalls).toEqual([]);
    expect(result.precreatedPreserved).toBe(true);
    expect(result.tempResidue).toEqual([]);
    expect(result.cleanupComplete).toBe(true);
    expect(result.safeRuntimeExists).toBe(false);
  });

  it("removes its atomic temporary file when producer preparation fails", () => {
    const result = runHarness("producer-failure");

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("failed to prepare runtime gateway port");
    expect(result.dockerCalls).toEqual([]);
    expect(result.controllerCalls).toEqual([]);
    expect(result.tempResidue).toEqual([]);
    expect(result.cleanupComplete).toBe(true);
    expect(result.safeRuntimeExists).toBe(false);
  });
});
