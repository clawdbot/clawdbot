import { afterEach, describe, expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import {
  MAX_SESSION_PARTICIPANTS,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { setUserPreferences } from "../state/user-preferences.js";
import { ensureProfileForEmail, syncGitHubIdentity } from "../state/user-profiles.js";
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
      const profile = (email: string, accountId?: number, login?: string, optedIn = true) => {
        const value = ensureProfileForEmail(email, { env: state.env });
        if (accountId && login) {
          syncGitHubIdentity(
            {
              identity: { accountId, login },
              authenticationAlias: { kind: "email", email },
            },
            { env: state.env },
          );
          if (optedIn) {
            expect(
              setUserPreferences(
                value.id,
                { [GIT_COAUTHOR_PREFERENCE_KEY]: true },
                { env: state.env },
              ),
            ).toMatchObject({ ok: true });
          }
        }
        return value;
      };
      const ada = profile("ada@example.test", 20, "ada");
      const grace = profile("grace@example.test", 10, "grace");
      const primary = profile("primary@example.test", 30, "primary");
      const current = profile("current@example.test", 15, "current");
      const optedOut = profile("opted-out@example.test", 25, "opted-out", false);
      const unlinked = profile("unlinked@example.test");
      const legacy = ensureProfileForEmail("legacy@example.test", { env: state.env });
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("github-attribution", "40", legacy.id, "legacy", Date.now());
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "coauthors", updatedAt: 1 });
      for (const participant of [ada, grace, primary, optedOut, unlinked, legacy]) {
        recordSessionParticipant(scope, {
          actor: { type: "human", id: participant.id },
          source: "profile",
          sessionAgentId: "main",
        });
      }
      recordSessionParticipant(scope, {
        actor: { type: "human", id: ada.id },
        source: "profile",
        sessionAgentId: "main",
      });
      recordSessionParticipant(scope, {
        actor: { type: "human", id: current.id },
        source: "channel",
        sessionAgentId: "main",
      });
      recordSessionParticipant(scope, {
        actor: { type: "agent", id: "helper" },
        source: "agent",
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
          "Co-authored-by: grace <10+grace@users.noreply.github.com>",
          "Co-authored-by: current <15+current@users.noreply.github.com>",
          "Co-authored-by: ada <20+ada@users.noreply.github.com>",
        ].join("\n"),
      );
      expect(modelPrompt).not.toContain("Co-authored-by: opted-out");
      expect(modelPrompt).not.toContain("Co-authored-by: legacy");
      expect(structured).toMatchObject({
        logins: ["grace", "current", "ada"],
        trailers: [
          "Co-authored-by: grace <10+grace@users.noreply.github.com>",
          "Co-authored-by: current <15+current@users.noreply.github.com>",
          "Co-authored-by: ada <20+ada@users.noreply.github.com>",
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

  it("makes the participant bound visible without guessing beyond it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:coauthor-cap";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "coauthor-cap", updatedAt: 1 });
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index += 1) {
        recordSessionParticipant(scope, {
          actor: { type: "human", id: `missing-${index}` },
          source: "profile",
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
