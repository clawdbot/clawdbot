import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

async function makeEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gateway-lock-"));
  const configPath = path.join(dir, "clawdbot.json");
  await fs.writeFile(configPath, "{}", "utf8");
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
});
