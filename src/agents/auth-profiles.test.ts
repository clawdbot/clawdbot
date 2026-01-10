import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withTempHome } from "../../test/helpers/temp-home.js";
import {
  type AuthProfileStore,
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  calculateAuthProfileCooldownMs,
  ensureAuthProfileStore,
  markAuthProfileFailure,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

describe("resolveAuthProfileOrder", () => {
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-default",
      },
      "anthropic:work": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-work",
      },
    },
  };
  const cfg = {
    auth: {
      profiles: {
        "anthropic:default": { provider: "anthropic", mode: "api_key" },
        "anthropic:work": { provider: "anthropic", mode: "api_key" },
      },
    },
  };

  it("uses stored profiles when no config exists", () => {
    const order = resolveAuthProfileOrder({
      store,
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:default", "anthropic:work"]);
  });

  it("prioritizes preferred profiles", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      store,
      provider: "anthropic",
      preferredProfile: "anthropic:work",
    });
    expect(order[0]).toBe("anthropic:work");
    expect(order).toContain("anthropic:default");
  });

  it("does not prioritize lastGood over round-robin ordering", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      store: {
        ...store,
        lastGood: { anthropic: "anthropic:work" },
        usageStats: {
          "anthropic:default": { lastUsed: 100 },
          "anthropic:work": { lastUsed: 200 },
        },
      },
      provider: "anthropic",
    });
    expect(order[0]).toBe("anthropic:default");
  });

  it("uses explicit profiles when order is missing", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      store,
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:default", "anthropic:work"]);
  });

  it("uses configured order when provided", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:work", "anthropic:default"] },
          profiles: cfg.auth.profiles,
        },
      },
      store,
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });

  it("prefers store order over config order", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:default", "anthropic:work"] },
          profiles: cfg.auth.profiles,
        },
      },
      store: {
        ...store,
        order: { anthropic: ["anthropic:work", "anthropic:default"] },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });

  it("pushes cooldown profiles to the end even with store order", () => {
    const now = Date.now();
    const order = resolveAuthProfileOrder({
      store: {
        ...store,
        order: { anthropic: ["anthropic:default", "anthropic:work"] },
        usageStats: {
          "anthropic:default": { cooldownUntil: now + 60_000 },
          "anthropic:work": { lastUsed: 1 },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });

  it("pushes cooldown profiles to the end even with configured order", () => {
    const now = Date.now();
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:default", "anthropic:work"] },
          profiles: cfg.auth.profiles,
        },
      },
      store: {
        ...store,
        usageStats: {
          "anthropic:default": { cooldownUntil: now + 60_000 },
          "anthropic:work": { lastUsed: 1 },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });

  it("pushes disabled profiles to the end even with store order", () => {
    const now = Date.now();
    const order = resolveAuthProfileOrder({
      store: {
        ...store,
        order: { anthropic: ["anthropic:default", "anthropic:work"] },
        usageStats: {
          "anthropic:default": {
            disabledUntil: now + 60_000,
            disabledReason: "billing",
          },
          "anthropic:work": { lastUsed: 1 },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });

  it("pushes disabled profiles to the end even with configured order", () => {
    const now = Date.now();
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:default", "anthropic:work"] },
          profiles: cfg.auth.profiles,
        },
      },
      store: {
        ...store,
        usageStats: {
          "anthropic:default": {
            disabledUntil: now + 60_000,
            disabledReason: "billing",
          },
          "anthropic:work": { lastUsed: 1 },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });

  it("normalizes z.ai aliases in auth.order", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { "z.ai": ["zai:work", "zai:default"] },
          profiles: {
            "zai:default": { provider: "zai", mode: "api_key" },
            "zai:work": { provider: "zai", mode: "api_key" },
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "zai:default": {
            type: "api_key",
            provider: "zai",
            key: "sk-default",
          },
          "zai:work": {
            type: "api_key",
            provider: "zai",
            key: "sk-work",
          },
        },
      },
      provider: "zai",
    });
    expect(order).toEqual(["zai:work", "zai:default"]);
  });

  it("normalizes provider casing in auth.order keys", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { OpenAI: ["openai:work", "openai:default"] },
          profiles: {
            "openai:default": { provider: "openai", mode: "api_key" },
            "openai:work": { provider: "openai", mode: "api_key" },
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-default",
          },
          "openai:work": {
            type: "api_key",
            provider: "openai",
            key: "sk-work",
          },
        },
      },
      provider: "openai",
    });
    expect(order).toEqual(["openai:work", "openai:default"]);
  });

  it("normalizes z.ai aliases in auth.profiles", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: {
            "zai:default": { provider: "z.ai", mode: "api_key" },
            "zai:work": { provider: "Z.AI", mode: "api_key" },
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "zai:default": {
            type: "api_key",
            provider: "zai",
            key: "sk-default",
          },
          "zai:work": {
            type: "api_key",
            provider: "zai",
            key: "sk-work",
          },
        },
      },
      provider: "zai",
    });
    expect(order).toEqual(["zai:default", "zai:work"]);
  });

  it("prioritizes oauth profiles when order missing", () => {
    const mixedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-default",
        },
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    const order = resolveAuthProfileOrder({
      store: mixedStore,
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:oauth", "anthropic:default"]);
  });

  it("orders by lastUsed when no explicit order exists", () => {
    const order = resolveAuthProfileOrder({
      store: {
        version: 1,
        profiles: {
          "anthropic:a": {
            type: "oauth",
            provider: "anthropic",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
          "anthropic:b": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-b",
          },
          "anthropic:c": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-c",
          },
        },
        usageStats: {
          "anthropic:a": { lastUsed: 200 },
          "anthropic:b": { lastUsed: 100 },
          "anthropic:c": { lastUsed: 300 },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:a", "anthropic:b", "anthropic:c"]);
  });

  it("pushes cooldown profiles to the end, ordered by cooldown expiry", () => {
    const now = Date.now();
    const order = resolveAuthProfileOrder({
      store: {
        version: 1,
        profiles: {
          "anthropic:ready": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-ready",
          },
          "anthropic:cool1": {
            type: "oauth",
            provider: "anthropic",
            access: "access-token",
            refresh: "refresh-token",
            expires: now + 60_000,
          },
          "anthropic:cool2": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-cool",
          },
        },
        usageStats: {
          "anthropic:ready": { lastUsed: 50 },
          "anthropic:cool1": { cooldownUntil: now + 5_000 },
          "anthropic:cool2": { cooldownUntil: now + 1_000 },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual([
      "anthropic:ready",
      "anthropic:cool2",
      "anthropic:cool1",
    ]);
  });
});

describe("ensureAuthProfileStore", () => {
  it("migrates legacy auth.json and deletes it (PR #368)", () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-auth-profiles-"),
    );
    try {
      const legacyPath = path.join(agentDir, "auth.json");
      fs.writeFileSync(
        legacyPath,
        `${JSON.stringify(
          {
            anthropic: {
              type: "oauth",
              provider: "anthropic",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        type: "oauth",
        provider: "anthropic",
      });

      const migratedPath = path.join(agentDir, "auth-profiles.json");
      expect(fs.existsSync(migratedPath)).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(false);

      // idempotent
      const store2 = ensureAuthProfileStore(agentDir);
      expect(store2.profiles["anthropic:default"]).toBeDefined();
      expect(fs.existsSync(legacyPath)).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("auth profile cooldowns", () => {
  it("applies exponential backoff with a 1h cap", () => {
    expect(calculateAuthProfileCooldownMs(1)).toBe(60_000);
    expect(calculateAuthProfileCooldownMs(2)).toBe(5 * 60_000);
    expect(calculateAuthProfileCooldownMs(3)).toBe(25 * 60_000);
    expect(calculateAuthProfileCooldownMs(4)).toBe(60 * 60_000);
    expect(calculateAuthProfileCooldownMs(5)).toBe(60 * 60_000);
  });
});

describe("markAuthProfileFailure", () => {
  it("disables billing failures for ~5 hours by default", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-auth-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "sk-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      const startedAt = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "billing",
        agentDir,
      });

      const disabledUntil =
        store.usageStats?.["anthropic:default"]?.disabledUntil;
      expect(typeof disabledUntil).toBe("number");
      const remainingMs = (disabledUntil as number) - startedAt;
      expect(remainingMs).toBeGreaterThan(4.5 * 60 * 60 * 1000);
      expect(remainingMs).toBeLessThan(5.5 * 60 * 60 * 1000);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("honors per-provider billing backoff overrides", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-auth-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "sk-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      const startedAt = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "billing",
        agentDir,
        cfg: {
          auth: {
            cooldowns: {
              billingBackoffHoursByProvider: { Anthropic: 1 },
              billingMaxHours: 2,
            },
          },
        } as never,
      });

      const disabledUntil =
        store.usageStats?.["anthropic:default"]?.disabledUntil;
      expect(typeof disabledUntil).toBe("number");
      const remainingMs = (disabledUntil as number) - startedAt;
      expect(remainingMs).toBeGreaterThan(0.8 * 60 * 60 * 1000);
      expect(remainingMs).toBeLessThan(1.2 * 60 * 60 * 1000);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("resets backoff counters outside the failure window", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-auth-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      const now = Date.now();
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "sk-default",
            },
          },
          usageStats: {
            "anthropic:default": {
              errorCount: 9,
              failureCounts: { billing: 3 },
              lastFailureAt: now - 48 * 60 * 60 * 1000,
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "billing",
        agentDir,
        cfg: {
          auth: { cooldowns: { failureWindowHours: 24 } },
        } as never,
      });

      expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(1);
      expect(
        store.usageStats?.["anthropic:default"]?.failureCounts?.billing,
      ).toBe(1);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("external CLI credential sync", () => {
  it("syncs Claude CLI OAuth credentials into anthropic:claude-cli", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-sync-"),
    );
    try {
      // Create a temp home with Claude CLI credentials
      await withTempHome(
        async (tempHome) => {
          // Create Claude CLI credentials with refreshToken (OAuth)
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          const claudeCreds = {
            claudeAiOauth: {
              accessToken: "fresh-access-token",
              refreshToken: "fresh-refresh-token",
              expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
            },
          };
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify(claudeCreds),
          );

          // Create empty auth-profiles.json
          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                "anthropic:default": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "sk-default",
                },
              },
            }),
          );

          // Load the store - should sync from CLI as OAuth credential
          const store = ensureAuthProfileStore(agentDir);

          expect(store.profiles["anthropic:default"]).toBeDefined();
          expect(
            (store.profiles["anthropic:default"] as { key: string }).key,
          ).toBe("sk-default");
          expect(store.profiles[CLAUDE_CLI_PROFILE_ID]).toBeDefined();
          // Should be stored as OAuth credential (type: "oauth") for auto-refresh
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe(
            "fresh-access-token",
          );
          expect((cliProfile as { refresh: string }).refresh).toBe(
            "fresh-refresh-token",
          );
          expect((cliProfile as { expires: number }).expires).toBeGreaterThan(
            Date.now(),
          );
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("syncs Claude CLI credentials without refreshToken as token type", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-token-sync-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          // Create Claude CLI credentials WITHOUT refreshToken (fallback to token type)
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          const claudeCreds = {
            claudeAiOauth: {
              accessToken: "access-only-token",
              // No refreshToken - backward compatibility scenario
              expiresAt: Date.now() + 60 * 60 * 1000,
            },
          };
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify(claudeCreds),
          );

          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({ version: 1, profiles: {} }),
          );

          const store = ensureAuthProfileStore(agentDir);

          expect(store.profiles[CLAUDE_CLI_PROFILE_ID]).toBeDefined();
          // Should be stored as token type (no refresh capability)
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("token");
          expect((cliProfile as { token: string }).token).toBe(
            "access-only-token",
          );
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("upgrades token to oauth when Claude CLI gets refreshToken", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-upgrade-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          // Create Claude CLI credentials with refreshToken
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "new-oauth-access",
                refreshToken: "new-refresh-token",
                expiresAt: Date.now() + 60 * 60 * 1000,
              },
            }),
          );

          // Create auth-profiles.json with existing token type credential
          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CLAUDE_CLI_PROFILE_ID]: {
                  type: "token",
                  provider: "anthropic",
                  token: "old-token",
                  expires: Date.now() + 30 * 60 * 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);

          // Should upgrade from token to oauth
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe(
            "new-oauth-access",
          );
          expect((cliProfile as { refresh: string }).refresh).toBe(
            "new-refresh-token",
          );
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("syncs Codex CLI credentials into openai-codex:codex-cli", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-codex-sync-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          // Create Codex CLI credentials
          const codexDir = path.join(tempHome, ".codex");
          fs.mkdirSync(codexDir, { recursive: true });
          const codexCreds = {
            tokens: {
              access_token: "codex-access-token",
              refresh_token: "codex-refresh-token",
            },
          };
          const codexAuthPath = path.join(codexDir, "auth.json");
          fs.writeFileSync(codexAuthPath, JSON.stringify(codexCreds));

          // Create empty auth-profiles.json
          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {},
            }),
          );

          const store = ensureAuthProfileStore(agentDir);

          expect(store.profiles[CODEX_CLI_PROFILE_ID]).toBeDefined();
          expect(
            (store.profiles[CODEX_CLI_PROFILE_ID] as { access: string }).access,
          ).toBe("codex-access-token");
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite API keys when syncing external CLI creds", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-no-overwrite-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          // Create Claude CLI credentials
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          const claudeCreds = {
            claudeAiOauth: {
              accessToken: "cli-access",
              refreshToken: "cli-refresh",
              expiresAt: Date.now() + 30 * 60 * 1000,
            },
          };
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify(claudeCreds),
          );

          // Create auth-profiles.json with an API key
          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                "anthropic:default": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "sk-store",
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);

          // Should keep the store's API key and still add the CLI profile.
          expect(
            (store.profiles["anthropic:default"] as { key: string }).key,
          ).toBe("sk-store");
          expect(store.profiles[CLAUDE_CLI_PROFILE_ID]).toBeDefined();
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("prefers oauth over token even if token has later expiry (oauth enables auto-refresh)", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-oauth-preferred-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          // CLI has OAuth credentials (with refresh token) expiring in 30 min
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "cli-oauth-access",
                refreshToken: "cli-refresh",
                expiresAt: Date.now() + 30 * 60 * 1000,
              },
            }),
          );

          const authPath = path.join(agentDir, "auth-profiles.json");
          // Store has token credentials expiring in 60 min (later than CLI)
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CLAUDE_CLI_PROFILE_ID]: {
                  type: "token",
                  provider: "anthropic",
                  token: "store-token-access",
                  expires: Date.now() + 60 * 60 * 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);
          // OAuth should be preferred over token because it can auto-refresh
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe(
            "cli-oauth-access",
          );
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite fresher store oauth with older CLI oauth", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-oauth-no-downgrade-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          // CLI has OAuth credentials expiring in 30 min
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "cli-oauth-access",
                refreshToken: "cli-refresh",
                expiresAt: Date.now() + 30 * 60 * 1000,
              },
            }),
          );

          const authPath = path.join(agentDir, "auth-profiles.json");
          // Store has OAuth credentials expiring in 60 min (later than CLI)
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CLAUDE_CLI_PROFILE_ID]: {
                  type: "oauth",
                  provider: "anthropic",
                  access: "store-oauth-access",
                  refresh: "store-refresh",
                  expires: Date.now() + 60 * 60 * 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);
          // Fresher store oauth should be kept
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe(
            "store-oauth-access",
          );
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("does not downgrade store oauth to token when CLI lacks refresh token", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-no-downgrade-oauth-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          // CLI has token-only credentials (no refresh token)
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "cli-token-access",
                expiresAt: Date.now() + 30 * 60 * 1000,
              },
            }),
          );

          const authPath = path.join(agentDir, "auth-profiles.json");
          // Store already has OAuth credentials with refresh token
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CLAUDE_CLI_PROFILE_ID]: {
                  type: "oauth",
                  provider: "anthropic",
                  access: "store-oauth-access",
                  refresh: "store-refresh",
                  expires: Date.now() + 60 * 60 * 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);
          // Keep oauth to preserve auto-refresh capability
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe(
            "store-oauth-access",
          );
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("updates codex-cli profile when Codex CLI refresh token changes", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-codex-refresh-sync-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          const codexDir = path.join(tempHome, ".codex");
          fs.mkdirSync(codexDir, { recursive: true });
          const codexAuthPath = path.join(codexDir, "auth.json");
          fs.writeFileSync(
            codexAuthPath,
            JSON.stringify({
              tokens: {
                access_token: "same-access",
                refresh_token: "new-refresh",
              },
            }),
          );
          fs.utimesSync(codexAuthPath, new Date(), new Date());

          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CODEX_CLI_PROFILE_ID]: {
                  type: "oauth",
                  provider: "openai-codex",
                  access: "same-access",
                  refresh: "old-refresh",
                  expires: Date.now() - 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);
          expect(
            (store.profiles[CODEX_CLI_PROFILE_ID] as { refresh: string })
              .refresh,
          ).toBe("new-refresh");
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
