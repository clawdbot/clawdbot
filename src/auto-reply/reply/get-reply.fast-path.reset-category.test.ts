// Tests that fast reply bootstrap honors the reset-trigger sidebar group rule.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { initFastReplySessionState } from "./get-reply-fast-path.js";
import { buildGetReplyCtx } from "./get-reply.test-fixtures.js";

describe("initFastReplySessionState sidebar group handling", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it.each([
    { body: "/reset", expected: "Operations" as string | undefined },
    { body: "/new", expected: undefined },
  ])("keeps the category for $body only when it is a reset", async ({ body, expected }) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-category-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:fast-reset-category";
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "existing-fast-reset-category",
      updatedAt: Date.now(),
      category: "Operations",
    } as unknown as SessionEntry);

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: body,
        RawBody: body,
        CommandBody: body,
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: home,
    });

    expect(result.resetTriggered).toBe(true);
    // Fast bootstrap only mints the entry; the store row is written later by the
    // reply run, so the prepared entry is the observable contract here.
    expect(result.sessionEntry.category).toBe(expected);
  });
});
