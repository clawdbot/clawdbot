import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import { detectNodeClaudePlacement } from "../agents/cli-runner/prepare-claude.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("sessions.patch clears the complete node binding before persisting an unbound session", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-exec-unbind",
        updatedAt: Date.now(),
        execHost: "node",
        execNode: "worker-1",
        execCwd: "/workspace/on-worker-1",
      },
    },
  });

  const unbound = await directSessionReq<{
    entry: { execHost?: string; execNode?: string; execCwd?: string };
  }>("sessions.patch", { key: "agent:main:main", execNode: null });

  expect(unbound.ok).toBe(true);
  expect(unbound.payload?.entry.execHost).toBeUndefined();
  expect(unbound.payload?.entry.execNode).toBeUndefined();
  expect(unbound.payload?.entry.execCwd).toBeUndefined();

  const persisted = expectDefined(
    loadSessionEntry({ sessionKey: "agent:main:main", storePath }),
    "persisted session after removing its node binding",
  );
  expect(persisted.execHost).toBeUndefined();
  expect(persisted.execNode).toBeUndefined();
  expect(persisted.execCwd).toBeUndefined();
  expect(detectNodeClaudePlacement({ backendId: "claude-cli", ...persisted })).toBe(false);
});
