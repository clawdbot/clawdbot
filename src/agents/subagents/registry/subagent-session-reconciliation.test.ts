import { describe, expect, it } from "vitest";
import { resolveSessionStorePathCore, type SessionEntry } from "../../../config/sessions.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveSubagentSessionCompletion,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

const configuredStorePath = "/virtual/openclaw-subagent-reconciliation-sessions.json";
const cfg = {
  session: { store: configuredStorePath },
} satisfies OpenClawConfig;
const storePath = resolveSessionStorePathCore(configuredStorePath, { agentId: "main" });

const terminalSession: SessionEntry = {
  sessionId: "sibling-session",
  status: "done",
  startedAt: 1_000,
  updatedAt: 2_000,
  endedAt: 2_000,
};

function resolveCompletion(childSessionKey: string, storedSessionKey: string) {
  const storeCache: SubagentSessionStoreCache = new Map([
    [storePath, { [storedSessionKey]: terminalSession }],
  ]);
  return resolveSubagentSessionCompletion({
    childSessionKey,
    fallbackEndedAt: 3_000,
    notBeforeMs: 0,
    storeCache,
    cfg,
  });
}

describe("subagent session reconciliation keys", () => {
  it("matches case-insensitive structural session-key segments", () => {
    expect(
      resolveCompletion("Agent:MAIN:telegram:group:ROOM", "agent:main:telegram:group:room"),
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
    ({ childSessionKey, storedSessionKey }) => {
      expect(resolveCompletion(childSessionKey, storedSessionKey)).toBeNull();
    },
  );
});
