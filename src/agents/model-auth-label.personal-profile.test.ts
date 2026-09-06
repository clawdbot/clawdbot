import { describe, expect, it } from "vitest";
import {
  connectUserModelAccount,
  updateUserModelAuthProfile,
} from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { resolveModelAuthLabel } from "./model-auth-label.js";

describe("personal account auth labels", () => {
  it.each([false, true])(
    "describes the selected account without private metadata (external profiles: %s)",
    async (includeExternalProfiles) => {
      await withOpenClawTestState(
        { layout: "home", prefix: "auth-label-personal-" },
        async (state) => {
          const owner = ensureProfileForEmail("person@example.test");
          const { authProfileId } = connectUserModelAccount({
            ownerProfileId: owner.id,
            credential: {
              type: "api_key",
              provider: "personal-provider",
              key: "synthetic-personal-key",
              email: "private-provider@example.test",
              displayName: "Private provider label",
            },
            assertCurrent() {},
          });
          const blocked = {
            disabledUntil: Date.now() + 600_000,
            disabledReason: "auth_permanent" as const,
          };
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "personal-provider:shared": {
                type: "api_key",
                provider: "personal-provider",
                key: "synthetic-shared-key",
              },
            },
            usageStats: includeExternalProfiles ? {} : { "personal-provider:shared": blocked },
          });
          if (includeExternalProfiles) {
            updateUserModelAuthProfile(authProfileId, (account) => {
              account.usageStats = blocked;
              return true;
            });
          }
          const params = {
            provider: "personal-provider",
            cfg: { plugins: { enabled: false } },
            agentDir: state.agentDir(),
            includeExternalProfiles,
          };

          expect(
            resolveModelAuthLabel({
              ...params,
              sessionEntry: { authProfileOverride: authProfileId },
            }),
          ).toBe("api-key (personal account)");
          expect(resolveModelAuthLabel(params)).toBe("api-key (personal-provider:shared)");
          expect(
            resolveModelAuthLabel({
              ...params,
              sessionEntry: {
                authProfileOverride: `personal:${owner.id}:00000000-0000-0000-0000-000000000000`,
              },
            }),
          ).toBe("api-key (personal-provider:shared)");
          expect(
            resolveModelAuthLabel({
              ...params,
              provider: "other-provider",
              sessionEntry: { authProfileOverride: authProfileId },
            }),
          ).toBe("unknown");
          expect(ensureAuthProfileStore(state.agentDir()).profiles).not.toHaveProperty(
            authProfileId,
          );
        },
      );
    },
  );
});
