import { describe, expect, it } from "vitest";
import {
  inspectDiscordSetupAccount,
  listDiscordSetupAccountIds,
  resolveDefaultDiscordSetupAccountId,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";

describe("discord setup account state", () => {
  it("lists normalized setup account ids plus the implicit default account", () => {
    expect(
      listDiscordSetupAccountIds({
        channels: {
          discord: {
            accounts: {
              Work: { token: "work-token" },
              alerts: { token: "alerts-token" },
            },
          },
        },
      }),
    ).toEqual(["alerts", "default", "work"]);
  });

  it("resolves setup account config when account key casing differs from normalized id", () => {
    const resolved = resolveDiscordSetupAccountConfig({
      cfg: {
        channels: {
          discord: {
            allowFrom: ["top"],
            accounts: {
              Work: { name: "Work", allowFrom: ["acct"] },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.config.name).toBe("Work");
    expect(resolved.config.allowFrom).toEqual(["acct"]);
  });

  it("uses configured defaultAccount for omitted setup account resolution", () => {
    const cfg = {
      channels: {
        discord: {
          defaultAccount: "work",
          allowFrom: ["top"],
          accounts: {
            alerts: { allowFrom: ["alerts-only"] },
            work: { name: "Work", allowFrom: ["work-only"] },
          },
        },
      },
    };

    expect(resolveDefaultDiscordSetupAccountId(cfg)).toBe("work");

    const resolved = resolveDiscordSetupAccountConfig({
      cfg,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.config.name).toBe("Work");
    expect(resolved.config.allowFrom).toEqual(["work-only"]);
  });

  it("treats explicit blank account tokens as missing without falling back", () => {
    const inspected = inspectDiscordSetupAccount({
      cfg: {
        channels: {
          discord: {
            token: "top-level-token",
            accounts: {
              work: { token: "" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(inspected.accountId).toBe("work");
    expect(inspected.token).toBe("");
    expect(inspected.tokenSource).toBe("none");
    expect(inspected.tokenStatus).toBe("missing");
    expect(inspected.configured).toBe(false);
  });

  it("reports unresolved SecretRef account tokens as configured but unavailable", () => {
    const inspected = inspectDiscordSetupAccount({
      cfg: {
        channels: {
          discord: {
            accounts: {
              work: {
                token: { source: "exec", provider: "vault", id: "discord/work" },
              },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(inspected.token).toBe("");
    expect(inspected.tokenSource).toBe("config");
    expect(inspected.tokenStatus).toBe("configured_unavailable");
    expect(inspected.configured).toBe(true);
  });
});
