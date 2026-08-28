import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../logging/logger.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { purgeAgentSessionStoreEntries } from "./cleanup-service.js";
import {
  appendTranscriptEventSync,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("purgeAgentSessionStoreEntries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
  });

  it.each(["fixed selector", "exact database", "retired schema owner"])(
    "purges only the deleted agent's state with a %s",
    async (kind) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const storePath = state.statePath(
          kind === "fixed selector" ? "shared.json" : "shared.sqlite",
        );
        const cfg = {
          agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
          session: { store: storePath },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        if (kind === "retired schema owner") {
          openOpenClawAgentDatabase({ agentId: "retired", path: storePath });
        }
        const scopes = ["main", "ops"].map((agentId) => ({
          agentId,
          sessionId: `${agentId}-session`,
          sessionKey: `agent:${agentId}:chat`,
          storePath,
        }));
        for (const scope of scopes) {
          await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
          appendTranscriptEventSync(scope, { type: "proof", data: scope.agentId });
        }

        await expect(purgeAgentSessionStoreEntries(cfg, "ops")).resolves.toBe(false);

        expect(loadSessionEntry(scopes[0]!)).toMatchObject({ sessionId: "main-session" });
        expect(loadTranscriptEventsSync(scopes[0]!)).toEqual([{ type: "proof", data: "main" }]);
        expect(loadSessionEntry(scopes[1]!)).toBeUndefined();
        expect(loadTranscriptEventsSync(scopes[1]!)).toEqual([]);
        if (kind === "fixed selector") {
          expect(fs.existsSync(storePath)).toBe(false);
        }
      });
    },
  );

  it("treats an absent store as an already successful purge", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const storePath = state.statePath("absent.json");
      const cfg = { session: { store: storePath } } satisfies OpenClawConfig;
      await expect(purgeAgentSessionStoreEntries(cfg, "ops")).resolves.toBe(false);
      expect(
        fs.existsSync(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "ops" }).path),
      ).toBe(false);
      expect(fs.existsSync(storePath)).toBe(false);
    });
  });

  it("records a bounded warning and failure fact when storage purge fails", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const storePath = state.statePath("corrupt.sqlite");
      fs.writeFileSync(storePath, "not a sqlite database");
      const cfg = { session: { store: storePath } } satisfies OpenClawConfig;
      const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});

      await expect(purgeAgentSessionStoreEntries(cfg, "ops")).resolves.toBe(true);

      expect(warn).toHaveBeenCalledWith("session store purge failed during agent deletion", {
        agentId: "ops",
        error: expect.any(Error),
        storePath,
      });
    });
  });
});
