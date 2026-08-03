// Covers state-scoped Gateway lock roots and the one-way legacy transition.
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

function stateLockPath(lockDir: string, stateDir: string): string {
  const canonicalStateDir = fsSync.realpathSync.native(path.resolve(stateDir));
  const stateHash = createHash("sha256").update(canonicalStateDir).digest("hex").slice(0, 8);
  return path.join(lockDir, `gateway.state.${stateHash}.lock`);
}

describe("Gateway lock state directory", () => {
  it("keeps default locks inside an overridden state directory", async () => {
    await withStateDirEnv("openclaw-gateway-lock-state-", async ({ stateDir }) => {
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(configPath, "{}\n");
      const env = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      };
      const lock = await acquireGatewayLock({ allowInTests: true, env, timeoutMs: 30 });
      if (!lock) {
        throw new Error("Expected Gateway lock");
      }

      try {
        const expectedLockDir = resolveGatewayLockDir(env);
        expect(path.dirname(lock.lockPath)).toBe(expectedLockDir);
        expect(path.dirname(lock.stateLockPath)).toBe(expectedLockDir);
      } finally {
        await lock.release();
      }
    });
  });

  it("does not bypass an active legacy lock during an in-place upgrade", async () => {
    await withStateDirEnv("openclaw-gateway-lock-transition-", async ({ stateDir }) => {
      const configPath = path.join(stateDir, "openclaw.json");
      const legacyLockDir = path.join(stateDir, "legacy-temp");
      await fs.writeFile(configPath, "{}\n");
      await fs.mkdir(legacyLockDir, { recursive: true });
      const env = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      };
      const legacyStateLockPath = stateLockPath(legacyLockDir, stateDir);
      await fs.writeFile(
        legacyStateLockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: resolveConfigPath(env, stateDir),
          startTime: 123,
          stateDir,
        }),
      );

      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          legacyLockDir,
          platform: "darwin",
          readProcessCmdline: () => ["openclaw-gateway"],
          readProcessStartTime: () => 123,
          timeoutMs: 30,
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
      await expect(
        fs.access(stateLockPath(resolveGatewayLockDir(env), stateDir)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
