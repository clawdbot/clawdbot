import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertQaGatewayCredentialLeaseQuarantine,
  createQaGatewayProcessBoundaryController,
  shouldRetainQaGatewayCredentialLease,
} from "./gateway-process-boundary.js";

const MIN_QUARANTINE_TTL_MS = 2 * 60 * 60 * 1_000;
const RETAIN_LEASE_PREFIX = "retain-credential-lease-";
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((pathName) => fs.rm(pathName, { recursive: true, force: true })),
  );
});

describe("gateway process boundary", () => {
  it.runIf(process.platform === "linux")(
    "validates handoff, sandbox, and runtime proof through controller acceptance",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-process-boundary-accept-"));
      cleanupPaths.push(root);
      const tempRoot = path.join(root, "runtime");
      const evidenceDir = path.join(root, "evidence");
      const launcherPath = path.join(root, "launcher.sh");
      await fs.mkdir(tempRoot);
      await fs.mkdir(evidenceDir);
      await fs.writeFile(launcherPath, '#!/bin/sh\ncat "$3.runtime"\n', { mode: 0o755 });
      const controller = await createQaGatewayProcessBoundaryController({
        config: {
          kind: "linux-proc-v1",
          evidenceDir,
          expectedGid: process.getgid?.() ?? 1002,
          expectedUid: process.getuid?.() ?? 1001,
          forwardedEnvKeys: ["PATH", "HOME", "PATH"],
          runtimeArgsPrefix: ["--import", "/tmp/preload.mjs"],
          runtimeExecutablePath: process.execPath,
          terminationRetryTimeoutMs: 60_000,
        },
        launcherPath,
        tempRoot,
      });
      const prepared = await controller.prepare({
        args: ["gateway", "run"],
        cwd: tempRoot,
        env: { HOME: path.join(tempRoot, "home"), PATH: process.env.PATH },
      });
      const launcherPid = 4242;
      const runtimePid = 4243;
      const uid = process.getuid?.() ?? 1001;
      const gid = process.getgid?.() ?? 1002;
      const handoff = {
        version: 1,
        generation: prepared.generation,
        pid: runtimePid,
        uid,
        gid,
        procStartTicks: "123",
        pgrp: launcherPid,
        commandFile: {
          path: prepared.commandFilePath,
          sha256: prepared.commandSha256,
        },
      };
      await fs.writeFile(prepared.identityFilePath, `${JSON.stringify(handoff)}\n`, {
        mode: 0o640,
      });
      await fs.writeFile(
        prepared.sandboxFilePath,
        `${JSON.stringify({
          version: 1,
          generation: prepared.generation,
          status: "pass",
          envKeys: ["PATH", "HOME", "PATH", "OPENCLAW_QA_SUT_PREENTRY_STOP"],
        })}\n`,
        { mode: 0o640 },
      );
      const cmdlineSha256 = createHash("sha256")
        .update(
          Buffer.from(`${[prepared.command.executable, ...prepared.command.argv].join("\0")}\0`),
        )
        .digest("hex");
      await fs.writeFile(
        `${prepared.identityFilePath}.runtime`,
        `${JSON.stringify({
          version: 1,
          generation: prepared.generation,
          status: "pass",
          pid: runtimePid,
          uid,
          gid,
          procStartTicks: "123",
          pgrp: launcherPid,
          state: "T",
          cwd: await fs.realpath(tempRoot),
          executablePath: await fs.realpath(process.execPath),
          cmdlineSha256,
        })}\n`,
      );

      const identity = await controller.accept({
        child: { pid: launcherPid, exitCode: null, signalCode: null } as never,
        prepared,
      });

      expect(identity).toMatchObject({
        generation: prepared.generation,
        pid: runtimePid,
        pgrp: launcherPid,
        preEntryCmdlineSha256: cmdlineSha256,
      });
      const evidence = JSON.parse(await fs.readFile(controller.evidencePath, "utf8")) as {
        launches: Array<{ generation: string; sandboxFile: string }>;
      };
      expect(evidence.launches).toEqual([
        expect.objectContaining({ generation: prepared.generation }),
      ]);

      const malformed = await controller.prepare({
        args: ["gateway", "run"],
        cwd: tempRoot,
        env: { HOME: path.join(tempRoot, "home"), PATH: process.env.PATH },
      });
      await fs.writeFile(
        malformed.identityFilePath,
        `${JSON.stringify({ ...handoff, generation: malformed.generation, pid: 1 })}\n`,
        { mode: 0o640 },
      );
      await fs.writeFile(
        malformed.sandboxFilePath,
        `${JSON.stringify({
          version: 1,
          generation: malformed.generation,
          status: "pass",
          envKeys: malformed.command.envKeys,
        })}\n`,
        { mode: 0o640 },
      );
      await expect(
        controller.accept({
          child: { pid: launcherPid, exitCode: null, signalCode: null } as never,
          prepared: malformed,
        }),
      ).rejects.toThrow("invalid process-boundary pid");
    },
  );

  it("retains a credential lease only for a regular boundary marker", async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-process-boundary-marker-"));
    cleanupPaths.push(evidenceDir);
    const env = {
      OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR: evidenceDir,
    };
    const markerPath = path.join(evidenceDir, `${RETAIN_LEASE_PREFIX}controller.json`);

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
          leaseTtlMs: MIN_QUARANTINE_TTL_MS - 1,
        },
        env,
      ),
    ).toThrow("requires a credential lease TTL");
    expect(() =>
      assertQaGatewayCredentialLeaseQuarantine(
        {
          source: "convex",
          leaseTtlMs: MIN_QUARANTINE_TTL_MS,
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
