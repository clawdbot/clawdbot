import { afterEach, expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { resolveWorkerPlacementSessionTarget } from "./server-worker-placement-session-target.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";

afterEach(() => resetConfigRuntimeState());

test("resolves consecutive placement workspaces without decoding unrelated session payloads", async () => {
  await withStateDirEnv("worker-exact-target-", async () => {
    const config: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(config, config);
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const keys = ["agent:main:placement-a", "agent:main:placement-b"] as const;
    for (const key of keys) {
      await replaceSessionEntry(
        { storePath, sessionKey: key },
        {
          sessionId: key,
          updatedAt: 1,
          worktree: { id: key, branch: "synthetic", repoRoot: "/synthetic" },
        },
      );
    }
    for (let index = 0; index < 24; index++) {
      await replaceSessionEntry(
        { storePath, sessionKey: `agent:main:unrelated-${index}` },
        {
          sessionId: `unrelated-payload-${index}`,
          updatedAt: 1,
          skillsSnapshot: { prompt: "unrelated-payload-" + "x".repeat(4096), skills: [] },
        },
      );
    }
    // Canonical store admission runs once before repeated startup workspace lookups.
    expect(loadExactSessionEntryReadOnly({ storePath, sessionKey: keys[0] })?.entry).toBeDefined();
    const parse = vi.spyOn(JSON, "parse");
    try {
      for (const sessionKey of keys) {
        const resolved = resolveWorkerPlacementSessionTarget({
          sessionRuntime: {
            resolveGatewaySessionStoreTargetWithStore,
            resolveCanonicalSessionEntryFromStoreKeys,
            managedWorktrees: {
              findLiveByOwner: (_kind, ownerId) => ({
                id: ownerId,
                ownerId,
                path: `/synthetic/${ownerId}`,
              }),
            },
          },
          config,
          sessionId: sessionKey,
          sessionKey,
          agentId: "main",
          errorMessage: "placement identity changed",
        });
        expect(resolved.entry.sessionId).toBe(sessionKey);
        expect(resolved.worktree.path).toBe(`/synthetic/${sessionKey}`);
      }
      expect(
        parse.mock.calls.filter(([value]) => value.includes("unrelated-payload-")),
      ).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
  });
});
