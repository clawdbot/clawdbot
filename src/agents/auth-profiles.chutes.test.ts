/**
 * Chutes auth profile integration tests.
 * Verifies expired OAuth profiles refresh through the generic provider seam
 * while preserving the shared auth-profile store contracts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { AuthProfileStore } from "./auth-profiles.js";

type ResolveProviderOAuthCredentialWithPlugin =
  typeof import("../plugins/provider-runtime.runtime.js").resolveProviderOAuthCredentialWithPlugin;

const { resolveProviderOAuthCredentialWithPluginMock } = vi.hoisted(() => ({
  resolveProviderOAuthCredentialWithPluginMock: vi.fn<ResolveProviderOAuthCredentialWithPlugin>(),
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  buildProviderAuthDoctorHintWithPlugin: async () => undefined,
  formatProviderAuthProfileApiKeyWithPlugin: async () => undefined,
  resolveProviderOAuthCredentialWithPlugin: resolveProviderOAuthCredentialWithPluginMock,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

afterAll(() => {
  vi.doUnmock("../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../plugins/provider-runtime.js");
});

let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles.js").clearRuntimeAuthProfileStoreSnapshots;
let ensureAuthProfileStore: typeof import("./auth-profiles.js").ensureAuthProfileStore;
let loadPersistedAuthProfileStore: typeof import("./auth-profiles/persisted.js").loadPersistedAuthProfileStore;
let resolveApiKeyForProfile: typeof import("./auth-profiles.js").resolveApiKeyForProfile;
let resetFileLockStateForTest: typeof import("../infra/file-lock.js").resetFileLockStateForTest;

describe("auth-profiles (chutes)", () => {
  beforeAll(async () => {
    ({ clearRuntimeAuthProfileStoreSnapshots, ensureAuthProfileStore, resolveApiKeyForProfile } =
      await import("./auth-profiles.js"));
    ({ loadPersistedAuthProfileStore } = await import("./auth-profiles/persisted.js"));
    ({ resetFileLockStateForTest } = await import("../infra/file-lock.js"));
  });

  beforeEach(() => {
    resolveProviderOAuthCredentialWithPluginMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
    resetFileLockStateForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearRuntimeAuthProfileStoreSnapshots();
    resetFileLockStateForTest();
  });

  it("refreshes expired Chutes OAuth credentials", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-chutes-",
        agentEnv: "main",
      },
      async (state) => {
        const storedCredential = {
          type: "oauth" as const,
          provider: "chutes",
          access: "at_old",
          refresh: "rt_old",
          expires: Date.now() - 60_000,
          clientId: "cid_test",
        };
        const store: AuthProfileStore = {
          version: 1,
          profiles: {
            "chutes:default": storedCredential,
          },
        };
        await state.writeAuthProfiles(store);
        const refreshedCredential = {
          ...storedCredential,
          access: "at_new",
          refresh: "rt_new",
          expires: Date.now() + 3_600_000,
        };
        resolveProviderOAuthCredentialWithPluginMock.mockResolvedValue({
          status: "available",
          credential: refreshedCredential,
          apiKey: refreshedCredential.access,
        });
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        const loaded = ensureAuthProfileStore();
        const resolved = await resolveApiKeyForProfile({
          store: loaded,
          profileId: "chutes:default",
        });

        expect(resolved?.apiKey).toBe("at_new");
        expect(resolveProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
        expect(resolveProviderOAuthCredentialWithPluginMock).toHaveBeenCalledWith({
          provider: "chutes",
          config: undefined,
          credential: storedCredential,
          refresh: true,
        });
        expect(fetchSpy).not.toHaveBeenCalled();

        const persisted = loadPersistedAuthProfileStore(state.agentDir());
        expect(persisted?.profiles["chutes:default"]).toEqual(refreshedCredential);
      },
    );
  });
});
