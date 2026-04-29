import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { CHUTES_TOKEN_ENDPOINT } from "./chutes-oauth.js";

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: async () => undefined,
  refreshProviderOAuthCredentialWithPlugin: async () => null,
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
let resolveApiKeyForProfile: typeof import("./auth-profiles.js").resolveApiKeyForProfile;
let resetFileLockStateForTest: typeof import("../infra/file-lock.js").resetFileLockStateForTest;

describe("auth-profiles (chutes)", () => {
  beforeAll(async () => {
    ({ clearRuntimeAuthProfileStoreSnapshots, ensureAuthProfileStore, resolveApiKeyForProfile } =
      await import("./auth-profiles.js"));
    ({ resetFileLockStateForTest } = await import("../infra/file-lock.js"));
  });

  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    resetFileLockStateForTest();
  });

  afterEach(async () => {
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
        env: {
          CHUTES_CLIENT_ID: undefined,
        },
      },
      async (state) => {
        const store: AuthProfileStore = {
          version: 1,
          profiles: {
            "chutes:default": {
              type: "oauth",
              provider: "chutes",
              access: "at_old",
              refresh: "rt_old",
              expires: Date.now() - 60_000,
              clientId: "cid_test",
            },
          },
        };
        const authProfilePath = await state.writeAuthProfiles(store);

        const fetchSpy = vi.fn(async (input: string | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url !== CHUTES_TOKEN_ENDPOINT) {
            return new Response("not found", { status: 404 });
          }
          return new Response(
            JSON.stringify({
              access_token: "at_new",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        });
        vi.stubGlobal("fetch", fetchSpy);

        const loaded = ensureAuthProfileStore();
        const resolved = await resolveApiKeyForProfile({
          store: loaded,
          profileId: "chutes:default",
        });

        expect(resolved?.apiKey).toBe("at_new");
        expect(fetchSpy).toHaveBeenCalled();

        const persisted = JSON.parse(await fs.readFile(authProfilePath, "utf8")) as {
          profiles?: Record<string, { access?: string }>;
        };
        expect(persisted.profiles?.["chutes:default"]?.access).toBe("at_new");
      },
    );
  });
});
