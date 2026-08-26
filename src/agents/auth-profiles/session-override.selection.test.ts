import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  authStoreMocks,
  createAuthStoreWithProfiles,
  resolveSessionAuthSelection,
  TEST_PRIMARY_PROFILE_ID,
  TEST_SECONDARY_PROFILE_ID,
  withAuthState,
} from "./session-override.test-support.js";

const OAUTH_PROFILE_ID = "openai:subscription";
const SESSION_KEY = "agent:main:main";

function configureProfiles(): void {
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = createAuthStoreWithProfiles({
    profiles: {
      [TEST_PRIMARY_PROFILE_ID]: {
        type: "api_key",
        provider: "openai",
        key: "sk-primary",
      },
      [TEST_SECONDARY_PROFILE_ID]: {
        type: "api_key",
        provider: "openai",
        key: "sk-secondary",
      },
      [OAUTH_PROFILE_ID]: {
        type: "oauth",
        provider: "openai",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 60_000,
      },
    },
    order: { openai: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID, OAUTH_PROFILE_ID] },
  });
}

async function select(params: {
  agentDir: string;
  sessionEntry: SessionEntry;
  configuredProfileId?: string;
  modelId?: string;
}) {
  return await resolveSessionAuthSelection({
    cfg: {} as OpenClawConfig,
    provider: "openai",
    modelId: params.modelId ?? "gpt-5.6-sol",
    ...(params.configuredProfileId ? { configuredProfileId: params.configuredProfileId } : {}),
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
    sessionStore: { [SESSION_KEY]: params.sessionEntry },
    sessionKey: SESSION_KEY,
    isNewSession: false,
  });
}

describe("session auth selection prepared facts", () => {
  it("returns prepared facts for a user pin", async () => {
    await withAuthState(async (state) => {
      configureProfiles();
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
      };

      await expect(select({ agentDir: state.agentDir(), sessionEntry })).resolves.toEqual({
        profileId: TEST_PRIMARY_PROFILE_ID,
        source: "user",
        routeRequirement: "api-key",
      });
    });
  });

  it("returns prepared facts after automatic rotation", async () => {
    await withAuthState(async (state) => {
      configureProfiles();
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        model: "gpt-5.6-sol",
        compactionCount: 1,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      };

      await expect(select({ agentDir: state.agentDir(), sessionEntry })).resolves.toEqual({
        profileId: TEST_SECONDARY_PROFILE_ID,
        source: "auto",
        routeRequirement: "api-key",
      });
    });
  });

  it("uses only explicit configured-profile precedence", async () => {
    await withAuthState(async (state) => {
      configureProfiles();
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        compactionCount: 0,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      };

      await expect(
        select({
          agentDir: state.agentDir(),
          sessionEntry,
          modelId: `gpt-5.6-sol@${OAUTH_PROFILE_ID}`,
        }),
      ).resolves.toMatchObject({ profileId: TEST_PRIMARY_PROFILE_ID, source: "auto" });
      await expect(
        select({
          agentDir: state.agentDir(),
          sessionEntry,
          configuredProfileId: OAUTH_PROFILE_ID,
        }),
      ).resolves.toEqual({
        profileId: OAUTH_PROFILE_ID,
        source: "user",
        routeRequirement: "subscription",
      });
    });
  });
});
