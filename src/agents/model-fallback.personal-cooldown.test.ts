import { describe, expect, it } from "vitest";
import {
  connectUserModelAccount,
  updateUserModelAuthProfile,
} from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import { isFallbackSummaryError } from "./model-fallback-attempt.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

describe("personal account fallback cooldown summaries", () => {
  it.each([false, true])(
    "refreshes selected cooldown with authored order=%s",
    async (authoredOrder) => {
      await withOpenClawTestState(
        { layout: "home", prefix: "fallback-personal-expiry-" },
        async (state) => {
          const person = ensureProfileForEmail("alice@example.test");
          const { authProfileId } = connectUserModelAccount({
            ownerProfileId: person.id,
            credential: { type: "api_key", provider: "personal-provider", key: "synthetic-key" },
            assertCurrent() {},
          });
          const expiry = Date.now() + 120_000;
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "personal-provider:shared": {
                type: "api_key",
                provider: "personal-provider",
                key: "synthetic-shared-key",
              },
            },
            usageStats: {
              "personal-provider:shared": {
                cooldownUntil: expiry + 600_000,
                cooldownReason: "rate_limit",
              },
            },
          });
          const attempted: string[] = [];
          let failure: unknown;
          try {
            await runWithModelFallback({
              cfg: {
                plugins: { enabled: false },
                ...(authoredOrder
                  ? { auth: { order: { "personal-provider": ["personal-provider:shared"] } } }
                  : {}),
              },
              agentDir: state.agentDir(),
              provider: "personal-provider",
              model: "test-model",
              fallbacksOverride: ["backup-provider/test-model"],
              userLockedAuthProfileId: authProfileId,
              manifestPlugins: [],
              run: async (provider) => {
                attempted.push(provider);
                if (provider === "personal-provider") {
                  updateUserModelAuthProfile(authProfileId, (account) => {
                    account.usageStats = {
                      cooldownUntil: expiry,
                      cooldownReason: "rate_limit",
                      cooldownModel: "test-model",
                    };
                    return true;
                  });
                }
                throw Object.assign(new Error("synthetic rate limit"), { status: 429 });
              },
            });
          } catch (error) {
            failure = error;
          }
          expect(attempted).toEqual(["personal-provider", "backup-provider"]);
          expect(isFallbackSummaryError(failure)).toBe(true);
          if (!isFallbackSummaryError(failure)) {
            throw failure;
          }
          expect(failure.soonestCooldownExpiry).toBe(expiry);
          expect(ensureAuthProfileStore(state.agentDir()).profiles).not.toHaveProperty(
            authProfileId,
          );
        },
      );
    },
  );
});
