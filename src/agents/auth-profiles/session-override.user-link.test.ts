import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyMixedDirectives } from "../../auto-reply/reply/directive-handling.mixed-inline.test-helpers.js";
import { createModelSelectionState } from "../../auto-reply/reply/model-selection.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  setUserProfileAuthLink,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveSessionAuthSelection } from "./session-override.js";

const DEFAULT_PROFILE_ID = "openai:shared";
const SESSION_KEY = "agent:main:main";

function connectAccount(profileId: string, label: string): string {
  return connectUserModelAccount({
    ownerProfileId: profileId,
    credential: {
      type: "oauth",
      provider: "openai",
      access: `synthetic-${label}-access`,
      refresh: `synthetic-${label}-refresh`,
      expires: Date.now() + 600_000,
    },
    assertCurrent() {},
  }).authProfileId;
}

async function selectForRequester(
  state: OpenClawTestState,
  sessionEntry: SessionEntry,
  requesterProfileId?: string,
  isNewSession = true,
) {
  const sessionStore = { [SESSION_KEY]: sessionEntry };
  const model = await createModelSelectionState({
    cfg: {},
    agentId: "main",
    agentCfg: undefined,
    sessionEntry,
    sessionStore,
    sessionKey: SESSION_KEY,
    defaultProvider: "openai",
    defaultModel: "gpt-5.6-luna",
    provider: "openai",
    model: "gpt-5.6-luna",
    hasModelDirective: false,
  });
  return resolveSessionAuthSelection({
    cfg: {},
    provider: model.provider,
    modelId: model.model,
    agentDir: state.agentDir(),
    sessionEntry,
    sessionStore,
    sessionKey: SESSION_KEY,
    isNewSession,
    requesterProfileId,
  });
}

function withAuthState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", prefix: "personal-session-auth-" }, run);
}

describe("person-linked session auth", () => {
  it.each(
    ["owner", "another person", "unidentified"].flatMap((requester) => [
      { requester, form: "model-only", prefix: "" },
      { requester, form: "mixed", prefix: "hello " },
    ]),
  )(
    "checks credential ownership for a fresh $form personal account directive from $requester",
    async ({ requester, prefix }) => {
      await withAuthState(async (state) => {
        const alice = ensureProfileForEmail("alice@example.test");
        const bob = ensureProfileForEmail("bob@example.test");
        const personalId = connectAccount(alice.id, "alice");
        clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });
        const requesterProfileId =
          requester === "owner" ? alice.id : requester === "another person" ? bob.id : undefined;
        const ctx: MsgContext = {};
        if (requesterProfileId) {
          prepareSessionParticipantInput(ctx, { type: "profile", id: requesterProfileId });
        }

        const { result, sessionEntry } = await applyMixedDirectives({
          body: `${prefix}/model openai/gpt-5.6-luna@${personalId}`,
          ctx,
          agentDir: state.agentDir(),
          channel: "webchat",
          provider: "openai",
          model: "gpt-5.6-luna",
          allowedModels: [
            { provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true },
          ],
        });

        if (requester === "owner") {
          expect(sessionEntry.authProfileOverride).toBe(personalId);
          expect(sessionEntry.authProfileOverrideSource).toBe("user");
        } else {
          expect(sessionEntry.authProfileOverride).toBeUndefined();
          expect(result).toMatchObject({ kind: "reply", reply: { isError: true } });
        }
      });
    },
  );

  it("applies a personal default only to new sessions when no shared auth store exists", async () => {
    await withAuthState(async (state) => {
      const alice = ensureProfileForEmail("alice@example.test");
      const existing: SessionEntry = { sessionId: "existing-session", updatedAt: 1 };
      await expect(selectForRequester(state, existing, alice.id, false)).resolves.toBeUndefined();

      const personalId = connectAccount(alice.id, "alice");
      await expect(selectForRequester(state, existing, alice.id, false)).resolves.toBeUndefined();
      expect(existing.authProfileOverride).toBeUndefined();
      const sessionEntry: SessionEntry = { sessionId: "alice-session", updatedAt: 1 };

      await expect(selectForRequester(state, sessionEntry, alice.id)).resolves.toEqual({
        profileId: personalId,
        source: "user",
        routeRequirement: "subscription",
      });
      expect(sessionEntry.authProfileOverrideSource).toBe("user-link");
    });
  });

  it.each([
    { label: "configured default", source: undefined },
    { label: "explicit session pin", source: "user" },
    { label: "person-linked session pin", source: "user-link" },
  ] as const)("selects the $label over other personal accounts", async ({ source }) => {
    await withAuthState(async (state) => {
      const configuredOwner = ensureProfileForEmail("configured@example.test");
      const sessionOwner = ensureProfileForEmail("session@example.test");
      const configuredId = connectAccount(configuredOwner.id, "configured");
      const pinnedId = connectAccount(sessionOwner.id, "session");
      const sessionEntry: SessionEntry = {
        sessionId: "configured-personal-session",
        updatedAt: 1,
        ...(source ? { authProfileOverride: pinnedId, authProfileOverrideSource: source } : {}),
      };

      await expect(
        resolveSessionAuthSelection({
          cfg: {},
          provider: "openai",
          modelId: "gpt-5.6-luna",
          configuredProfileId: configuredId,
          agentDir: state.agentDir(),
          sessionEntry,
          sessionStore: { [SESSION_KEY]: sessionEntry },
          sessionKey: SESSION_KEY,
          isNewSession: false,
        }),
      ).resolves.toEqual({
        profileId: source ? pinnedId : configuredId,
        source: "user",
        routeRequirement: "subscription",
      });
    });
  });

  it("keeps personal accounts out of unrelated defaults and retains pins after unlinking", async () => {
    await withAuthState(async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [DEFAULT_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "synthetic-shared-key",
          },
        },
      });
      const alice = ensureProfileForEmail("alice@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      const unlinked = ensureProfileForEmail("unlinked@example.test");
      const aliceId = connectAccount(alice.id, "alice");
      connectAccount(bob.id, "bob");

      for (const requester of [undefined, unlinked.id]) {
        await expect(
          selectForRequester(state, { sessionId: randomUUID(), updatedAt: 1 }, requester),
        ).resolves.toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "auto" });
      }

      const sessionEntry: SessionEntry = { sessionId: "alice-session", updatedAt: 1 };
      await selectForRequester(state, sessionEntry, alice.id);
      clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });

      await expect(selectForRequester(state, sessionEntry, bob.id, false)).resolves.toMatchObject({
        profileId: aliceId,
        source: "user",
      });
      await expect(
        selectForRequester(state, { sessionId: "new-session", updatedAt: 1 }, alice.id),
      ).resolves.toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "auto" });
    });
  });

  it("preserves explicit shared pins and ignores invalid shared account links", async () => {
    await withAuthState(async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [DEFAULT_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "synthetic-shared-key",
          },
        },
      });
      const alice = ensureProfileForEmail("alice@example.test");
      connectAccount(alice.id, "alice");
      const sessionEntry: SessionEntry = {
        sessionId: "explicit-session",
        updatedAt: 1,
        authProfileOverride: DEFAULT_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      await expect(selectForRequester(state, sessionEntry, alice.id, false)).resolves.toMatchObject(
        {
          profileId: DEFAULT_PROFILE_ID,
          source: "user",
        },
      );

      setUserProfileAuthLink({
        profileId: alice.id,
        provider: "openai",
        authProfileId: "openai:missing",
      });
      await expect(
        selectForRequester(state, { sessionId: "invalid-link-session", updatedAt: 1 }, alice.id),
      ).resolves.toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "auto" });
    });
  });

  it("does not replace a missing personal pin with the next participant's account", async () => {
    await withAuthState(async (state) => {
      const alice = ensureProfileForEmail("alice@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      connectAccount(bob.id, "bob");
      const missingId = `personal:${alice.id}:${randomUUID()}`;
      const sessionEntry: SessionEntry = {
        sessionId: "missing-owner-session",
        updatedAt: 1,
        authProfileOverride: missingId,
        authProfileOverrideSource: "user-link",
      };

      await expect(selectForRequester(state, sessionEntry, bob.id, false)).rejects.toThrow(
        "personal model account is unavailable",
      );
      expect(sessionEntry.authProfileOverride).toBe(missingId);
    });
  });
});
