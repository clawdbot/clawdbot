import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
} from "./targets-read-availability.js";

describe("session store availability", () => {
  it("reads cross-agent rows from a migrated fixed store", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "shared.sqlite");
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
      };
      await replaceSessionEntry(
        { agentId: "main", env, storePath, sessionKey: "agent:main:main" },
        { sessionId: "main-session", updatedAt: 1 },
      );
      await replaceSessionEntry(
        { agentId: "ops", env, storePath, sessionKey: "agent:ops:main" },
        { sessionId: "ops-session", updatedAt: 1 },
      );
      const cache: SessionStoreTargetsReadCache = new Map();

      expect(
        resolveExistingAgentSessionStoreTargetsReadOnlyResult(cfg, "main", { cache, env }),
      ).toEqual({ available: true, targets: [{ agentId: "main", storePath }] });
      expect(
        resolveExistingAgentSessionStoreTargetsReadOnlyResult(cfg, "ops", { cache, env }),
      ).toEqual({ available: true, targets: [{ agentId: "ops", storePath }] });
      expect(cache.size).toBe(1);
    });
  });

  it("reads ownerless fixed-store rows under the requested agent", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "ownerless-shared.sqlite");
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      };
      await replaceSessionEntry(
        { agentId: "ops", env, storePath, sessionKey: "agent:ops:main" },
        { sessionId: "ops-session", updatedAt: 1 },
      );

      expect(resolveExistingAgentSessionStoreTargetsReadOnlyResult(cfg, "ops", { env })).toEqual({
        available: true,
        targets: [{ agentId: "ops", storePath }],
      });
    });
  });
});
