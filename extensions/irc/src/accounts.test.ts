// Irc tests cover accounts plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listIrcAccountIds, resolveDefaultIrcAccountId, resolveIrcAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

function asConfig(value: unknown): CoreConfig {
  return value as CoreConfig;
}

describe("listIrcAccountIds", () => {
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

  it("keeps the implicit default account when named accounts are added to top-level connection config", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "claw",
          accounts: {
            work: {
              enabled: false,
              host: "irc-work.example.com",
              nick: "claw-work",
            },
          },
        },
      },
    });

    expect(listIrcAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultIrcAccountId(cfg)).toBe("default");
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
});

describe("resolveIrcAccount", () => {
  let fixtureDirectory: string;
  let fixturePasswordFile: string;

  beforeAll(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-irc-password-"));
    fixturePasswordFile = path.join(fixtureDirectory, "password.txt");
    fs.writeFileSync(fixturePasswordFile, "file\n", "utf8");
  });

  afterAll(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());

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
  });

  it.each([
    { accountId: "default", credential: "password" },
    { accountId: "work", credential: "password" },
    { accountId: "default", credential: "nickserv" },
    { accountId: "work", credential: "nickserv" },
    { accountId: "default", credential: "nickserv", enabled: false },
  ])(
    "isolates an unavailable $credential SecretRef for $accountId only when enabled=$enabled",
    ({ accountId, credential, enabled }) => {
      vi.stubEnv("IRC_PASSWORD", "ambient-server-secret");
      vi.stubEnv("IRC_NICKSERV_PASSWORD", "ambient-nickserv-secret");

      const ref = { source: "env", provider: "default", id: "IRC_UNAVAILABLE_EXPLICIT_SECRET" };
      const account = resolveIrcAccount({
        cfg: asConfig({
          channels: {
            irc: {
              accounts: {
                [accountId]: {
                  host: "irc.example.com",
                  nick: "openclaw",
                  ...(credential === "password"
                    ? { password: ref, passwordFile: fixturePasswordFile }
                    : { nickserv: { enabled, password: ref, passwordFile: fixturePasswordFile } }),
                },
              },
            },
          },
        }),
        accountId,
      });

      expect(account.configured).toBe(true);
      expect(account.tokenStatus).toBe(enabled === false ? "available" : "configured_unavailable");
      if (credential === "password") {
        expect(account.password).toBe("");
        expect(account.passwordSource).toBe("config");
      } else {
        expect(account.config.nickserv?.password).toBeUndefined();
      }
    },
  );

  it.each<[string, string, string, string, boolean, string, boolean?]>([
    ["password", "default", "plain", "env", true, "env"],
    ["password", "default", "plain", "", true, "file"],
    ["password", "work", "plain", "env", true, "file"],
    ["password", "work", "plain", "env", false, "plain"],
    ["nickserv", "default", "plain", "env", true, "plain"],
    ["nickserv", "default", "", "env", true, "env"],
    ["nickserv", "default", "", "", true, "file"],
    ["nickserv", "work", "plain", "env", true, "plain"],
    ["nickserv", "work", "", "env", true, "file"],
    ["nickserv", "default", "plain", "env", true, "plain", false],
  ])(
    "preserves %s precedence for %s (plaintext=%s, env=%s, file=%s => %s)",
    (credential, accountId, plaintext, env, file, expected, enabled) => {
      vi.stubEnv(credential === "password" ? "IRC_PASSWORD" : "IRC_NICKSERV_PASSWORD", env);

      const credentialConfig = {
        password: plaintext,
        ...(file ? { passwordFile: fixturePasswordFile } : {}),
      };
      const account = resolveIrcAccount({
        cfg: asConfig({
          channels: {
            irc: {
              accounts: {
                [accountId]: {
                  host: "irc.example.com",
                  nick: "openclaw",
                  ...(credential === "password"
                    ? credentialConfig
                    : { nickserv: { ...credentialConfig, ...(enabled === false && { enabled }) } }),
                },
              },
            },
          },
        }),
        accountId,
      });

      expect(credential === "password" ? account.password : account.config.nickserv?.password).toBe(
        expected,
      );
      expect(account.tokenStatus).toBe("available");
    },
  );

  it.runIf(process.platform !== "win32")("isolates symlinked password files", () => {
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
    expect(account.passwordSource).toBe("passwordFile");
    expect(account.tokenStatus).toBe("configured_unavailable");
    expect(account.credentialDiagnostics).toEqual([
      {
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: "channels.irc.accounts.default.passwordFile",
        reason: "symlink",
      },
    ]);
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(passwordLink);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")("isolates symlinked NickServ password files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-irc-nickserv-"));
    const passwordFile = path.join(dir, "nickserv-password.txt");
    const passwordLink = path.join(dir, "nickserv-password-link.txt");
    fs.writeFileSync(passwordFile, "nickserv-pass\n", "utf8");
    fs.symlinkSync(passwordFile, passwordLink);

    const cfg = asConfig({
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "claw",
          nickserv: {
            passwordFile: passwordLink,
          },
        },
      },
    });

    const account = resolveIrcAccount({ cfg });
    expect(account.config.nickserv?.password).toBeUndefined();
    expect(account.tokenStatus).toBe("configured_unavailable");
    expect(account.credentialDiagnostics).toEqual([
      {
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: "channels.irc.accounts.default.nickserv.passwordFile",
        reason: "symlink",
      },
    ]);
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(passwordLink);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not fall through from a missing explicit password file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-irc-missing-"));
    const passwordFile = path.join(dir, "missing-password.txt");
    const account = resolveIrcAccount({
      cfg: asConfig({
        channels: {
          irc: {
            accounts: {
              work: {
                host: "irc.example.com",
                nick: "claw",
                password: "test-password",
                passwordFile,
              },
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(account.password).toBe("");
    expect(account.passwordSource).toBe("passwordFile");
    expect(account.tokenStatus).toBe("configured_unavailable");
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(passwordFile);
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
