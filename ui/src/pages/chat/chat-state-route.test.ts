import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

const SESSION_KEY = "agent:main:dashboard:incognito-9f2c";

function roster(rows: GatewaySessionRow[]): SessionsListResult {
  return { sessions: rows } as unknown as SessionsListResult;
}

function incognitoRow(): GatewaySessionRow {
  return { key: SESSION_KEY, kind: "direct", incognito: true } as unknown as GatewaySessionRow;
}

describe("selectedChatSessionRow across a gateway disconnect", () => {
  it("keeps the open session's incognito identity when the roster clears", () => {
    const state = makeChatHost({
      sessionKey: SESSION_KEY,
      sessionsResult: roster([incognitoRow()]),
    });

    expect(selectedChatSessionRow(state)?.incognito).toBe(true);

    // A disconnect makes the sessions store publish result: null. The session the
    // user still has open did not stop being incognito because it cannot be listed.
    state.sessionsResult = null;

    expect(selectedChatSessionRow(state)?.incognito).toBe(true);
  });

  it("does not resurrect a session that a live roster no longer lists", () => {
    const state = makeChatHost({
      sessionKey: SESSION_KEY,
      sessionsResult: roster([incognitoRow()]),
    });
    selectedChatSessionRow(state);

    // Still connected, but the row is gone: archived or deleted, never retained.
    state.sessionsResult = roster([]);

    expect(selectedChatSessionRow(state)).toBeUndefined();
  });

  it("does not lend a retained identity to a different session", () => {
    const state = makeChatHost({
      sessionKey: SESSION_KEY,
      sessionsResult: roster([incognitoRow()]),
    });
    selectedChatSessionRow(state);

    state.sessionsResult = null;
    state.sessionKey = "agent:main:dashboard:ordinary-1";

    expect(selectedChatSessionRow(state)).toBeUndefined();
  });
});
