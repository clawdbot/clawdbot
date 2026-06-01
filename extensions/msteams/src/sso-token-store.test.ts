import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsSsoTokenStoreFs } from "./sso-token-store.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

describe("msteams sso token store (plugin state)", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps distinct tokens when connectionName and userId contain the legacy delimiter", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-sso-"));
    const storePath = path.join(stateDir, "msteams-sso-tokens.json");
    const store = createMSTeamsSsoTokenStoreFs({ storePath });

    const first = {
      connectionName: "conn::alpha",
      userId: "user",
      token: "token-a",
      updatedAt: "2026-04-10T00:00:00.000Z",
    } as const;
    const second = {
      connectionName: "conn",
      userId: "alpha::user",
      token: "token-b",
      updatedAt: "2026-04-10T00:00:01.000Z",
    } as const;

    await store.save(first);
    await store.save(second);

    expect(await store.get(first)).toEqual(first);
    expect(await store.get(second)).toEqual(second);

    await expect(fs.access(storePath)).rejects.toThrow();
    await expect(
      fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
    ).resolves.toBeUndefined();
  });

  it("loads legacy flat-key files by rebuilding keys from stored token payloads", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-sso-legacy-"));
    const storePath = path.join(stateDir, "msteams-sso-tokens.json");
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: 1,
          tokens: {
            "legacy::wrong-key": {
              connectionName: "conn",
              userId: "user-1",
              token: "token-1",
              updatedAt: "2026-04-10T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const store = createMSTeamsSsoTokenStoreFs({ storePath });
    expect(
      await store.get({
        connectionName: "conn",
        userId: "user-1",
      }),
    ).toEqual({
      connectionName: "conn",
      userId: "user-1",
      token: "token-1",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });
    await expect(fs.access(storePath)).rejects.toThrow();
  });

  it("keeps plugin-state keys bounded for long Teams identifiers", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-sso-long-"));
    const store = createMSTeamsSsoTokenStoreFs({ stateDir });
    const token = {
      connectionName: `conn-${"c".repeat(1000)}`,
      userId: `user-${"u".repeat(2000)}`,
      token: "token-long",
      updatedAt: "2026-04-10T00:00:00.000Z",
    } as const;

    await store.save(token);
    expect(await store.get(token)).toEqual(token);
    expect(await store.remove(token)).toBe(true);
    expect(await store.get(token)).toBeNull();
  });

  it("imports a legacy token file that appears after an empty migration marker", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-sso-late-"));
    const storePath = path.join(stateDir, "msteams-sso-tokens.json");
    const store = createMSTeamsSsoTokenStoreFs({ storePath });

    expect(await store.get({ connectionName: "conn", userId: "user-late" })).toBeNull();
    await fs.writeFile(
      storePath,
      `${JSON.stringify({
        version: 1,
        tokens: {
          late: {
            connectionName: "conn",
            userId: "user-late",
            token: "token-late",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        },
      })}\n`,
      "utf8",
    );

    expect(await store.get({ connectionName: "conn", userId: "user-late" })).toEqual({
      connectionName: "conn",
      userId: "user-late",
      token: "token-late",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });
    await expect(fs.access(storePath)).rejects.toThrow();
  });

  it("does not resurrect removed tokens when a migrated legacy file cannot be deleted", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-sso-stale-"));
    const storePath = path.join(stateDir, "msteams-sso-tokens.json");
    await fs.writeFile(
      storePath,
      `${JSON.stringify({
        version: 1,
        tokens: {
          stale: {
            connectionName: "conn",
            userId: "user-stale",
            token: "token-stale",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        },
      })}\n`,
      "utf8",
    );
    const originalRm = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === storePath) {
        throw new Error("cannot remove");
      }
      return await originalRm(target, options);
    });

    const store = createMSTeamsSsoTokenStoreFs({ storePath });
    expect(await store.get({ connectionName: "conn", userId: "user-stale" })).toEqual({
      connectionName: "conn",
      userId: "user-stale",
      token: "token-stale",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });
    expect(await store.remove({ connectionName: "conn", userId: "user-stale" })).toBe(true);
    expect(await store.get({ connectionName: "conn", userId: "user-stale" })).toBeNull();
  });
});
