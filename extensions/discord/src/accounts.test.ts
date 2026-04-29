import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordActionGate,
  isDiscordAccountEnabledForRuntime,
  listEnabledDiscordAccounts,
  resolveDiscordAccount,
  resolveDiscordAccountDisabledReason,
  resolveDiscordMaxLinesPerMessage,
} from "./accounts.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveDiscordAccount allowFrom precedence", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            defaultAccount: "work",
            accounts: {
              work: { token: "token-work", name: "Work" },
            },
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.token).toBe("token-work");
  });

  it("prefers accounts.default.allowFrom over top-level for default account", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            allowFrom: ["top"],
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
  });

  it("falls back to top-level allowFrom for named account without override", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            allowFrom: ["top"],
            accounts: {
              work: { token: "token-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
              work: { token: "token-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });
});

describe("createDiscordActionGate", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const gate = createDiscordActionGate({
      cfg: {
        channels: {
          discord: {
            actions: { reactions: false },
            defaultAccount: "work",
            accounts: {
              work: {
                token: "token-work",
                actions: { reactions: true },
              },
            },
          },
        },
      },
    });

    expect(gate("reactions")).toBe(true);
  });
});

describe("resolveDiscordMaxLinesPerMessage", () => {
  it("falls back to merged root discord maxLinesPerMessage when runtime config omits it", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 120,
            accounts: {
              default: { token: "token-default" },
            },
          },
        },
      },
      discordConfig: {},
      accountId: "default",
    });

    expect(resolved).toBe(120);
  });

  it("prefers explicit runtime discord maxLinesPerMessage over merged config", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 120,
            accounts: {
              default: { token: "token-default", maxLinesPerMessage: 80 },
            },
          },
        },
      },
      discordConfig: { maxLinesPerMessage: 55 },
      accountId: "default",
    });

    expect(resolved).toBe(55);
  });

  it("uses per-account discord maxLinesPerMessage over the root value when runtime config omits it", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 120,
            accounts: {
              work: { token: "token-work", maxLinesPerMessage: 80 },
            },
          },
        },
      },
      discordConfig: {},
      accountId: "work",
    });

    expect(resolved).toBe(80);
  });
});

describe("Discord duplicate-token account filtering", () => {
  it("keeps the config-token account over default env fallback when tokens collide", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "same-token");
    const cfg = {
      channels: {
        discord: {
          accounts: {
            work: {
              token: "same-token",
            },
          },
        },
      },
    };

    const defaultAccount = resolveDiscordAccount({ cfg, accountId: "default" });
    const workAccount = resolveDiscordAccount({ cfg, accountId: "work" });

    expect(isDiscordAccountEnabledForRuntime(defaultAccount, cfg)).toBe(false);
    expect(resolveDiscordAccountDisabledReason(defaultAccount, cfg)).toBe(
      'duplicate bot token; using account "work"',
    );
    expect(isDiscordAccountEnabledForRuntime(workAccount, cfg)).toBe(true);
    expect(listEnabledDiscordAccounts(cfg).map((account) => account.accountId)).toEqual(["work"]);
  });

  it("keeps the first enabled account when duplicate tokens have the same source", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            first: {
              token: "same-token",
            },
            second: {
              token: "same-token",
            },
          },
        },
      },
    };

    const firstAccount = resolveDiscordAccount({ cfg, accountId: "first" });
    const secondAccount = resolveDiscordAccount({ cfg, accountId: "second" });

    expect(isDiscordAccountEnabledForRuntime(firstAccount, cfg)).toBe(true);
    expect(isDiscordAccountEnabledForRuntime(secondAccount, cfg)).toBe(false);
    expect(resolveDiscordAccountDisabledReason(secondAccount, cfg)).toBe(
      'duplicate bot token; using account "first"',
    );
    expect(listEnabledDiscordAccounts(cfg).map((account) => account.accountId)).toEqual(["first"]);
  });

  it("does not let disabled duplicate-token accounts suppress enabled accounts", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            disabled: {
              enabled: false,
              token: "same-token",
            },
            active: {
              token: "same-token",
            },
          },
        },
      },
    };

    const activeAccount = resolveDiscordAccount({ cfg, accountId: "active" });

    expect(isDiscordAccountEnabledForRuntime(activeAccount, cfg)).toBe(true);
    expect(listEnabledDiscordAccounts(cfg).map((account) => account.accountId)).toEqual(["active"]);
  });
});
