import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  loadSubagentSessionEntry,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
} from "./subagent-session-reconciliation.js";

const terminalSession: SessionEntry = {
  sessionId: "sibling-session",
  status: "done",
  startedAt: 1_000,
  updatedAt: 2_000,
  endedAt: 2_000,
};

async function resolveCompletion(childSessionKey: string, storedSessionKey: string) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    replaceSessionEntrySync({ sessionKey: storedSessionKey, env: state.env }, terminalSession);
    return resolveSubagentSessionCompletion({
      childSessionKey,
      fallbackEndedAt: 3_000,
      notBeforeMs: 0,
      cfg: {},
    });
  });
}

describe("subagent session reconciliation keys", () => {
  it("matches case-insensitive structural session-key segments", async () => {
    expect(
      await resolveCompletion("Agent:MAIN:telegram:group:ROOM", "agent:main:telegram:group:room"),
    ).toMatchObject({ endedAt: 2_000, outcome: { status: "ok" } });
  });

  it.each([
    {
      channel: "Matrix",
      childSessionKey: "agent:main:matrix:group:!Room:server",
      storedSessionKey: "agent:main:matrix:group:!room:server",
    },
    {
      channel: "Signal",
      childSessionKey: "agent:main:signal:group:AbCdEf==",
      storedSessionKey: "agent:main:signal:group:abcdef==",
    },
  ])(
    "does not match a case-distinct $channel opaque peer",
    async ({ childSessionKey, storedSessionKey }) => {
      expect(await resolveCompletion(childSessionKey, storedSessionKey)).toBeNull();
    },
  );
});

describe("subagent session reconciliation ownership", () => {
  it.each([
    { name: "default per-agent", file: undefined },
    { name: "configured fixed", file: "sessions.json" },
    { name: "configured custom", file: "custom-sessions.json" },
    { name: "explicit shared SQLite", file: "shared.sqlite" },
  ])("reconciles each agent in a $name store", async ({ file }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = file ? state.path(file) : undefined;
      const cfg: OpenClawConfig = storePath ? { session: { store: storePath } } : {};
      for (const agentId of ["main", "worker"]) {
        replaceSessionEntrySync(
          { agentId, sessionKey: `agent:${agentId}:subagent:child`, storePath, env: state.env },
          { ...terminalSession, sessionId: `${agentId}-child` },
        );
      }

      for (const agentId of ["main", "worker"]) {
        const childSessionKey = `agent:${agentId}:subagent:child`;
        expect(loadSubagentSessionEntry({ childSessionKey, cfg })?.sessionId).toBe(
          `${agentId}-child`,
        );
        expect(
          resolveSubagentSessionCompletion({ childSessionKey, cfg, fallbackEndedAt: 3_000 }),
        ).toMatchObject({ endedAt: 2_000, outcome: { status: "ok" } });
        expect(resolveSubagentSessionStartedAt({ childSessionKey, cfg })).toBe(1_000);
      }
    });
  });

  it.each(["main", "worker"])(
    "keeps %s incognito completion separate from its configured durable store",
    async (agentId) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = state.path("custom-sessions.json");
        const cfg = { session: { store: storePath } } satisfies OpenClawConfig;
        const durableKey = `agent:${agentId}:subagent:durable`;
        const childSessionKey = `agent:${agentId}:subagent:incognito-child`;
        replaceSessionEntrySync(
          { agentId, sessionKey: durableKey, storePath, env: state.env },
          { ...terminalSession, sessionId: "durable-child" },
        );
        replaceSessionEntrySync(
          { agentId, sessionKey: childSessionKey, storePath, env: state.env },
          { ...terminalSession, sessionId: "incognito-child", incognito: true },
        );

        expect(
          resolveSubagentSessionCompletion({ childSessionKey, cfg, fallbackEndedAt: 3_000 }),
        ).toMatchObject({ endedAt: 2_000, outcome: { status: "ok" } });
        expect(loadSubagentSessionEntry({ childSessionKey, cfg })?.sessionId).toBe(
          "incognito-child",
        );
        expect(
          listSessionEntriesReadOnly({ agentId, storePath, env: state.env }).map(
            ({ sessionKey }) => sessionKey,
          ),
        ).toEqual([durableKey]);
        expect(
          fs.existsSync(resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env })),
        ).toBe(false);
      });
    },
  );
});
