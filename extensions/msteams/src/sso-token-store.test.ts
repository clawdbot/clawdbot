import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMSTeamsSsoTokenStoreFs } from "./sso-token-store.js";

describe("msteams sso token store (fs)", () => {
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

    const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      tokens: Record<string, unknown>;
    };
    expect(Object.keys(raw.tokens)).toHaveLength(2);
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
    ).toMatchObject({
      token: "token-1",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });
  });
});
