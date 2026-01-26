import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";

async function makeEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gateway-lock-"));
  const configPath = path.join(dir, "clawdbot.json");
  await fs.writeFile(configPath, "{}", "utf8");
  await fs.mkdir(resolveGatewayLockDir(), { recursive: true });
  return {
    env: {
      ...process.env,
      CLAWDBOT_STATE_DIR: dir,
      CLAWDBOT_CONFIG_PATH: configPath,
    },
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha1").update(configPath).digest("hex").slice(0, 8);
  const lockDir = resolveGatewayLockDir();
  return { lockPath: path.join(lockDir, `gateway.${hash}.lock`), configPath };
}

function makeProcStat(pid: number, startTime: number) {
  const fields = [
    "R",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    String(startTime),
    "1",
    "1",
  ];
  return `${pid} (node) ${fields.join(" ")}`;
}

describe("gateway lock", () => {
  it("blocks concurrent acquisition until release", async () => {
    const { env, cleanup } = await makeEnv();
    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 200,
      pollIntervalMs: 20,
    });
    expect(lock).not.toBeNull();

    await expect(
      acquireGatewayLock({
        env,
        allowInTests: true,
        timeoutMs: 200,
        pollIntervalMs: 20,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    await lock?.release();
    const lock2 = await acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 200,
      pollIntervalMs: 20,
    });
    await lock2?.release();
    await cleanup();
  });

  it("treats recycled linux pid as stale when start time mismatches", async () => {
    const { env, cleanup } = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const payload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath,
      startTime: 111,
    };
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    const readFileSync = fsSync.readFileSync;
    const statValue = makeProcStat(process.pid, 222);
    const spy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === `/proc/${process.pid}/stat`) {
        return statValue;
      }
      return readFileSync(filePath as never, encoding as never) as never;
    });

    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 200,
      pollIntervalMs: 20,
      platform: "linux",
    });
    expect(lock).not.toBeNull();

    await lock?.release();
    spy.mockRestore();
    await cleanup();
  });

  it("keeps lock on linux when proc access fails unless stale", async () => {
    const { env, cleanup } = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const payload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath,
      startTime: 111,
    };
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    const readFileSync = fsSync.readFileSync;
    const spy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === `/proc/${process.pid}/stat`) {
        throw new Error("EACCES");
      }
      return readFileSync(filePath as never, encoding as never) as never;
    });

    await expect(
      acquireGatewayLock({
        env,
        allowInTests: true,
        timeoutMs: 120,
        pollIntervalMs: 20,
        staleMs: 10_000,
        platform: "linux",
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    spy.mockRestore();

    const stalePayload = {
      ...payload,
      createdAt: new Date(0).toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(stalePayload), "utf8");

    const staleSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === `/proc/${process.pid}/stat`) {
        throw new Error("EACCES");
      }
      return readFileSync(filePath as never, encoding as never) as never;
    });

    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 200,
      pollIntervalMs: 20,
      staleMs: 1,
      platform: "linux",
    });
    expect(lock).not.toBeNull();

    await lock?.release();
    staleSpy.mockRestore();
    await cleanup();
  });
});
