// Covers the production Gateway lock layout under an overridden state directory.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGatewayLockDir } from "../config/paths.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

type GatewayLock = NonNullable<Awaited<ReturnType<typeof acquireGatewayLock>>>;

function expectGatewayLock(lock: Awaited<ReturnType<typeof acquireGatewayLock>>): GatewayLock {
  if (!lock) {
    throw new Error("Expected gateway lock");
  }
  return lock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gateway lock state directory", () => {
  it("releases in-tree locks separately from Gateway lifecycle ownership", async () => {
    await withTempDir("openclaw-gateway-lock-release-", async (root) => {
      const stateDir = path.join(await fs.realpath(root), "state");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(configPath, "{}", "utf8");
      const lock = expectGatewayLock(
        await acquireGatewayLock({
          allowInTests: true,
          env: {
            ...process.env,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
          },
          timeoutMs: 30,
        }),
      );

      await lock.releaseInTree();
      await expect(fs.access(lock.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(lock.stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await lock.release();
    });
  });

  it("keeps lock, coordinator, and reclaim paths inside the selected state", async () => {
    await withTempDir("openclaw-gateway-lock-state-", async (root) => {
      const canonicalRoot = await fs.realpath(root);
      const stateDir = path.join(canonicalRoot, "selected-state");
      const fakeHome = path.join(canonicalRoot, "home");
      const legacyTmpDir = path.join(canonicalRoot, "legacy-process-tmp");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(legacyTmpDir, { recursive: true });
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(configPath, "{}", "utf8");
      vi.spyOn(os, "tmpdir").mockReturnValue(legacyTmpDir);
      const env = {
        ...process.env,
        HOME: fakeHome,
        OPENCLAW_HOME: fakeHome,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      };

      const lock = expectGatewayLock(
        await acquireGatewayLock({ allowInTests: true, env, timeoutMs: 30 }),
      );
      const lockDir = resolveGatewayLockDir(stateDir);
      const stateLockPath = path.join(lockDir, "gateway.state.lock");
      try {
        expect(lock.stateDir).toBe(stateDir);
        expect(lock.stateLockPath).toBe(stateLockPath);
        expect(path.dirname(lock.lockPath)).toBe(lockDir);
        expect(path.basename(lock.lockPath)).toMatch(/^gateway\.[0-9a-f]{8}\.lock$/u);
        await expect(fs.access(`${lock.lockPath}.sqlite`)).resolves.toBeUndefined();
        await expect(fs.access(`${lock.stateLockPath}.sqlite`)).resolves.toBeUndefined();
      } finally {
        await lock.release();
      }

      const reclaimPath = `${stateLockPath}.reclaim`;
      await fs.mkdir(reclaimPath);
      try {
        await expect(
          acquireGatewayLock({
            allowInTests: true,
            env,
            pollIntervalMs: 2,
            timeoutMs: 10,
          }),
        ).rejects.toBeInstanceOf(GatewayLockError);
        expect(reclaimPath.startsWith(`${stateDir}${path.sep}`)).toBe(true);
      } finally {
        await fs.rmdir(reclaimPath);
      }

      await expect(fs.readdir(legacyTmpDir)).resolves.toEqual([]);
      await expect(fs.access(path.join(fakeHome, ".openclaw"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
