import { afterEach, describe, expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import {
  MAX_SESSION_PARTICIPANTS,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { setUserPreferences } from "../state/user-preferences.js";
import { ensureProfileForEmail, linkEmail, syncGitHubIdentity } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  appendGitCoauthorContext,
  prepareGitCoauthorAttribution,
  resolveGitCoauthorAttribution,
} from "./git-coauthor-attribution.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("Git co-author attribution", () => {
  it("derives exact bounded trailers only from canonical profile-backed humans", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:coauthors";
      // "default" writes no preference row: credit is on unless the person opts out.
      const profile = (
        email: string,
        accountId?: number,
        login?: string,
        credit: "on" | "off" | "default" = "on",
      ) => {
        const value = ensureProfileForEmail(email, { env: state.env });
        if (accountId && login) {
          syncGitHubIdentity(
            {
              identity: { accountId, login },
              authenticationAlias: { kind: "email", email },
            },
            { env: state.env },
          );
          if (credit !== "default") {
            expect(
              setUserPreferences(
                value.id,
                { [GIT_COAUTHOR_PREFERENCE_KEY]: credit === "on" },
                { env: state.env },
              ),
            ).toMatchObject({ ok: true });
          }
        }
        return value;
      };
      const ada = profile("ada@example.test", 20, "ada");
      const grace = profile("grace@example.test", 10, "grace");
      const sameTime = profile("same-time@example.test", 5, "same-time");
      const later = profile("later@example.test", 1, "later");
      const primary = profile("primary@example.test", 30, "primary");
      const current = profile("current@example.test", 15, "current");
      const optedOut = profile("opted-out@example.test", 25, "opted-out", "off");
      const defaulted = profile("defaulted@example.test", 35, "defaulted", "default");
      const unlinked = profile("unlinked@example.test");
      const legacy = ensureProfileForEmail("legacy@example.test", { env: state.env });
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("github-attribution", "40", legacy.id, "legacy", Date.now());
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "coauthors", updatedAt: 1 });
      for (const [index, participant] of [
        ada,
        grace,
        sameTime,
        later,
        primary,
        optedOut,
        defaulted,
        unlinked,
        legacy,
      ].entries()) {
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: participant.id },
          promptedAt: participant === grace || participant === sameTime ? 100 : 200 + index,
          sessionAgentId: "main",
        });
      }
      for (const participant of [ada, ada, grace, sameTime, later]) {
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: participant.id },
          promptedAt: 400,
          sessionAgentId: "main",
        });
      }
      recordSessionParticipant(scope, {
        identity: {
          type: "observation",
          pluginId: "discord",
          accountId: null,
          senderKind: "unknown",
          id: current.id,
        },
        promptedAt: 1,
        sessionAgentId: "main",
      });
      recordSessionParticipant(scope, {
        identity: { type: "agent", id: "helper" },
        sessionAgentId: "main",
      });

      const attribution = prepareGitCoauthorAttribution({
        agentId: "main",
        config: {
          tools: {
            github: {
              profileId: "ghp_11111111111111111111111111111111",
              gitAuthor: {
                email: "30+primary@users.noreply.github.com",
              },
            },
          },
        },
        currentProfileId: current.id,
        env: state.env,
        sessionKey,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      });
      const structured = resolveGitCoauthorAttribution({
        agentId: "main",
        config: {
          tools: {
            github: {
              profileId: "ghp_11111111111111111111111111111111",
              gitAuthor: { email: "custom-author@example.test" },
            },
          },
        },
        excludeAccountId: 30,
        currentProfileId: current.id,
        env: state.env,
        sessionKey,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      });

      const modelPrompt = appendGitCoauthorContext("commit this", attribution);
      expect(modelPrompt).toContain(
        [
          "Co-authored-by: ada <20+ada@users.noreply.github.com>",
          "Co-authored-by: same-time <5+same-time@users.noreply.github.com>",
          "Co-authored-by: grace <10+grace@users.noreply.github.com>",
          "Co-authored-by: later <1+later@users.noreply.github.com>",
          "Co-authored-by: defaulted <35+defaulted@users.noreply.github.com>",
          "Co-authored-by: current <15+current@users.noreply.github.com>",
        ].join("\n"),
      );
      expect(modelPrompt).toContain(
        "Worked on by:\n- @ada\n- @same-time\n- @grace\n- @later\n- @defaulted\n- @current",
      );
      expect(modelPrompt).not.toContain("Co-authored-by: opted-out");
      expect(modelPrompt).not.toContain("Co-authored-by: legacy");
      expect(structured).toMatchObject({
        logins: ["ada", "same-time", "grace", "later", "defaulted", "current"],
        trailers: [
          "Co-authored-by: ada <20+ada@users.noreply.github.com>",
          "Co-authored-by: same-time <5+same-time@users.noreply.github.com>",
          "Co-authored-by: grace <10+grace@users.noreply.github.com>",
          "Co-authored-by: later <1+later@users.noreply.github.com>",
          "Co-authored-by: defaulted <35+defaulted@users.noreply.github.com>",
          "Co-authored-by: current <15+current@users.noreply.github.com>",
        ],
      });
      expect(modelPrompt).toContain(
        "3 eligible profile participant(s) have no enabled Git co-author credit and were omitted",
      );
      expect(modelPrompt).toContain(
        "1 linked profile participant(s) match the configured primary Git author",
      );
    });
  });

  it("combines historical profile contributions under one verified GitHub account", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:merged-coauthors";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "merged-coauthors", updatedAt: 1 });
      const oldProfile = ensureProfileForEmail("old@example.test", { env: state.env });
      const mergedProfile = ensureProfileForEmail("merged@example.test", { env: state.env });
      const otherProfile = ensureProfileForEmail("other@example.test", { env: state.env });

      for (const [profile, accountId, login, email] of [
        [mergedProfile, 20, "merged", "merged@example.test"],
        [otherProfile, 10, "other", "other@example.test"],
      ] as const) {
        syncGitHubIdentity(
          { identity: { accountId, login }, authenticationAlias: { kind: "email", email } },
          { env: state.env },
        );
        setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, { env: state.env });
      }
      for (const [profile, promptedAt] of [
        [oldProfile, 10],
        [oldProfile, 20],
        [mergedProfile, 30],
        [mergedProfile, 40],
        [otherProfile, 50],
        [otherProfile, 60],
        [otherProfile, 70],
      ] as const) {
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: profile.id },
          promptedAt,
          sessionAgentId: "main",
        });
      }
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: otherProfile.id },
        promptedAt: 80,
      });
      // A contaminated historical time stays unknown even after profile aliases merge.
      openOpenClawAgentDatabase({ agentId: "main", env: state.env })
        .db.prepare(
          "UPDATE session_participants SET first_prompted_at = NULL, last_prompted_at = NULL WHERE actor_id = ?",
        )
        .run(oldProfile.id);
      linkEmail("old@example.test", mergedProfile.id, { env: state.env });

      expect(
        resolveGitCoauthorAttribution({
          agentId: "main",
          config: {},
          env: state.env,
          sessionKey,
          storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
        }),
      ).toMatchObject({
        logins: ["other", "merged"],
        trailers: [
          "Co-authored-by: other <10+other@users.noreply.github.com>",
          "Co-authored-by: merged <20+merged@users.noreply.github.com>",
        ],
      });
    });
  });

  it("discloses unresolved legacy membership without dropping the authenticated current profile", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:legacy-coauthors";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "legacy-coauthors", updatedAt: 1 });
      recordSessionParticipant(scope, {
        identity: { type: "legacy", actorType: "human", source: null, id: "unknown" },
      });
      expect(
        prepareGitCoauthorAttribution({
          agentId: "main",
          config: {},
          env: state.env,
          sessionKey,
          storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
        }),
      ).toContain("participant history may be incomplete");
      const current = ensureProfileForEmail("current@example.test", { env: state.env });
      syncGitHubIdentity(
        {
          identity: { accountId: 99, login: "current" },
          authenticationAlias: { kind: "email", email: "current@example.test" },
        },
        { env: state.env },
      );
      setUserPreferences(current.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, { env: state.env });
      const attribution = prepareGitCoauthorAttribution({
        agentId: "main",
        config: {},
        currentProfileId: current.id,
        env: state.env,
        sessionKey,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      });
      expect(attribution).toContain("Co-authored-by: current");
      expect(attribution).toContain("participant history may be incomplete");
    });
  });

  it("makes the participant bound visible without guessing beyond it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:coauthor-cap";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "coauthor-cap", updatedAt: 1 });
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index += 1) {
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: `missing-${index}` },
          sessionAgentId: "main",
        });
      }
      const current = ensureProfileForEmail("current@example.test", { env: state.env });
      syncGitHubIdentity(
        {
          identity: { accountId: 99, login: "current" },
          authenticationAlias: { kind: "email", email: "current@example.test" },
        },
        { env: state.env },
      );
      expect(
        setUserPreferences(current.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, { env: state.env }),
      ).toMatchObject({ ok: true });
      const attribution = prepareGitCoauthorAttribution({
        agentId: "main",
        config: {},
        currentProfileId: current.id,
        env: state.env,
        sessionKey,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      });

      expect(attribution).toContain("bounded participant history may be incomplete");
      expect(attribution).not.toContain("Co-authored-by: current");
    });
  });
});
