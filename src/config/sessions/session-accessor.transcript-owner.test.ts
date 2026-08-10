import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { retainLegacyDefaultAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";

describe("transcript turn logical ownership", () => {
  it("rejects a bare-key write for an ownerless explicit fleet", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        session: { store: storePath },
      } satisfies OpenClawConfig;

      await expect(
        persistSessionTranscriptTurn(
          {
            sessionId: "ownerless-transcript-session",
            sessionKey: "main",
            storePath,
          },
          {
            config: cfg,
            messages: [{ message: { role: "user", content: "must not be attributed" } }],
            updateMode: "none",
          },
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  });

  it("attributes a bare-key write to the retained compatibility owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = retainLegacyDefaultAgentId(
        {
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
          session: { store: storePath },
        },
        "ops",
      );
      const scope = {
        sessionId: "retained-owner-transcript-session",
        sessionKey: "main",
        storePath,
      };
      await replaceSessionEntry(
        { agentId: "ops", sessionKey: scope.sessionKey, storePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );

      await expect(
        persistSessionTranscriptTurn(scope, {
          config: cfg,
          messages: [{ message: { role: "user", content: "retained owner" } }],
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ appendedCount: 1 });
      await expect(loadTranscriptEvents({ ...scope, agentId: "ops" })).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "retained owner", role: "user" }),
          type: "message",
        }),
      );
    });
  });

  it("rejects a conflicting scope agent for a persisted fixed-store owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      const scope = {
        agentId: "research",
        sessionId: "persisted-owner-transcript-session",
        sessionKey: "global",
        storePath,
      };

      await expect(
        persistSessionTranscriptTurn(scope, {
          config: cfg,
          messages: [{ message: { role: "user", content: "wrong owner" } }],
          updateMode: "none",
        }),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);

      await replaceSessionEntry(
        { agentId: "ops", sessionKey: scope.sessionKey, storePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );
      await expect(
        persistSessionTranscriptTurn(
          { ...scope, agentId: "ops" },
          {
            config: cfg,
            messages: [{ message: { role: "user", content: "right owner" } }],
            updateMode: "none",
          },
        ),
      ).resolves.toMatchObject({ appendedCount: 1 });
    });
  });

  it("rejects a bare-key write for a retired persisted owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "retired" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: storePath },
      } satisfies OpenClawConfig;

      await expect(
        persistSessionTranscriptTurn(
          {
            sessionId: "retired-owner-transcript-session",
            sessionKey: "global",
            storePath,
          },
          {
            config: cfg,
            messages: [{ message: { role: "user", content: "retired owner" } }],
            updateMode: "none",
          },
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  });
});
