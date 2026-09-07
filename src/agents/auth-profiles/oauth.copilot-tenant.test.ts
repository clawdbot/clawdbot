/** Local production-store proofs; provider refresh success/failure is simulated. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { ensureAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } from "./store.js";
import type { OAuthCredential } from "./types.js";

const profileId = "github-copilot:default";
const credential = (enterpriseUrl: string, access: string, expires: number): OAuthCredential => ({
  type: "oauth",
  provider: "github-copilot",
  enterpriseUrl,
  access,
  refresh: access,
  expires,
});

beforeEach(() => {
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});
afterEach(() => {
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

async function withStores(run: (agentDir: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "copilot-tenant-")));
  const agentDir = path.join(root, "agents", "child", "agent");
  try {
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: root, OPENCLAW_AGENT_DIR: path.join(root, "agents", "main", "agent") },
      async () => {
        await fs.mkdir(agentDir, { recursive: true });
        await run(agentDir);
      },
    );
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function save(cred: OAuthCredential, agentDir?: string) {
  saveAuthProfileStore({ version: 1, profiles: { [profileId]: cred } }, agentDir);
}
function read(agentDir?: string) {
  return loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
}
function manager(refreshCredential: Parameters<typeof createOAuthManager>[0]["refreshCredential"]) {
  return createOAuthManager({
    buildApiKey: async (_provider, cred) => cred.access,
    refreshCredential,
    readBootstrapCredential: () => null,
    isRefreshTokenReusedError: () => false,
  });
}

for (const [label, mainDomain, sameTenant] of [
  ["different tenants", "other.ghe.com", false],
  ["same tenant spelling", "https://acme.ghe.com/", true],
] as const) {
  describe(label, () => {
    it("logout removes only stores that own the selected identity-less credential", async () => {
      await withStores(async (agentDir) => {
        const main = credential(mainDomain, "main-fixture", MAX_DATE_TIMESTAMP_MS);
        save(credential("acme.ghe.com", "child-fixture", MAX_DATE_TIMESTAMP_MS), agentDir);
        save(main);
        expect(
          await removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: [profileId] }),
        ).toBe(true);
        expect(read(agentDir)).toBeUndefined();
        expect(read()).toEqual(sameTenant ? undefined : main);
      });
    });

    it("resolves a newer main credential only for a compatible tenant upgrade", async () => {
      await withStores(async (agentDir) => {
        const local = credential("acme.ghe.com", "child-fixture", Date.now() + 10 * 60_000);
        const main = {
          ...credential(mainDomain, "main-fixture", MAX_DATE_TIMESTAMP_MS),
          accountId: "main-fixture-account",
        };
        save(local, agentDir);
        save(main);
        const refresh = vi.fn(async () => null);
        const result = await manager(refresh).resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: local,
          agentDir,
        });
        expect(result?.apiKey).toBe(sameTenant ? main.access : local.access);
        expect(refresh).not.toHaveBeenCalled();
        expect(read(agentDir)).toEqual(local);
        expect(read()).toEqual(main);
      });
    });

    it("persists local refresh and mirrors only to the matching tenant", async () => {
      await withStores(async (agentDir) => {
        const local = credential("acme.ghe.com", "child-fixture", Date.now() - 60_000);
        const main = credential(mainDomain, "main-fixture", local.expires - 60_000);
        const refreshed = {
          ...local,
          access: "refreshed-fixture",
          refresh: "rotated-fixture",
          expires: MAX_DATE_TIMESTAMP_MS,
        };
        save(local, agentDir);
        save(main);
        const refresh = vi.fn(async (input: OAuthCredential) => {
          expect(input).toEqual(local);
          return refreshed;
        });
        const result = await manager(refresh).resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: local,
          agentDir,
        });
        expect(result?.apiKey).toBe(refreshed.access);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(read(agentDir)).toEqual(refreshed);
        expect(read()).toEqual(sameTenant ? refreshed : main);
      });
    });

    it("recovers a failed refresh from concurrently renewed main auth only for the same tenant", async () => {
      await withStores(async (agentDir) => {
        const local = credential("acme.ghe.com", "child-fixture", Date.now() - 60_000);
        const main = credential(mainDomain, "main-fixture", local.expires - 60_000);
        const renewed = { ...main, access: "renewed-fixture", expires: MAX_DATE_TIMESTAMP_MS };
        save(local, agentDir);
        save(main);
        const refresh = vi.fn(async () => {
          save(renewed);
          throw new Error("simulated provider refresh failure");
        });
        const result = manager(refresh).resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: local,
          agentDir,
        });
        if (sameTenant) {
          await expect(result).resolves.toMatchObject({ apiKey: renewed.access });
        } else {
          await expect(result).rejects.toThrow("OAuth token refresh failed");
        }
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(read(agentDir)).toEqual(local);
        expect(read()).toEqual(renewed);
      });
    });
  });
}
