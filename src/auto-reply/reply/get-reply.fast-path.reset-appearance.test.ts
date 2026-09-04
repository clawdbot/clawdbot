// Fast-path /reset appearance coverage lives here so get-reply.fast-path.test.ts
// stays under the max-lines ratchet. Native slash still calls initFastReplySessionState.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { initFastReplySessionState } from "./get-reply-fast-path.js";
import { buildGetReplyCtx } from "./get-reply.test-fixtures.js";

async function seedFastPathSessionStore(
  storePath: string,
  entries: Record<string, Record<string, unknown>>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ storePath, sessionKey }, entry as unknown as SessionEntry);
  }
}

describe("initFastReplySessionState reset appearance", () => {
  let state: OpenClawTestState;
  let isolatedStorePath: string;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "fast-reply-appearance",
      env: { OPENCLAW_TEST_FAST: "1" },
    });
    isolatedStorePath = path.join(state.sessionsDir("main"), "sessions.json");
  });

  afterEach(async () => {
    await state.cleanup();
  });

  it("preserves custom session appearance during fast reset bootstrap", async () => {
    const sessionKey = "agent:main:telegram:123";
    const appearance = {
      icon: "🦞",
      color: "blue",
      category: "Operator group",
      boardFace: "dashboard" as const,
      visibility: "draft" as const,
    };
    await seedFastPathSessionStore(isolatedStorePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-appearance",
        updatedAt: Date.now(),
        ...appearance,
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: isolatedStorePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: state.workspaceDir,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.sessionEntry).toMatchObject(appearance);
  });

  it("does not invent a session icon during fast reset bootstrap", async () => {
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(isolatedStorePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-no-icon",
        updatedAt: Date.now(),
        label: "plain-session",
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: isolatedStorePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: state.workspaceDir,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.sessionEntry.icon).toBeUndefined();
    expect(result.sessionEntry.color).toBeUndefined();
    expect(result.sessionEntry.category).toBeUndefined();
    expect(result.sessionEntry.boardFace).toBeUndefined();
  });
});
