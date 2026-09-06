import { describe, expect, it, vi } from "vitest";
import {
  connectUserModelAccount,
  updateUserModelAuthProfile,
} from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

describe("personal account fallback admission", () => {
  it.each(["shared-blocked", "personal-blocked"] as const)(
    "checks the selected credential's cooldown with %s",
    async (scenario) => {
      await withOpenClawTestState(
        { layout: "home", prefix: "fallback-personal-" },
        async (state) => {
          const profile = ensureProfileForEmail("alice@example.test");
          const { authProfileId } = connectUserModelAccount({
            ownerProfileId: profile.id,
            credential: { type: "api_key", provider: "personal-provider", key: "synthetic-key" },
            assertCurrent() {},
          });
          const blocked = {
            disabledUntil: Date.now() + 600_000,
            disabledReason: "auth_permanent" as const,
          };
          if (scenario === "shared-blocked") {
            await state.writeAuthProfiles({
              version: 1,
              profiles: {
                "personal-provider:shared": {
                  type: "api_key",
                  provider: "personal-provider",
                  key: "synthetic-shared-key",
                },
              },
              usageStats: { "personal-provider:shared": blocked },
            });
          } else {
            updateUserModelAuthProfile(authProfileId, (account) => {
              account.usageStats = blocked;
              return true;
            });
          }
          const run = vi.fn(async (provider: string) => provider);
          const result = await runWithModelFallback({
            cfg: { plugins: { enabled: false } },
            agentDir: state.agentDir(),
            provider: "personal-provider",
            model: "test-model",
            fallbacksOverride: ["backup-provider/test-model"],
            userLockedAuthProfileId: authProfileId,
            manifestPlugins: [],
            run,
          });

          const expected = scenario === "shared-blocked" ? "personal-provider" : "backup-provider";
          expect(result.result).toBe(expected);
          expect(run.mock.calls.map(([provider]) => provider)).toEqual([expected]);
          expect(ensureAuthProfileStore(state.agentDir()).profiles).not.toHaveProperty(
            authProfileId,
          );
        },
      );
    },
  );
});
