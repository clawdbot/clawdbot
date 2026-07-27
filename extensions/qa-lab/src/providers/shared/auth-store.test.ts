// Qa Lab tests cover the SQLite-backed auth store plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { readQaAuthProfiles, writeQaAuthProfiles } from "./auth-store.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-auth-store-"));
  tempDirs.push(dir);
  return dir;
}

describe("QA auth profile store", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes new auth profiles to SQLite without creating legacy JSON", async () => {
    const agentDir = await createTempDir();

    await writeQaAuthProfiles({
      agentDir,
      profiles: {
        "qa-mock-openai": {
          type: "api_key",
          provider: "openai",
          key: "qa-mock-not-a-real-key",
        },
      },
    });

    expect(readQaAuthProfiles(agentDir).profiles["qa-mock-openai"]).toMatchObject({
      provider: "openai",
    });
    await expect(fs.stat(path.join(agentDir, "auth-profiles.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to bypass a pending legacy auth source", async () => {
    const agentDir = await createTempDir();
    const authPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(authPath, "{not-json", "utf8");

    await expect(
      writeQaAuthProfiles({
        agentDir,
        profiles: {
          "qa-mock-openai": {
            type: "api_key",
            provider: "openai",
            key: "qa-mock-not-a-real-key",
          },
        },
      }),
    ).rejects.toThrow("requires legacy credential migration");
    await expect(fs.readFile(authPath, "utf8")).resolves.toBe("{not-json");
  });

  it("merges canonical API-key, token, and OAuth profile shapes", async () => {
    const agentDir = await createTempDir();
    await writeQaAuthProfiles({
      agentDir,
      profiles: {
        existing: {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        tokenProfile: {
          type: "token",
          provider: "github",
          tokenRef: { source: "file", provider: "vault", id: "github/token" },
        },
        oauthProfile: {
          type: "oauth",
          provider: "chatgpt",
          access: "qa-access-token",
          refresh: "qa-refresh-token",
          expires: 1_900_000_000_000,
        },
      },
    });

    await writeQaAuthProfiles({
      agentDir,
      profiles: {
        "qa-mock-anthropic": {
          type: "api_key",
          provider: "anthropic",
          key: "qa-mock-not-a-real-key",
        },
      },
    });

    expect(readQaAuthProfiles(agentDir).profiles).toMatchObject({
      existing: { type: "api_key", provider: "openai" },
      tokenProfile: { type: "token", provider: "github" },
      oauthProfile: { type: "oauth", provider: "chatgpt" },
      "qa-mock-anthropic": { type: "api_key", provider: "anthropic" },
    });
  });

  it("can replace an existing profile set for deterministic fixture seeding", async () => {
    const agentDir = await createTempDir();
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          stale: { type: "api_key", provider: "openai", key: "qa-stale-not-a-real-key" },
        },
        order: { openai: ["stale"] },
        lastGood: { openai: "stale" },
        usageStats: { stale: { cooldownUntil: Date.now() + 60_000 } },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );

    await writeQaAuthProfiles({
      agentDir,
      profiles: {
        current: { type: "api_key", provider: "anthropic", key: "qa-current-not-a-real-key" },
      },
      replace: true,
    });

    expect(Object.keys(readQaAuthProfiles(agentDir).profiles)).toEqual(["current"]);
    const replaced = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
      inheritedAuthDir: agentDir,
    });
    expect(replaced.order).toBeUndefined();
    expect(replaced.lastGood).toBeUndefined();
    expect(replaced.usageStats).toBeUndefined();
  });
});
