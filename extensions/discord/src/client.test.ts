import type { RequestClient } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { createDiscordRestClient } from "./client.js";

describe("createDiscordRestClient", () => {
  const fakeRest = {} as RequestClient;

  it("uses explicit token without resolving config token SecretRefs", () => {
    const cfg = {
      channels: {
        discord: {
          token: {
            source: "exec",
            provider: "vault",
            id: "discord/bot-token",
          },
        },
      },
    } as OpenClawConfig;

    const result = createDiscordRestClient(
      {
        token: "Bot explicit-token",
        rest: fakeRest,
      },
      cfg,
    );

    expect(result.token).toBe("explicit-token");
    expect(result.rest).toBe(fakeRest);
    expect(result.account.accountId).toBe("default");
  });

  it("keeps account retry config when explicit token is provided", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: {
              token: {
                source: "exec",
                provider: "vault",
                id: "discord/ops-token",
              },
              retry: {
                attempts: 7,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = createDiscordRestClient(
      {
        accountId: "ops",
        token: "Bot explicit-account-token",
        rest: fakeRest,
      },
      cfg,
    );

    expect(result.token).toBe("explicit-account-token");
    expect(result.account.accountId).toBe("ops");
    expect(result.account.config.retry).toMatchObject({ attempts: 7 });
  });

  it("still throws when no explicit token is provided and config token is unresolved", () => {
    const cfg = {
      channels: {
        discord: {
          token: {
            source: "file",
            provider: "default",
            id: "/discord/token",
          },
        },
      },
    } as OpenClawConfig;

    expect(() =>
      createDiscordRestClient(
        {
          rest: fakeRest,
        },
        cfg,
      ),
    ).toThrow(/unresolved SecretRef/i);
  });
});
