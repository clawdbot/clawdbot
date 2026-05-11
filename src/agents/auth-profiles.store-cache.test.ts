import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_LOCK_OPTIONS, AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "./auth-profiles/store.js";
import type { OAuthCredential } from "./auth-profiles/types.js";

type RuntimeOnlyOverlay = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

const mocks = vi.hoisted(() => ({
  resolveExternalCliAuthProfiles: vi.fn<
    (store?: unknown, options?: unknown) => RuntimeOnlyOverlay[]
  >(() => []),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: mocks.resolveExternalCliAuthProfiles,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

async function withAgentDirEnv(prefix: string, run: (agentDir: string) => void | Promise<void>) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await run(agentDir);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    if (previousPiAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

function writeAuthStore(agentDir: string, key: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  fs.writeFileSync(
    authPath,
    `${JSON.stringify(
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return authPath;
}

function writeOAuthStore(agentDir: string, profileId: string, credential: OAuthCredential) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  fs.writeFileSync(
    authPath,
    `${JSON.stringify(
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          [profileId]: credential,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return authPath;
}

describe("auth profile store cache", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    mocks.resolveExternalCliAuthProfiles.mockReset();
    mocks.resolveExternalCliAuthProfiles.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  function createRuntimeOnlyOverlay(access: string): RuntimeOnlyOverlay {
    return {
      profileId: "openai-codex:default",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access,
        refresh: `refresh-${access}`,
        expires: Date.now() + 60_000,
      },
    };
  }

  function createPersistedOverlay(
    profileId: string,
    credential: OAuthCredential,
  ): RuntimeOnlyOverlay {
    return {
      profileId,
      credential,
      persistence: "persisted",
    };
  }

  it("recomputes runtime-only external auth overlays even while the base store is cached", async () => {
    await withAgentDirEnv("openclaw-auth-store-cache-", (agentDir) => {
      writeAuthStore(agentDir, "sk-test");
      mocks.resolveExternalCliAuthProfiles
        .mockReturnValueOnce([createRuntimeOnlyOverlay("access-1")])
        .mockReturnValueOnce([createRuntimeOnlyOverlay("access-2")]);

      const first = ensureAuthProfileStore(agentDir);
      const second = ensureAuthProfileStore(agentDir);

      expect((first.profiles["openai-codex:default"] as OAuthCredential | undefined)?.access).toBe(
        "access-1",
      );
      expect((second.profiles["openai-codex:default"] as OAuthCredential | undefined)?.access).toBe(
        "access-2",
      );
      expect(mocks.resolveExternalCliAuthProfiles).toHaveBeenCalledTimes(2);
    });
  });

  it("refreshes the cached auth store after auth-profiles.json changes", async () => {
    await withAgentDirEnv("openclaw-auth-store-refresh-", async (agentDir) => {
      const authPath = writeAuthStore(agentDir, "sk-test-1");

      ensureAuthProfileStore(agentDir);

      writeAuthStore(agentDir, "sk-test-2");
      const bumpedMtime = new Date(Date.now() + 2_000);
      fs.utimesSync(authPath, bumpedMtime, bumpedMtime);

      const reloaded = ensureAuthProfileStore(agentDir);

      expect((reloaded.profiles["openai:default"] as { key?: string } | undefined)?.key).toBe(
        "sk-test-2",
      );
    });
  });

  it("isolates cached auth stores without structuredClone", async () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    await withAgentDirEnv("openclaw-auth-store-isolated-", (agentDir) => {
      writeAuthStore(agentDir, "sk-test");

      const first = ensureAuthProfileStore(agentDir);
      const profile = first.profiles["openai:default"];
      if (profile?.type === "api_key") {
        profile.key = "sk-mutated";
      }
      first.profiles["anthropic:default"] = {
        type: "api_key",
        provider: "anthropic",
        key: "sk-added",
      };

      const second = ensureAuthProfileStore(agentDir);
      expect((second.profiles["openai:default"] as { key?: string } | undefined)?.key).toBe(
        "sk-test",
      );
      expect(second.profiles["anthropic:default"]).toBeUndefined();
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    });
    structuredCloneSpy.mockRestore();
  });

  it("keeps runtime-only external auth out of persisted auth-profiles.json files", async () => {
    mocks.resolveExternalCliAuthProfiles.mockReturnValue([createRuntimeOnlyOverlay("access-1")]);

    await withAgentDirEnv("openclaw-auth-store-missing-", (agentDir) => {
      const store = ensureAuthProfileStore(agentDir);

      expect((store.profiles["openai-codex:default"] as OAuthCredential | undefined)?.access).toBe(
        "access-1",
      );
      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
    });
  });

  it("persists fresher external CLI oauth over a stale local managed profile", async () => {
    await withAgentDirEnv("openclaw-auth-store-external-cli-persist-", (agentDir) => {
      const profileId = "anthropic:claude-cli";
      writeOAuthStore(agentDir, profileId, {
        type: "oauth",
        provider: "claude-cli",
        access: "stale-local-access",
        refresh: "stale-local-refresh",
        expires: Date.now() - 60_000,
      });
      mocks.resolveExternalCliAuthProfiles
        .mockReturnValueOnce([
          createPersistedOverlay(profileId, {
            type: "oauth",
            provider: "claude-cli",
            access: "fresh-cli-access",
            refresh: "fresh-cli-refresh",
            expires: Date.now() + 60_000,
          }),
        ])
        .mockReturnValue([]);

      const store = ensureAuthProfileStore(agentDir);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"),
      ) as { profiles: Record<string, OAuthCredential> };

      expect((store.profiles[profileId] as OAuthCredential | undefined)?.access).toBe(
        "fresh-cli-access",
      );
      expect(persisted.profiles[profileId]?.access).toBe("fresh-cli-access");
      expect(persisted.profiles[profileId]?.refresh).toBe("fresh-cli-refresh");
    });
  });

  it("preserves concurrent auth-store updates while persisting external CLI oauth", async () => {
    await withAgentDirEnv("openclaw-auth-store-external-cli-concurrent-", (agentDir) => {
      const profileId = "anthropic:claude-cli";
      const authPath = writeOAuthStore(agentDir, profileId, {
        type: "oauth",
        provider: "claude-cli",
        access: "stale-local-access",
        refresh: "stale-local-refresh",
        expires: Date.now() - 60_000,
      });
      mocks.resolveExternalCliAuthProfiles.mockImplementationOnce(() => {
        const current = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
          profiles: Record<string, unknown>;
        };
        fs.writeFileSync(
          authPath,
          `${JSON.stringify(
            {
              ...current,
              profiles: {
                ...current.profiles,
                "openai:default": {
                  type: "api_key",
                  provider: "openai",
                  key: "sk-concurrent",
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        return [
          createPersistedOverlay(profileId, {
            type: "oauth",
            provider: "claude-cli",
            access: "fresh-cli-access",
            refresh: "fresh-cli-refresh",
            expires: Date.now() + 60_000,
          }),
        ];
      });

      ensureAuthProfileStore(agentDir);
      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
        profiles: Record<string, unknown>;
      };
      const cliProfile = persisted.profiles[profileId] as OAuthCredential | undefined;
      const openaiProfile = persisted.profiles["openai:default"] as { key?: string } | undefined;

      expect(cliProfile?.access).toBe("fresh-cli-access");
      expect(openaiProfile?.key).toBe("sk-concurrent");
    });
  });

  it("returns the reloaded store when the synced CLI profile changed concurrently", async () => {
    await withAgentDirEnv("openclaw-auth-store-external-cli-profile-race-", (agentDir) => {
      const profileId = "anthropic:claude-cli";
      const authPath = writeOAuthStore(agentDir, profileId, {
        type: "oauth",
        provider: "claude-cli",
        access: "stale-local-access",
        refresh: "stale-local-refresh",
        expires: Date.now() - 60_000,
      });
      mocks.resolveExternalCliAuthProfiles.mockImplementationOnce(() => {
        writeOAuthStore(agentDir, profileId, {
          type: "oauth",
          provider: "claude-cli",
          access: "manual-concurrent-access",
          refresh: "manual-concurrent-refresh",
          expires: Date.now() + 120_000,
        });
        return [
          createPersistedOverlay(profileId, {
            type: "oauth",
            provider: "claude-cli",
            access: "fresh-cli-access",
            refresh: "fresh-cli-refresh",
            expires: Date.now() + 60_000,
          }),
        ];
      });

      const first = ensureAuthProfileStore(agentDir);
      const second = ensureAuthProfileStore(agentDir);
      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
        profiles: Record<string, OAuthCredential>;
      };

      expect((first.profiles[profileId] as OAuthCredential | undefined)?.access).toBe(
        "manual-concurrent-access",
      );
      expect((second.profiles[profileId] as OAuthCredential | undefined)?.access).toBe(
        "manual-concurrent-access",
      );
      expect(persisted.profiles[profileId]?.access).toBe("manual-concurrent-access");
    });
  });

  it("does not reclaim an existing auth-store lock while syncing external CLI oauth", async () => {
    await withAgentDirEnv("openclaw-auth-store-external-cli-live-lock-", (agentDir) => {
      const profileId = "anthropic:claude-cli";
      const authPath = writeOAuthStore(agentDir, profileId, {
        type: "oauth",
        provider: "claude-cli",
        access: "stale-local-access",
        refresh: "stale-local-refresh",
        expires: Date.now() - 60_000,
      });
      const lockPath = `${authPath}.lock`;
      const lockRaw = `${JSON.stringify(
        {
          pid: process.pid,
          createdAt: new Date(Date.now() - AUTH_STORE_LOCK_OPTIONS.stale - 1_000).toISOString(),
        },
        null,
        2,
      )}\n`;
      fs.writeFileSync(lockPath, lockRaw, "utf8");
      const oldLockTime = new Date(Date.now() - AUTH_STORE_LOCK_OPTIONS.stale - 1_000);
      fs.utimesSync(lockPath, oldLockTime, oldLockTime);
      mocks.resolveExternalCliAuthProfiles.mockReturnValue([
        createPersistedOverlay(profileId, {
          type: "oauth",
          provider: "claude-cli",
          access: "fresh-cli-access",
          refresh: "fresh-cli-refresh",
          expires: Date.now() + 60_000,
        }),
      ]);

      ensureAuthProfileStore(agentDir);
      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
        profiles: Record<string, OAuthCredential>;
      };

      expect(fs.readFileSync(lockPath, "utf8")).toBe(lockRaw);
      expect(persisted.profiles[profileId]?.access).toBe("stale-local-access");
      expect(persisted.profiles[profileId]?.refresh).toBe("stale-local-refresh");
    });
  });

  it("does not cache stale auth after external CLI sync lock contention", async () => {
    await withAgentDirEnv("openclaw-auth-store-external-cli-locked-cache-", (agentDir) => {
      const profileId = "anthropic:claude-cli";
      const authPath = writeOAuthStore(agentDir, profileId, {
        type: "oauth",
        provider: "claude-cli",
        access: "stale-local-access",
        refresh: "stale-local-refresh",
        expires: Date.now() - 60_000,
      });
      const lockPath = `${authPath}.lock`;
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
      mocks.resolveExternalCliAuthProfiles
        .mockImplementationOnce(() => {
          writeOAuthStore(agentDir, profileId, {
            type: "oauth",
            provider: "claude-cli",
            access: "fresh-disk-access",
            refresh: "fresh-disk-refresh",
            expires: Date.now() + 120_000,
          });
          const bumpedMtime = new Date(Date.now() + 2_000);
          fs.utimesSync(authPath, bumpedMtime, bumpedMtime);
          return [
            createPersistedOverlay(profileId, {
              type: "oauth",
              provider: "claude-cli",
              access: "fresh-cli-access",
              refresh: "fresh-cli-refresh",
              expires: Date.now() + 60_000,
            }),
          ];
        })
        .mockReturnValue([]);

      const first = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      const second = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);

      expect((first.profiles[profileId] as OAuthCredential | undefined)?.access).toBe(
        "stale-local-access",
      );
      expect((second.profiles[profileId] as OAuthCredential | undefined)?.access).toBe(
        "fresh-disk-access",
      );
    });
  });
});
