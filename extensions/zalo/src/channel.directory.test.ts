import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { zaloPlugin } from "./channel.js";

describe("zalo directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as RuntimeEnv;
  const directory = expectDirectorySurface(zaloPlugin.directory);

  async function expectPeersFromAllowFrom(allowFrom: string[]) {
    const cfg = {
      channels: {
        zalo: {
          allowFrom,
        },
      },
    } as unknown as OpenClawConfig;

    const peers = await directory.listPeers({
      cfg,
      accountId: undefined,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(peers).toStrictEqual([
      { kind: "user", id: "123" },
      { kind: "user", id: "234" },
      { kind: "user", id: "345" },
    ]);

    await expect(
      directory.listGroups({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toStrictEqual([]);
  }

  it("lists peers from allowFrom", async () => {
    await expectPeersFromAllowFrom(["zalo:123", "zl:234", "345"]);
  });

  it("normalizes spaced zalo prefixes in allowFrom and pairing entries", async () => {
    await expectPeersFromAllowFrom(["  zalo:123  ", "  zl:234  ", " 345 "]);

    expect(zaloPlugin.pairing?.normalizeAllowEntry?.("  zalo:123  ")).toBe("123");
    expect(zaloPlugin.messaging?.normalizeTarget?.("  zl:234  ")).toBe("234");
  });
});
