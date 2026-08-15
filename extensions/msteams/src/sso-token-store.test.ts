// Msteams tests cover sso token store plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsSsoTokenStoreFs } from "./sso-token-store.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

describe("msteams sso token store (plugin state)", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
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

  it("ignores legacy flat-key token files at runtime", async () => {
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
    ).toBeNull();
    await expect(fs.access(storePath)).resolves.toBeUndefined();
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
});
