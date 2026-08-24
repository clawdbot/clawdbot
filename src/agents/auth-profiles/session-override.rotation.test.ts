import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  authStoreMocks,
  configureProviderRoutes,
  createAutomaticSessionEntry,
  prepareCooldownAuthState,
  resolveSession,
  TEST_PRIMARY_PROFILE_ID,
  TEST_SECONDARY_PROFILE_ID,
  withAuthState,
} from "./session-override.test-support.js";
import type { AuthProfileStore } from "./types.js";

const OPENAI_MODEL_ID = "gpt-5.6-sol";
const API_PRIMARY_PROFILE_ID = "openai:api-primary";
const API_BACKUP_PROFILE_ID = "openai:api-backup";
const OAUTH_PROFILE_ID = "openai:subscription";
const ANTHROPIC_API_PROFILE_ID = "anthropic:api";
const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";

type RotationTrigger = "compaction" | "cooldown";

function configureMixedOpenAiAuthStore(): void {
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = {
    version: 1,
    profiles: {
      [API_PRIMARY_PROFILE_ID]: {
        type: "api_key",
        provider: "openai",
        key: "sk-primary",
      },
      [API_BACKUP_PROFILE_ID]: {
        type: "api_key",
        provider: "openai",
        key: "sk-backup",
      },
      [OAUTH_PROFILE_ID]: {
        type: "oauth",
        provider: "openai",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 60_000,
      },
    },
    order: {
      openai: [API_PRIMARY_PROFILE_ID, OAUTH_PROFILE_ID, API_BACKUP_PROFILE_ID],
    },
  };
}

function configureAnthropicFallbackStore(): void {
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = {
    version: 1,
    profiles: {
      [ANTHROPIC_API_PROFILE_ID]: {
        type: "api_key",
        provider: "anthropic",
        key: "sk-anthropic",
      },
      [CLAUDE_CLI_PROFILE_ID]: {
        type: "oauth",
        provider: "claude-cli",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 60_000,
      },
    },
    order: {
      anthropic: [ANTHROPIC_API_PROFILE_ID, CLAUDE_CLI_PROFILE_ID],
    },
  };
}

function createTriggeredSessionEntry(params: {
  profileId: string;
  model: string;
  trigger: RotationTrigger;
}): SessionEntry {
  if (params.trigger === "cooldown") {
    authStoreMocks.isProfileInCooldown.mockImplementation(
      (_store: AuthProfileStore, profileId: string) => profileId === params.profileId,
    );
  }
  return createAutomaticSessionEntry({
    model: params.model,
    authProfileOverride: params.profileId,
    compactionCount: params.trigger === "compaction" ? 1 : 0,
    authProfileOverrideCompactionCount: 0,
  });
}

describe("session auth-profile rotation", () => {
  it.each(["compaction", "cooldown"] as const)(
    "keeps a multi-route OpenAI session on its physical route after %s",
    async (trigger) => {
      await withAuthState(async (state) => {
        const agentDir = state.agentDir();
        await fs.mkdir(agentDir, { recursive: true });
        configureMixedOpenAiAuthStore();
        configureProviderRoutes({
          provider: "openai",
          modelId: OPENAI_MODEL_ID,
          requirements: ["api-key", "subscription"],
        });
        const sessionEntry = createTriggeredSessionEntry({
          profileId: API_PRIMARY_PROFILE_ID,
          model: OPENAI_MODEL_ID,
          trigger,
        });
        const sessionStore = { "agent:main:main": sessionEntry };

        const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

        expect(resolved).toBe(API_BACKUP_PROFILE_ID);
        expect(sessionEntry.authProfileOverride).toBe(API_BACKUP_PROFILE_ID);
        expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      });
    },
  );

  it.each(["compaction", "cooldown"] as const)(
    "retains Anthropic API-key to Claude CLI OAuth fallback after %s",
    async (trigger) => {
      await withAuthState(async (state) => {
        const agentDir = state.agentDir();
        await fs.mkdir(agentDir, { recursive: true });
        configureAnthropicFallbackStore();
        const sessionEntry = createTriggeredSessionEntry({
          profileId: ANTHROPIC_API_PROFILE_ID,
          model: "claude-sonnet-4-6",
          trigger,
        });
        const sessionStore = { "agent:main:main": sessionEntry };

        const resolved = await resolveSession({
          provider: "anthropic",
          agentDir,
          sessionEntry,
          sessionStore,
        });

        expect(resolved).toBe(CLAUDE_CLI_PROFILE_ID);
        expect(sessionEntry.authProfileOverride).toBe(CLAUDE_CLI_PROFILE_ID);
      });
    },
  );

  it("retains mixed-mode rotation when the provider exposes only one route", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      configureMixedOpenAiAuthStore();
      configureProviderRoutes({
        provider: "openai",
        modelId: OPENAI_MODEL_ID,
        requirements: ["api-key"],
      });
      const sessionEntry = createTriggeredSessionEntry({
        profileId: API_PRIMARY_PROFILE_ID,
        model: OPENAI_MODEL_ID,
        trigger: "compaction",
      });
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(OAUTH_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(OAUTH_PROFILE_ID);
    });
  });

  it("rotates an automatic override to an auth profile that is not in cooldown", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        profileIds: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
      });
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (_store: AuthProfileStore, profileId: string) => profileId === TEST_PRIMARY_PROFILE_ID,
      );
      const sessionEntry = createAutomaticSessionEntry();
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });

  it("keeps an automatic override after its auth-profile cooldown expires", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        usageStats: { [TEST_PRIMARY_PROFILE_ID]: { cooldownUntil: Date.now() - 1 } },
      });
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (store: AuthProfileStore, profileId: string) =>
          (store.usageStats?.[profileId]?.cooldownUntil ?? 0) > Date.now(),
      );
      const sessionEntry = createAutomaticSessionEntry({ authProfileOverrideCompactionCount: 0 });
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.updatedAt).toBe(1);
    });
  });
});
