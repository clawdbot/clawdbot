import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { isTelegramMiniAppOwner } from "./owner.js";

describe("isTelegramMiniAppOwner", () => {
  it("accepts numeric owners from account allowFrom and commands.ownerAllowFrom", async () => {
    const cfg = {
      commands: { ownerAllowFrom: ["telegram:200"] },
      channels: {
        telegram: {
          allowFrom: ["100"],
          accounts: {
            ops: { allowFrom: ["300"] },
          },
        },
      },
    } satisfies OpenClawConfig;

    await expect(
      isTelegramMiniAppOwner({ cfg, accountId: "default", userId: "100" }),
    ).resolves.toBe(true);
    await expect(isTelegramMiniAppOwner({ cfg, accountId: "ops", userId: "300" })).resolves.toBe(
      true,
    );
    await expect(isTelegramMiniAppOwner({ cfg, accountId: "ops", userId: "200" })).resolves.toBe(
      true,
    );
  });

  it("rejects non-numeric and wildcard owners", async () => {
    const cfg = {
      commands: { ownerAllowFrom: ["*", "telegram:owner"] },
      channels: { telegram: { allowFrom: ["*"] } },
    } satisfies OpenClawConfig;

    await expect(
      isTelegramMiniAppOwner({ cfg, accountId: "default", userId: "100" }),
    ).resolves.toBe(false);
    await expect(
      isTelegramMiniAppOwner({ cfg, accountId: "default", userId: "-100" }),
    ).resolves.toBe(false);
  });
});
