import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramToken } from "./token.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";

describe("resolveTelegramToken", () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-token-"));
    tempDirs.push(dir);
    return dir;
  }

  function createTokenFile(fileName: string, contents = "file-token\n"): string {
    const dir = createTempDir();
    const tokenFile = path.join(dir, fileName);
    fs.writeFileSync(tokenFile, contents, "utf-8");
    return tokenFile;
  }

  function createUnknownAccountConfig(): OpenClawConfig {
    return {
      channels: {
        telegram: {
          botToken: "wrong-bot-token",
          accounts: {
            knownBot: { botToken: "known-bot-token" },
          },
        },
      },
    } as OpenClawConfig;
  }

  function expectNoTokenForUnknownAccount(cfg: OpenClawConfig) {
    const res = resolveTelegramToken(cfg, { accountId: "unknownBot" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "prefers config token over env",
      envToken: "env-token",
      cfg: {
        channels: { telegram: { botToken: "cfg-token" } },
      } as OpenClawConfig,
      expected: { token: "cfg-token", source: "config" },
    },
    {
      name: "uses env token when config is missing",
      envToken: "env-token",
      cfg: {
        channels: { telegram: {} },
      } as OpenClawConfig,
      expected: { token: "env-token", source: "env" },
    },
    {
      name: "uses tokenFile when configured",
      envToken: "",
      cfg: {
        channels: { telegram: { tokenFile: "" } },
      } as OpenClawConfig,
      resolveCfg: () =>
        ({
          channels: { telegram: { tokenFile: createTokenFile("token.txt") } },
        }) as OpenClawConfig,
      expected: { token: "file-token", source: "tokenFile" },
    },
    {
      name: "falls back to config token when no env or tokenFile",
      envToken: "",
      cfg: {
        channels: { telegram: { botToken: "cfg-token" } },
      } as OpenClawConfig,
      expected: { token: "cfg-token", source: "config" },
    },
  ])("$name", ({ envToken, cfg, resolveCfg, expected }) => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", envToken);
    const res = resolveTelegramToken(resolveCfg ? resolveCfg() : cfg);
    expect(res).toEqual(expected);
  });

  it.runIf(process.platform !== "win32")("rejects symlinked tokenFile paths", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = createTempDir();
    const tokenFile = path.join(dir, "token.txt");
    const tokenLink = path.join(dir, "token-link.txt");
    fs.writeFileSync(tokenFile, "file-token\n", "utf-8");
    fs.symlinkSync(tokenFile, tokenLink);

    const cfg = { channels: { telegram: { tokenFile: tokenLink } } } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("does not fall back to config when tokenFile is missing", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = createTempDir();
    const tokenFile = path.join(dir, "missing-token.txt");
    const cfg = {
      channels: { telegram: { tokenFile, botToken: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("resolves per-account tokens when the config account key casing doesn't match routing normalization", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            // Note the mixed-case key; runtime accountId is normalized.
            careyNotifications: { botToken: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "careynotifications" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  it("resolves per-account tokens when config keys normalize spaces to dashes", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            "Carey Notifications": { botToken: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "carey-notifications" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  it("falls back to top-level token for non-default accounts without account token", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "top-level-token",
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("top-level-token");
    expect(res.source).toBe("config");
  });

  it("uses account-level tokenFile before top-level fallbacks", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "top-level-token",
          tokenFile: createTokenFile("top-level-token.txt", "top-level-file-token\n"),
          accounts: {
            work: {
              tokenFile: createTokenFile("account-token.txt", "account-file-token\n"),
            },
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("account-file-token");
    expect(res.source).toBe("tokenFile");
  });

  it("falls back to top-level tokenFile for non-default accounts", () => {
    const cfg = {
      channels: {
        telegram: {
          tokenFile: createTokenFile("token.txt"),
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("file-token");
    expect(res.source).toBe("tokenFile");
  });

  it("does not use env token for non-default accounts", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("does not fall through to channel-level token when non-default accountId is not in config", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expectNoTokenForUnknownAccount(createUnknownAccountConfig());
  });

  it("resolves env-backed SecretRefs from process.env", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "secretref-env-token");
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramToken(cfg)).toEqual({
      token: "secretref-env-token",
      source: "config",
    });
  });

  it("does not fall back to TELEGRAM_BOT_TOKEN when an explicit env SecretRef is configured but unavailable", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fallback-env-token");
    vi.stubEnv("TELEGRAM_REF_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_REF_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramToken(cfg)).toEqual({
      token: "",
      source: "none",
    });
  });

  it("does not fall through when account-level env SecretRef is configured but unavailable", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fallback-env-token");
    vi.stubEnv("TELEGRAM_ACCOUNT_REF_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          botToken: "channel-token",
          accounts: {
            default: {
              botToken: {
                source: "env",
                provider: "default",
                id: "TELEGRAM_ACCOUNT_REF_TOKEN",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramToken(cfg)).toEqual({
      token: "",
      source: "none",
    });
  });

  it("does not bypass env provider allowlists for env-backed SecretRefs", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "secretref-env-token");
    const cfg = {
      secrets: {
        providers: {
          "telegram-env": {
            source: "env",
            allowlist: ["OTHER_TELEGRAM_BOT_TOKEN"],
          },
        },
      },
      channels: {
        telegram: {
          botToken: { source: "env", provider: "telegram-env", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveTelegramToken(cfg)).toThrow(
      /not allowlisted in secrets\.providers\.telegram-env\.allowlist/i,
    );
  });

  it("throws when an env SecretRef points at a provider configured with another source", () => {
    const cfg = {
      secrets: {
        providers: {
          "telegram-env": {
            source: "file",
            path: "/tmp/secrets.json",
          },
        },
      },
      channels: {
        telegram: {
          botToken: { source: "env", provider: "telegram-env", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveTelegramToken(cfg)).toThrow(
      /Secret provider "telegram-env" has source "file" but ref requests "env"/i,
    );
  });

  it("throws when an env SecretRef provider is not configured and not the default env alias", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "env", provider: "ops-env", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveTelegramToken(cfg)).toThrow(
      /Secret provider "ops-env" is not configured \(ref: env:ops-env:TELEGRAM_BOT_TOKEN\)/i,
    );
  });

  it("accepts env SecretRefs that use the configured default env provider alias", () => {
    vi.stubEnv("TELEGRAM_RUNTIME_TOKEN", "secretref-env-token");
    const cfg = {
      secrets: {
        defaults: {
          env: "telegram-runtime",
        },
      },
      channels: {
        telegram: {
          botToken: {
            source: "env",
            provider: "telegram-runtime",
            id: "TELEGRAM_RUNTIME_TOKEN",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramToken(cfg)).toEqual({
      token: "secretref-env-token",
      source: "config",
    });
  });

  it("keeps strict runtime behavior for unresolved non-env SecretRefs", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "file", provider: "vault", id: "/telegram/bot-token" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveTelegramToken(cfg)).toThrow(
      /channels\.telegram\.botToken: unresolved SecretRef/i,
    );
  });

  // Regression: https://github.com/openclaw/openclaw/issues/53876
  // Binding-created accountIds should inherit the channel-level token in
  // single-bot setups (no accounts section).
  it("falls through to channel-level token for binding-created accountId without accounts section", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "channel-level-token",
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "bot-main" });
    expect(res.token).toBe("channel-level-token");
    expect(res.source).toBe("config");
  });

  it("still blocks fallthrough for unknown accountId when accounts section exists", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expectNoTokenForUnknownAccount(createUnknownAccountConfig());
  });
});

describe("telegram update offset store", () => {
  it("persists and reloads the last update id", async () => {
    await withStateDirEnv("openclaw-telegram-", async () => {
      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();

      await writeTelegramUpdateOffset({
        accountId: "primary",
        updateId: 421,
      });

      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBe(421);
    });
  });
});
