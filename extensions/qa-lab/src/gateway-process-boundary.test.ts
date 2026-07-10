import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  assertQaGatewayCredentialLeaseQuarantine,
  createQaGatewayProcessBoundaryController,
  parseQaGatewayProcStat,
  QA_GATEWAY_PROCESS_BOUNDARY_MIN_QUARANTINE_TTL_MS,
  QA_GATEWAY_PROCESS_BOUNDARY_RETAIN_LEASE_PREFIX,
  shouldRetainQaGatewayCredentialLease,
} from "./gateway-process-boundary.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((pathName) => fs.rm(pathName, { recursive: true, force: true })),
  );
});

describe("gateway process boundary", () => {
  it("parses process identity when the command name contains closing parentheses", () => {
    const stat = [
      "42 (node worker (qa))",
      "T",
      "11",
      "42",
      "42",
      "0",
      "-1",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "20",
      "0",
      "1",
      "0",
      "987654",
    ].join(" ");

    expect(parseQaGatewayProcStat(stat)).toEqual({
      state: "T",
      pgrp: 42,
      startTicks: "987654",
    });
  });

  it("normalizes sandbox environment keys and rejects malformed handoffs", () => {
    expect(
      __testing.parseQaGatewayProcessSandboxProof({
        version: 1,
        generation: "generation",
        status: "pass",
        envKeys: ["PATH", "HOME", "PATH"],
      }),
    ).toEqual({
      version: 1,
      generation: "generation",
      status: "pass",
      envKeys: ["HOME", "PATH"],
    });
    expect(() =>
      __testing.parseQaGatewayProcessHandoff({
        version: 1,
        generation: "generation",
        pid: 1,
        uid: 1001,
        gid: 1002,
        procStartTicks: "123",
        pgrp: 42,
        commandFile: {
          path: "/tmp/command.json",
          sha256: "a".repeat(64),
        },
      }),
    ).toThrow("invalid process-boundary pid");
    expect(
      __testing.parseQaGatewayProcessRuntimeProof({
        version: 1,
        generation: "generation",
        status: "pass",
        pid: 42,
        uid: 1001,
        gid: 1002,
        procStartTicks: "123",
        pgrp: 42,
        state: "T",
        cwd: "/tmp/runtime/workspace",
        executablePath: "/usr/bin/node",
        cmdlineSha256: "a".repeat(64),
      }),
    ).toEqual({
      version: 1,
      generation: "generation",
      status: "pass",
      pid: 42,
      uid: 1001,
      gid: 1002,
      procStartTicks: "123",
      pgrp: 42,
      state: "T",
      cwd: "/tmp/runtime/workspace",
      executablePath: "/usr/bin/node",
      cmdlineSha256: "a".repeat(64),
    });
  });

  it("retains a credential lease only for a regular boundary marker", async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-process-boundary-marker-"));
    cleanupPaths.push(evidenceDir);
    const env = {
      OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR: evidenceDir,
    };
    const markerPath = path.join(
      evidenceDir,
      `${QA_GATEWAY_PROCESS_BOUNDARY_RETAIN_LEASE_PREFIX}controller.json`,
    );

    await expect(shouldRetainQaGatewayCredentialLease(env)).resolves.toBe(false);
    await fs.writeFile(markerPath, "{}\n", { mode: 0o600 });
    await expect(shouldRetainQaGatewayCredentialLease(env)).resolves.toBe(true);
    await fs.rm(markerPath);
    await fs.symlink(path.join(evidenceDir, "missing"), markerPath);
    await expect(shouldRetainQaGatewayCredentialLease(env)).resolves.toBe(false);
  });

  it("requires a durable Convex lease before isolated execution", () => {
    const env = {
      OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR: "/tmp/process-boundary",
    };
    expect(() =>
      assertQaGatewayCredentialLeaseQuarantine(
        {
          source: "convex",
          leaseTtlMs: QA_GATEWAY_PROCESS_BOUNDARY_MIN_QUARANTINE_TTL_MS - 1,
        },
        env,
      ),
    ).toThrow("requires a credential lease TTL");
    expect(() =>
      assertQaGatewayCredentialLeaseQuarantine(
        {
          source: "convex",
          leaseTtlMs: QA_GATEWAY_PROCESS_BOUNDARY_MIN_QUARANTINE_TTL_MS,
        },
        env,
      ),
    ).not.toThrow();
    expect(() =>
      assertQaGatewayCredentialLeaseQuarantine(
        {
          source: "env",
          leaseTtlMs: 0,
        },
        env,
      ),
    ).not.toThrow();
  });

  it.runIf(process.platform === "linux")(
    "uses a distinct evidence index for each controller",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-process-boundary-"));
      cleanupPaths.push(root);
      const tempRoot = path.join(root, "runtime");
      const evidenceDir = path.join(root, "evidence");
      await fs.mkdir(tempRoot);
      await fs.mkdir(evidenceDir);
      const config = {
        kind: "linux-proc-v1" as const,
        evidenceDir,
        expectedGid: 1002,
        expectedUid: 1001,
        forwardedEnvKeys: ["HOME", "PATH"],
        runtimeArgsPrefix: ["--import", "/tmp/preload.mjs", "/tmp/index.js"],
        runtimeExecutablePath: process.execPath,
        terminationRetryTimeoutMs: 60_000,
      };

      const first = await createQaGatewayProcessBoundaryController({
        config,
        launcherPath: "/tmp/launcher",
        tempRoot,
      });
      const second = await createQaGatewayProcessBoundaryController({
        config,
        launcherPath: "/tmp/launcher",
        tempRoot,
      });

      expect(first.evidencePath).not.toBe(second.evidencePath);
      expect(path.dirname(first.evidencePath)).toBe(evidenceDir);
      expect(path.basename(first.evidencePath)).toMatch(/^runtime-boundary-[a-f0-9-]{36}\.json$/);

      await first.prepare({
        args: ["gateway", "run"],
        cwd: tempRoot,
        env: { HOME: path.join(tempRoot, "home"), PATH: process.env.PATH },
      });
      await second.prepare({
        args: ["gateway", "run"],
        cwd: tempRoot,
        env: { HOME: path.join(tempRoot, "home"), PATH: process.env.PATH },
      });
      expect(first.retainCredentialLeasePath).not.toBe(second.retainCredentialLeasePath);
      await expect(
        shouldRetainQaGatewayCredentialLease({
          OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR: evidenceDir,
        }),
      ).resolves.toBe(true);
      expect((await fs.stat(first.retainCredentialLeasePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(second.retainCredentialLeasePath)).mode & 0o777).toBe(0o600);
    },
  );
});
