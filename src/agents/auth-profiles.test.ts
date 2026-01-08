import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AuthProfileStore,
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  calculateAuthProfileCooldownMs,
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

const HOME_ENV_KEYS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
type HomeEnvSnapshot = Record<
  (typeof HOME_ENV_KEYS)[number],
  string | undefined
>;

const snapshotHomeEnv = (): HomeEnvSnapshot => ({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
});

const restoreHomeEnv = (snapshot: HomeEnvSnapshot) => {
  for (const key of HOME_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const setTempHome = (tempHome: string) => {
  process.env.HOME = tempHome;
  if (process.platform === "win32") {
    process.env.USERPROFILE = tempHome;
    const root = path.parse(tempHome).root;
    process.env.HOMEDRIVE = root.replace(/\\$/, "");
    process.env.HOMEPATH = tempHome.slice(root.length - 1);
  }
};

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

describe("external CLI credential sync", () => {
  it("syncs Claude CLI credentials into anthropic:claude-cli", () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-sync-"),
    );
    const originalHome = snapshotHomeEnv();

    try {
      // Create a temp home with Claude CLI credentials
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-home-"));
      setTempHome(tempHome);

      // Create Claude CLI credentials
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

      // Load the store - should sync from CLI
      const store = ensureAuthProfileStore(agentDir);

      expect(store.profiles["anthropic:default"]).toBeDefined();
      expect((store.profiles["anthropic:default"] as { key: string }).key).toBe(
        "sk-default",
      );
      expect(store.profiles[CLAUDE_CLI_PROFILE_ID]).toBeDefined();
      expect(
        (store.profiles[CLAUDE_CLI_PROFILE_ID] as { access: string }).access,
      ).toBe("fresh-access-token");
      expect(
        (store.profiles[CLAUDE_CLI_PROFILE_ID] as { expires: number }).expires,
      ).toBeGreaterThan(Date.now());
    } finally {
      restoreHomeEnv(originalHome);
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("syncs Codex CLI credentials into openai-codex:codex-cli", () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-codex-sync-"),
    );
    const originalHome = snapshotHomeEnv();

    try {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-home-"));
      setTempHome(tempHome);

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
    } finally {
      restoreHomeEnv(originalHome);
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite API keys when syncing external CLI creds", () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-no-overwrite-"),
    );
    const originalHome = snapshotHomeEnv();

    try {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-home-"));
      setTempHome(tempHome);

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
      expect((store.profiles["anthropic:default"] as { key: string }).key).toBe(
        "sk-store",
      );
      expect(store.profiles[CLAUDE_CLI_PROFILE_ID]).toBeDefined();
    } finally {
      restoreHomeEnv(originalHome);
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite fresher store OAuth with older Claude CLI credentials", () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-no-downgrade-"),
    );
    const originalHome = snapshotHomeEnv();

    try {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-home-"));
      setTempHome(tempHome);

      const claudeDir = path.join(tempHome, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "cli-access",
            refreshToken: "cli-refresh",
            expiresAt: Date.now() + 30 * 60 * 1000,
          },
        }),
      );

      const authPath = path.join(agentDir, "auth-profiles.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            [CLAUDE_CLI_PROFILE_ID]: {
              type: "oauth",
              provider: "anthropic",
              access: "store-access",
              refresh: "store-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(
        (store.profiles[CLAUDE_CLI_PROFILE_ID] as { access: string }).access,
      ).toBe("store-access");
    } finally {
      restoreHomeEnv(originalHome);
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("updates codex-cli profile when Codex CLI refresh token changes", () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-codex-refresh-sync-"),
    );
    const originalHome = snapshotHomeEnv();

    try {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-home-"));
      setTempHome(tempHome);

      const codexDir = path.join(tempHome, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const codexAuthPath = path.join(codexDir, "auth.json");
      fs.writeFileSync(
        codexAuthPath,
        JSON.stringify({
          tokens: { access_token: "same-access", refresh_token: "new-refresh" },
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
        (store.profiles[CODEX_CLI_PROFILE_ID] as { refresh: string }).refresh,
      ).toBe("new-refresh");
    } finally {
      restoreHomeEnv(originalHome);
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
