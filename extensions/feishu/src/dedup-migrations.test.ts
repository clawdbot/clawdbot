import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectFeishuLegacyStateMigrations } from "./dedup-migrations.js";

const tempDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-dedup-migration-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Feishu dedupe migration", () => {
  it("plans recent legacy dedupe rows with remaining TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const stateDir = await makeStateDir();
    const sourcePath = path.join(stateDir, "feishu", "dedup", "account-a.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        fresh: 1_000,
        expired: 2_000 - 24 * 60 * 60 * 1000,
        malformed: "nope",
      }),
    );

    const plans = await Promise.resolve(
      detectFeishuLegacyStateMigrations({
        cfg: {},
        env: {},
        oauthDir: path.join(stateDir, "credentials"),
        stateDir,
      }),
    );

    if (!plans) {
      throw new Error("expected migration plans");
    }
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan?.kind).toBe("plugin-state-import");
    if (plan?.kind !== "plugin-state-import") {
      throw new Error("expected plugin-state import plan");
    }
    expect(plan.pluginId).toBe("feishu");
    expect(plan.namespace).toBe("dedup.account-a");
    const entries = await plan.readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toMatch(/^[0-9a-f]{32}$/u);
    expect(entries[0]?.value).toEqual({
      namespace: "account-a",
      messageId: "fresh",
      seenAt: 1_000,
    });
    expect(entries[0]?.ttlMs).toBe(24 * 60 * 60 * 1000 - 1_000);
  });

  it("skips expired-only legacy dedupe files", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const stateDir = await makeStateDir();
    const sourcePath = path.join(stateDir, "feishu", "dedup", "account-a.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        expired: 2_000 - 24 * 60 * 60 * 1000,
      }),
    );

    expect(
      detectFeishuLegacyStateMigrations({
        cfg: {},
        env: {},
        oauthDir: path.join(stateDir, "credentials"),
        stateDir,
      }),
    ).toStrictEqual([]);
  });
});
