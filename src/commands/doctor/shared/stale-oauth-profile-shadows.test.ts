import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuthStorePath } from "../../../agents/auth-profiles/paths.js";
import { loadPersistedAuthProfileStore } from "../../../agents/auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../../../agents/auth-profiles/store.js";
import type { AuthProfileStore, OAuthCredential } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { captureEnv } from "../../../test-utils/env.js";
import {
  __testing,
  collectStaleOAuthProfileShadowWarnings,
  repairStaleOAuthProfileShadows,
  scanStaleOAuthProfileShadows,
} from "./stale-oauth-profile-shadows.js";

function oauthCredential(overrides: Partial<OAuthCredential>): OAuthCredential {
  return {
    type: "oauth",
    provider: "anthropic",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

function storeWith(profileId: string, credential: OAuthCredential): AuthProfileStore {
  return {
    version: 1,
    profiles: { [profileId]: credential },
  };
}

async function writeRawAuthStore(agentDir: string, store: unknown): Promise<void> {
  const authPath = resolveAuthStorePath(agentDir);
  await fs.mkdir(path.dirname(authPath), { recursive: true });
  await fs.writeFile(authPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

describe("stale OAuth profile shadow doctor repair", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_HOME"]);
  let tempRoot = "";
  let stateDir = "";

  beforeEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-oauth-shadow-"));
    stateDir = path.join(tempRoot, "state");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_HOME = stateDir;
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("warns about stale local OAuth shadows without modifying the child store", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const childAgentDir = path.join(stateDir, "agents", "telegram", "agent");
    await writeRawAuthStore(
      childAgentDir,
      storeWith(
        profileId,
        oauthCredential({
          access: "child-access",
          refresh: "child-refresh",
          expires: now - 60_000,
          accountId: "acct-shared",
        }),
      ),
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCredential({
          access: "main-access",
          refresh: "main-refresh",
          expires: now + 60 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
    );

    const hits = await scanStaleOAuthProfileShadows({
      cfg: {} satisfies OpenClawConfig,
      now,
    });
    const warnings = collectStaleOAuthProfileShadowWarnings({
      hits,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(hits).toHaveLength(1);
    expect(warnings[0]).toContain("stale OAuth auth profile anthropic:default");
    expect(warnings[0]).toContain("openclaw doctor --fix");
    expect(loadPersistedAuthProfileStore(childAgentDir)?.profiles[profileId]).toBeDefined();
  });

  it("uses the injected env for the main auth store", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const injectedStateDir = path.join(tempRoot, "injected-state");
    const injectedEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: injectedStateDir,
      OPENCLAW_HOME: injectedStateDir,
    };
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCredential({
          expires: now + 60 * 60 * 1000,
          accountId: "acct-process-env",
        }),
      ),
      undefined,
    );
    await writeRawAuthStore(
      path.join(injectedStateDir, "agents", "main", "agent"),
      storeWith(
        profileId,
        oauthCredential({
          access: "main-access",
          refresh: "main-refresh",
          expires: now + 60 * 60 * 1000,
          accountId: "acct-injected-env",
        }),
      ),
    );
    const childAgentDir = path.join(injectedStateDir, "agents", "telegram", "agent");
    await writeRawAuthStore(
      childAgentDir,
      storeWith(
        profileId,
        oauthCredential({
          access: "child-access",
          refresh: "child-refresh",
          expires: now - 60_000,
          accountId: "acct-injected-env",
        }),
      ),
    );

    const hits = await scanStaleOAuthProfileShadows({
      cfg: {} satisfies OpenClawConfig,
      env: injectedEnv,
      now,
    });

    expect(hits).toEqual([
      expect.objectContaining({
        authPath: resolveAuthStorePath(childAgentDir),
        profileId,
      }),
    ]);
  });

  it("leaves legacy sidecar-backed OAuth profiles for the sidecar migration repair", async () => {
    const profileId = "openai-codex:default";
    const now = Date.now();
    const childAgentDir = path.join(stateDir, "agents", "telegram", "agent");
    await writeRawAuthStore(childAgentDir, {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai-codex",
          accountId: "acct-shared",
          expires: now - 60_000,
          oauthRef: {
            source: "openclaw-credentials",
            provider: "openai-codex",
            id: "0123456789abcdef0123456789abcdef",
          },
        },
      },
    });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCredential({
          provider: "openai-codex",
          access: "main-access",
          refresh: "main-refresh",
          expires: now + 60 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
    );

    const hits = await scanStaleOAuthProfileShadows({
      cfg: {} satisfies OpenClawConfig,
      now,
    });
    const repair = await repairStaleOAuthProfileShadows({
      cfg: {} satisfies OpenClawConfig,
      now,
    });

    expect(hits).toEqual([]);
    expect(repair).toEqual({ changes: [], warnings: [] });
    const raw = JSON.parse(await fs.readFile(resolveAuthStorePath(childAgentDir), "utf8")) as {
      profiles: Record<string, { oauthRef?: unknown }>;
    };
    expect(raw.profiles[profileId]?.oauthRef).toBeDefined();
  });

  it("removes stale child OAuth shadows and local cooldown state", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const childAgentDir = path.join(stateDir, "agents", "telegram", "agent");
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCredential({
          access: "main-access",
          refresh: "main-refresh",
          expires: now + 60 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
      undefined,
    );
    await writeRawAuthStore(childAgentDir, {
      ...storeWith(
        profileId,
        oauthCredential({
          access: "child-access",
          refresh: "child-refresh",
          expires: now - 60_000,
          accountId: "acct-shared",
        }),
      ),
      order: { anthropic: [profileId] },
      lastGood: { anthropic: profileId },
      usageStats: {
        [profileId]: {
          cooldownReason: "auth",
          failureCounts: { auth: 2 },
        },
      },
    });

    const result = await repairStaleOAuthProfileShadows({
      cfg: { agents: { list: [{ id: "telegram" }] } } satisfies OpenClawConfig,
      now,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain(
      "Removed stale OAuth auth profile shadow anthropic:default",
    );
    const childStore = loadPersistedAuthProfileStore(childAgentDir);
    expect(childStore?.profiles[profileId]).toBeUndefined();
    expect(childStore?.usageStats?.[profileId]).toBeUndefined();
    expect(childStore?.order?.anthropic).toBeUndefined();
    expect(childStore?.lastGood?.anthropic).toBeUndefined();
  });

  it("does not remove a child OAuth profile for a different account", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const childAgentDir = path.join(stateDir, "agents", "telegram", "agent");
    await writeRawAuthStore(
      childAgentDir,
      storeWith(
        profileId,
        oauthCredential({
          expires: now - 60_000,
          accountId: "acct-child",
        }),
      ),
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCredential({
          expires: now + 60 * 60 * 1000,
          accountId: "acct-main",
        }),
      ),
    );

    const result = await repairStaleOAuthProfileShadows({
      cfg: {} satisfies OpenClawConfig,
      now,
    });

    expect(result.changes).toEqual([]);
    expect(loadPersistedAuthProfileStore(childAgentDir)?.profiles[profileId]).toBeDefined();
  });

  it("keeps a newer child OAuth profile", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const childAgentDir = path.join(stateDir, "agents", "telegram", "agent");
    await writeRawAuthStore(
      childAgentDir,
      storeWith(
        profileId,
        oauthCredential({
          expires: now + 60 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCredential({
          expires: now + 30 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
    );

    const result = await repairStaleOAuthProfileShadows({
      cfg: {} satisfies OpenClawConfig,
      now,
    });

    expect(result.changes).toEqual([]);
    expect(loadPersistedAuthProfileStore(childAgentDir)?.profiles[profileId]).toBeDefined();
  });

  it("rechecks stale OAuth shadows against the locked store before removal", () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const result = __testing.removeStaleProfilesFromStore({
      store: storeWith(
        profileId,
        oauthCredential({
          expires: now + 60 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
      mainStore: storeWith(
        profileId,
        oauthCredential({
          expires: now + 30 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
      profileIds: new Set([profileId]),
      now,
    });

    expect(result.removedProfileIds).toEqual([]);
    expect(result.store.profiles[profileId]).toBeDefined();
  });

  it("does not recreate a child auth store that disappeared before repair", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const childAgentDir = path.join(stateDir, "agents", "telegram", "agent");
    const repair = await __testing.repairStaleOAuthProfilesForAgent({
      agentDir: childAgentDir,
      mainStore: storeWith(
        profileId,
        oauthCredential({
          expires: now + 60 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
      profileIds: new Set([profileId]),
      now,
    });

    expect(repair.status).toBe("missing");
    await expect(fs.stat(resolveAuthStorePath(childAgentDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
