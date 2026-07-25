import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import "./stale-oauth-profile-shadows.js";

type TestApi = {
  removeStaleProfilesFromStore(params: {
    store: AuthProfileStore;
    mainStore: AuthProfileStore;
    profileIds: Set<string>;
    now: number;
  }): { store: AuthProfileStore; removedProfileIds: string[] };
  repairStaleOAuthProfilesForAgent(params: {
    agentDir: string;
    mainStore: AuthProfileStore;
    profileIds: Set<string>;
    now: number;
  }): Promise<
    { status: "changed"; removedProfileIds: string[] } | { status: "missing" | "unchanged" }
  >;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.staleOAuthProfileShadowsTestApi")
  ] as TestApi;
}

export const testing: TestApi = {
  removeStaleProfilesFromStore(params) {
    return getTestApi().removeStaleProfilesFromStore(params);
  },
  repairStaleOAuthProfilesForAgent(params) {
    return getTestApi().repairStaleOAuthProfilesForAgent(params);
  },
};
