import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listIrcAccountIds, resolveDefaultIrcAccountId, resolveIrcAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

function asConfig(value: unknown): CoreConfig {
  return value as CoreConfig;
}

describe("listIrcAccountIds", () => {
  it("returns default when no accounts are configured", () => {
    expect(listIrcAccountIds(asConfig({}))).toEqual(["default"]);
  });

  it("normalizes, deduplicates, and sorts configured account ids", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          accounts: {
            "Ops Team": {},
            "ops-team": {},
            Work: {},
          },
        },
      },
    });

    expect(listIrcAccountIds(cfg)).toEqual(["ops-team", "work"]);
  });
});

describe("resolveDefaultIrcAccountId", () => {
  it("prefers configured defaultAccount when it matches", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          defaultAccount: "Ops Team",
          accounts: {
            default: {},
            "ops-team": {},
          },
        },
      },
    });

    expect(resolveDefaultIrcAccountId(cfg)).toBe("ops-team");
  });

  it("falls back to default when configured defaultAccount is missing", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          defaultAccount: "missing",
          accounts: {
            default: {},
            work: {},
          },
        },
      },
    });

    expect(resolveDefaultIrcAccountId(cfg)).toBe("default");
  });

  it("falls back to first sorted account when default is absent", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          accounts: {
            zzz: {},
            aaa: {},
          },
        },
      },
    });

    expect(resolveDefaultIrcAccountId(cfg)).toBe("aaa");
  });
});

describe("resolveIrcAccount", () => {
  it("matches normalized configured account ids", () => {
    const account = resolveIrcAccount({
      cfg: asConfig({
        channels: {
          irc: {
            accounts: {
              "Ops Team": {
                host: "irc.example.com",
                nick: "claw",
              },
            },
          },
        },
      }),
      accountId: "ops-team",
    });

    expect(account.accountId).toBe("ops-team");
    expect(account.host).toBe("irc.example.com");
    expect(account.nick).toBe("claw");
    expect(account.configured).toBe(true);
  });

  it("parses delimited IRC_CHANNELS env values for the default account", () => {
    vi.stubEnv("IRC_CHANNELS", "alpha, beta\ngamma; delta");

    try {
      const account = resolveIrcAccount({
        cfg: asConfig({
          channels: {
            irc: {
              host: "irc.example.com",
              nick: "claw",
            },
          },
        }),
      });

      expect(account.config.channels).toEqual(["alpha", "beta", "gamma", "delta"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.runIf(process.platform !== "win32")("rejects symlinked password files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-irc-account-"));
    const passwordFile = path.join(dir, "password.txt");
    const passwordLink = path.join(dir, "password-link.txt");
    fs.writeFileSync(passwordFile, "secret-pass\n", "utf8");
    fs.symlinkSync(passwordFile, passwordLink);

    const cfg = asConfig({
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "claw",
          passwordFile: passwordLink,
        },
      },
    });

    const account = resolveIrcAccount({ cfg });
    expect(account.password).toBe("");
    expect(account.passwordSource).toBe("none");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves shared NickServ config when an account overrides one NickServ field", () => {
    const account = resolveIrcAccount({
      cfg: asConfig({
        channels: {
          irc: {
            host: "irc.example.com",
            nick: "claw",
            nickserv: {
              service: "NickServ",
            },
            accounts: {
              work: {
                nickserv: {
                  registerEmail: "work@example.com",
                },
              },
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(account.config.nickserv).toEqual({
      service: "NickServ",
      registerEmail: "work@example.com",
    });
  });
});
