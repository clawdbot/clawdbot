import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SESSION_PARTICIPANTS,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, setGitHubIdentity } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  appendGitCoauthorContext,
  prepareGitCoauthorAttribution,
} from "./git-coauthor-attribution.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("Git co-author attribution", () => {
  it("derives exact bounded trailers only from canonical profile-backed humans", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:coauthors";
      const profile = (email: string, accountId?: number, login?: string) => {
        const value = ensureProfileForEmail(email, { env: state.env });
        return accountId && login
          ? setGitHubIdentity(value.id, { accountId, login }, { env: state.env })
          : value;
      };
      const ada = profile("ada@example.test", 20, "ada");
      const grace = profile("grace@example.test", 10, "grace");
      const primary = profile("primary@example.test", 30, "primary");
      const current = profile("current@example.test", 15, "current");
      const unlinked = profile("unlinked@example.test");
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "coauthors", updatedAt: 1 });
      for (const participant of [ada, grace, primary, unlinked]) {
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

      const modelPrompt = appendGitCoauthorContext("commit this", attribution);
      expect(modelPrompt).toContain(
        [
          "Co-authored-by: grace <10+grace@users.noreply.github.com>",
          "Co-authored-by: current <15+current@users.noreply.github.com>",
          "Co-authored-by: ada <20+ada@users.noreply.github.com>",
        ].join("\n"),
      );
      expect(modelPrompt).toContain(
        "1 eligible profile participant(s) have no linked GitHub account and were omitted",
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
      setGitHubIdentity(current.id, { accountId: 99, login: "current" }, { env: state.env });
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
