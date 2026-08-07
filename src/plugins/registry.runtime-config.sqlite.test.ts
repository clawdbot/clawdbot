// Real SQLite-backed proof for embedded-run session ownership (#120178): the
// ownership listing must resolve against the real per-agent SQLite session
// store when the embedded run carries only a session key (no agentId). The fix
// derives the agent scope from the key so the real accessor can open the store
// instead of throwing "Cannot resolve SQLite session scope without an agent id".
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceSqliteSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

function createTestRegistry(runtime: ReturnType<typeof createPluginRuntime>) {
  return createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
    activateGlobalSideEffects: false,
  });
}

describe("embedded-run session ownership resolves through the real SQLite session store", () => {
  it("scopes the key-only ownership listing to the derived agent (#120178)", async () => {
    await withTempHome(async (home) => {
      const env = { OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storeEnv = { ...process.env, ...env };
      const originalStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = env.OPENCLAW_STATE_DIR;
      try {
        // Seed agent main's default SQLite session store (resolved from
        // OPENCLAW_STATE_DIR) with one entry. No custom storePath on either the
        // seed or the run: the ownership listing must resolve the same default
        // store purely from the session key's derived agent + env.
        const sessionId = "main-real-session";
        await replaceSqliteSessionEntry(
          {
            agentId: "main",
            defaultAgentId: "main",
            env: storeEnv,
            sessionKey: "agent:main:skill-workshop-review:incognito-1",
          },
          { sessionId, updatedAt: Date.now() },
        );

        // The registry runtime is created with the real session facade. Only the
        // terminal embedded-run kernel is mocked; ownership resolution keeps the
        // real `session.listSessionEntries` -> SQLite accessor path untouched.
        const runtime = createPluginRuntime();
        const runEmbeddedAgent = vi.fn(async () => ({ ok: true })) as unknown as ReturnType<
          typeof createPluginRuntime
        >["agent"]["runEmbeddedAgent"];
        Object.defineProperties(runtime.agent, {
          runEmbeddedAgent: { configurable: true, value: runEmbeddedAgent },
          runEmbeddedPiAgent: { configurable: true, value: runEmbeddedAgent },
        });

        const pluginRegistry = createTestRegistry(runtime);
        const record = createPluginRecord({
          id: "extractor-plugin",
          source: "/plugins/extractor-plugin/index.js",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        });
        const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

        // Key-only embedded run: no agentId, no storePath. The ownership
        // listing must derive agent "main" from the key and resolve the same
        // default store the seed wrote (env-based), not throw.
        await expect(
          api.runtime.agent.runEmbeddedAgent({
            sessionId,
            sessionKey: "agent:main:skill-workshop-review:incognito-1",
            workspaceDir: path.join(home, "ws"),
            prompt: "continue",
            timeoutMs: 1,
            runId: "run-1",
          } as never),
        ).resolves.toEqual({ ok: true });
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
      } finally {
        if (originalStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = originalStateDir;
        }
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });
});
