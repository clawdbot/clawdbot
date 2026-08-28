import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WRAPPER = path.resolve("scripts/mantis/mantis-sut-container.sh");
const HARNESS = path.resolve("test/fixtures/mantis-lifecycle-claim-harness.sh");
const GATEWAY_A = "a".repeat(64);
const GATEWAY_B = "b".repeat(64);
const tempRoots: string[] = [];

function readCalls(file: string): string[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function runHarness(
  mode: "crash" | "graceful",
  claimLoss: "after" | "before" | "none" | "success" | "zombie",
) {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-claim-fence-test-"));
  tempRoots.push(outputRoot);
  const result = spawnSync("/bin/bash", [HARNESS, WRAPPER, mode, claimLoss, outputRoot], {
    encoding: "utf8",
  });
  return {
    controllerCalls: readCalls(path.join(outputRoot, "controller-calls.log")),
    dockerCalls: readCalls(path.join(outputRoot, "docker-calls.log")),
    ownerReaped: readCalls(path.join(outputRoot, "claim-owner-reaped")),
    ownerStates: readCalls(path.join(outputRoot, "zombie-state")),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform !== "linux")("Mantis lifecycle claim fencing", () => {
  it.each(["graceful", "crash"] as const)(
    "rejects %s claim loss before any Docker lifecycle call",
    (mode) => {
      const result = runHarness(mode, "before");

      expect(result.status).toBe(64);
      expect(result.stderr).toContain("runtime claim owner is not active");
      expect(result.stderr).toContain(
        "runtime claim authority was lost before the Docker lifecycle action",
      );
      expect(result.stderr).not.toContain("Permission denied");
      expect(result.dockerCalls).toEqual([]);
      expect(result.ownerStates).toEqual([]);
      expect(result.ownerReaped).toHaveLength(1);
      expect(result.controllerCalls.some((call) => call.startsWith("request-failed "))).toBe(true);
    },
  );

  it.each(["graceful", "crash"] as const)(
    "rejects %s when an unreaped claim owner is a zombie",
    (mode) => {
      const result = runHarness(mode, "zombie");

      expect(result.status).toBe(64);
      expect(result.stderr).toContain("runtime claim owner is not active");
      expect(result.stderr).toContain(
        "runtime claim authority was lost before the Docker lifecycle action",
      );
      expect(result.stderr).not.toContain("Permission denied");
      expect(result.dockerCalls).toEqual([]);
      expect(result.ownerStates).toEqual(["Z"]);
      expect(result.ownerReaped).toHaveLength(1);
      expect(result.controllerCalls.some((call) => call.startsWith("request-failed "))).toBe(true);
    },
  );

  it.each(["graceful", "crash"] as const)(
    "rejects %s success when the exact claim is lost during Docker control",
    (mode) => {
      const result = runHarness(mode, "after");

      expect(result.status).toBe(64);
      expect(result.stderr).toContain(
        "runtime claim authority was lost after the Docker lifecycle action",
      );
      expect(result.dockerCalls).toEqual([
        mode === "graceful" ? `stop --time 10 ${GATEWAY_A}` : `kill --signal KILL ${GATEWAY_A}`,
      ]);
      expect(result.controllerCalls.some((call) => call.startsWith("request-failed "))).toBe(false);
    },
  );

  it.each(["graceful", "crash"] as const)(
    "rejects %s success when the claim is lost during successor validation",
    (mode) => {
      const result = runHarness(mode, "success");

      expect(result.status).toBe(64);
      expect(result.stderr).toContain("runtime claim identity changed");
      expect(result.stderr).toContain("runtime claim authority was lost");
      expect(result.stdout).toBe("");
      expect(result.dockerCalls).toEqual([
        mode === "graceful" ? `stop --time 10 ${GATEWAY_A}` : `kill --signal KILL ${GATEWAY_A}`,
      ]);
      expect(result.controllerCalls.some((call) => call.startsWith("request-failed "))).toBe(false);
    },
  );

  it.each(["graceful", "crash"] as const)(
    "carries the exact live claim through successful %s recovery evidence",
    (mode) => {
      const result = runHarness(mode, "none");

      expect(result.status, result.stderr).toBe(0);
      expect(result.dockerCalls).toEqual([
        mode === "graceful" ? `stop --time 10 ${GATEWAY_A}` : `kill --signal KILL ${GATEWAY_A}`,
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        containerId: GATEWAY_B,
        generation: 2,
        phase: "ready",
      });
      expect(result.controllerCalls.filter((call) => call.startsWith("request "))).toHaveLength(1);
      expect(result.controllerCalls.filter((call) => call.startsWith("status "))).toHaveLength(3);
    },
  );
});
