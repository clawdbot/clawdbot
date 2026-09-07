import fs from "node:fs/promises";
import { afterEach, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ProviderModelRouteAuthRequirement,
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
} from "../../plugin-sdk/provider-model-types.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { AuthProfileStore } from "./types.js";

export const TEST_PRIMARY_PROFILE_ID = "openai:primary@example.test";
export const TEST_SECONDARY_PROFILE_ID = "openai:secondary@example.test";

const authStoreMocks = vi.hoisted(() => {
  const state: {
    hasSource: boolean;
    routeResolutions: Map<string, ProviderModelRouteResolution>;
    store: AuthProfileStore;
  } = {
    hasSource: false,
    routeResolutions: new Map(),
    store: { version: 1, profiles: {} },
  };
  return {
    state,
    ensureAuthProfileStore: vi.fn(() => state.store),
    hasAnyAuthProfileStoreSource: vi.fn(() => state.hasSource),
    isProfileInCooldown: vi.fn((_store: AuthProfileStore, _profileId: string) => false),
    resolveProviderModelRoutes: vi.fn(
      ({ provider, modelId }: { provider: string; modelId?: string }) =>
        state.routeResolutions.get(`${provider}\0${modelId ?? ""}`) ?? null,
    ),
    reset() {
      state.hasSource = false;
      state.routeResolutions.clear();
      state.store = { version: 1, profiles: {} };
    },
  };
});

vi.mock("./store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store.js")>()),
  getRuntimeAuthProfileStoreSnapshot: () => authStoreMocks.state.store,
  findPersistedAuthProfileCredential: ({ profileId }: { profileId: string }) =>
    authStoreMocks.state.store.profiles[profileId],
  hasAnyAuthProfileStoreSource: authStoreMocks.hasAnyAuthProfileStoreSource,
}));
vi.mock("./store-runtime.js", () => ({
  ensureAuthProfileStore: authStoreMocks.ensureAuthProfileStore,
}));

vi.mock("./usage.js", () => ({
  isProfileInCooldown: authStoreMocks.isProfileInCooldown,
}));

vi.mock("../../plugins/provider-model-routes.js", () => ({
  resolveProviderModelRoutes: authStoreMocks.resolveProviderModelRoutes,
}));

export const { clearSessionAuthProfileOverride, resolveSessionAuthSelection } =
  await import("./session-override.js");
export { authStoreMocks };

afterEach(() => {
  authStoreMocks.reset();
  vi.clearAllMocks();
});

export async function withAuthState<T>(run: (state: OpenClawTestState) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-auth-",
    },
    run,
  );
}

export function createAuthStoreWithProfiles(params: {
  profiles: AuthProfileStore["profiles"];
  order?: Record<string, string[]>;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: params.profiles,
    ...(params.order ? { order: params.order } : {}),
  };
}

export function configureProviderRoutes(params: {
  provider: string;
  modelId: string;
  requirements: ProviderModelRouteAuthRequirement[];
}): void {
  const routes = params.requirements.map<ProviderModelRouteCandidate>((authRequirement, index) => ({
    api: authRequirement === "api-key" ? "openai-responses" : "openai-chatgpt-responses",
    baseUrl: `https://route-${index}.example.test`,
    authRequirement,
    requestTransportOverrides: "none",
  }));
  const first = routes[0];
  if (!first) {
    return;
  }
  authStoreMocks.state.routeResolutions.set(`${params.provider}\0${params.modelId}`, {
    kind: "routes",
    routes: [first, ...routes.slice(1)],
  });
}

export async function prepareCooldownAuthState(
  state: OpenClawTestState,
  options: {
    profileIds?: string[];
    usageStats?: AuthProfileStore["usageStats"];
  } = {},
): Promise<string> {
  const agentDir = state.agentDir();
  await fs.mkdir(agentDir, { recursive: true });
  authStoreMocks.state.hasSource = true;
  const profileIds = options.profileIds ?? [TEST_PRIMARY_PROFILE_ID];
  authStoreMocks.state.store = {
    ...createAuthStoreWithProfiles({
      profiles: Object.fromEntries(
        profileIds.map((profileId) => [
          profileId,
          { type: "api_key" as const, provider: "openai", key: "sk-test" },
        ]),
      ),
      order: { openai: profileIds },
    }),
    ...(options.usageStats ? { usageStats: options.usageStats } : {}),
  };
  authStoreMocks.isProfileInCooldown.mockReturnValue(true);
  return agentDir;
}

export async function resolveSession(params: {
  agentDir: string;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  provider?: string;
  sessionKey?: string;
  storePath?: string;
  isNewSession?: boolean;
}): Promise<string | undefined> {
  return (
    await resolveSessionAuthSelection({
      cfg: params.cfg ?? ({} as OpenClawConfig),
      provider: params.provider ?? "openai",
      modelId: params.sessionEntry.model ?? "model-x",
      agentDir: params.agentDir,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey ?? "agent:main:main",
      storePath: params.storePath,
      isNewSession: params.isNewSession ?? false,
    })
  )?.profileId;
}

export function createAutomaticSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: 1,
    authProfileOverride: TEST_PRIMARY_PROFILE_ID,
    authProfileOverrideSource: "auto",
    ...overrides,
  };
}
