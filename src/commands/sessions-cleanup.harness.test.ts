import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import * as pluginModuleRuntime from "../plugins/loader-module-runtime.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionsCleanupCommand } from "./sessions-cleanup.js";

const OWNER_PLUGIN_ID = "cleanup-owner";
const HARNESS_ID = "cleanup-runtime";
const STORE_OPTIONS = {
  namespace: "session-bindings",
  maxEntries: 10,
  overflowPolicy: "reject-new",
} as const;

function writeCleanupPlugins(bundledRoot: string) {
  const owner = writePlugin({
    id: OWNER_PLUGIN_ID,
    dir: path.join(bundledRoot, OWNER_PLUGIN_ID),
    filename: "index.cjs",
    body: `require("node:fs").writeFileSync(require("node:path").join(__dirname, "loaded"), "loaded");
      module.exports = {
      id: ${JSON.stringify(OWNER_PLUGIN_ID)},
      register(api) {
        api.registerAgentHarness({
          id: ${JSON.stringify(HARNESS_ID)},
          label: "Cleanup owner",
          supports: () => ({ supported: false }),
          async runAttempt() { throw new Error("cleanup must not run an agent turn"); },
          async withSessionDeletion(params, run) {
            params.assertCurrent();
            const bindings = api.runtime.state.openSyncKeyedStore(${JSON.stringify(STORE_OPTIONS)});
            const key = JSON.stringify([params.agentId, params.sessionKey, params.sessionId]);
            const previous = bindings.lookup(key);
            return await run({
              commit() {
                params.assertCurrent();
                bindings.delete(key);
              },
              rollback() {
                params.assertCurrent();
                if (previous !== undefined) bindings.register(key, previous);
              },
            });
          },
        });
      },
    };`,
  });
  fs.writeFileSync(
    path.join(owner.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: owner.id,
      activation: { onStartup: false, onAgentHarnesses: [HARNESS_ID] },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  fs.writeFileSync(
    path.join(owner.dir, "package.json"),
    JSON.stringify({ name: `@openclaw/${owner.id}`, openclaw: { extensions: ["./index.cjs"] } }),
  );
  const unrelated = writePlugin({
    id: "unrelated-cleanup-plugin",
    body: `require("node:fs").writeFileSync(require("node:path").join(__dirname, "loaded"), "loaded");
      module.exports = { id: "unrelated-cleanup-plugin", register() {} };`,
  });
  return { owner, unrelated };
}

beforeEach(() => {
  // Reuse Vitest's real runtime graph; Jiti would compile a second host graph on first deletion.
  vi.spyOn(pluginModuleRuntime, "createLazyPluginRuntime").mockImplementation(
    ({ runtimeOptions }) => createPluginRuntime(runtimeOptions),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("offline sessions cleanup harness ownership", () => {
  it.each([
    { label: "recorded", metadata: "recorded", activation: "enabled" },
    { label: "legacy", metadata: "legacy", activation: "enabled" },
    { label: "implicitly permitted", metadata: "recorded", activation: "implicit" },
    { label: "explicitly disabled", metadata: "recorded", activation: "disabled" },
    { label: "explicitly disabled legacy", metadata: "legacy", activation: "disabled" },
    { label: "globally disabled", metadata: "recorded", activation: "globally-disabled" },
    { label: "denylisted", metadata: "recorded", activation: "denylisted" },
    { label: "outside the allowlist", metadata: "recorded", activation: "not-allowlisted" },
  ] as const)(
    "reclaims allowed $label ownership and reports policy exclusions without running unrelated plugins",
    async ({ metadata, activation }) => {
      await withOpenClawTestState({ label: "offline-harness-cleanup" }, async (state) => {
        const bundledRoot = state.path("bundled-plugins");
        const { owner, unrelated } = writeCleanupPlugins(bundledRoot);
        vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
        const cfg: OpenClawConfig = {
          agents: {
            defaults: { model: { primary: "other-provider/other-model" } },
            entries: { main: { default: true, workspace: state.workspaceDir } },
          },
          plugins: {
            enabled: activation !== "globally-disabled",
            allow: activation === "not-allowlisted" ? [unrelated.id] : [owner.id, unrelated.id],
            ...(activation === "denylisted" ? { deny: [owner.id] } : {}),
            entries: {
              ...(activation === "implicit"
                ? {}
                : { [owner.id]: { enabled: activation !== "disabled" } }),
              [unrelated.id]: { enabled: true },
            },
            load: { paths: [unrelated.file] },
            slots: { memory: "none" },
          },
          session: {
            maintenance: {
              mode: "warn",
              pruneAfter: "1d",
              preserveRecent: false,
              maxDiskBytes: false,
            },
          },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const sessionKey = "agent:main:hook:cleanup-owned";
        const siblingKey = "agent:main:cleanup-kept";
        const sessionId = "shared-physical-id";
        const scope = { agentId: "main", sessionKey, storePath };
        const entry = {
          sessionId,
          updatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
          ...(metadata === "recorded" ? { agentHarnessId: HARNESS_ID } : {}),
        };
        await replaceSessionEntry(scope, entry);
        appendTranscriptMessageSync(
          { ...scope, sessionId },
          { message: { role: "user", content: "Stored cleanup fixture" } },
        );
        await replaceSessionEntry(scope, entry);
        await replaceSessionEntry(
          { ...scope, sessionKey: siblingKey },
          {
            sessionId,
            updatedAt: Date.now(),
            ...(metadata === "recorded" ? { agentHarnessId: HARNESS_ID } : {}),
          },
        );
        const bindings = createPluginStateSyncKeyedStore<{ threadId: string }>(
          owner.id,
          STORE_OPTIONS,
        );
        const key = JSON.stringify(["main", sessionKey, sessionId]);
        const siblingBindingKey = JSON.stringify(["main", siblingKey, sessionId]);
        bindings.register(key, { threadId: "removed-thread" });
        bindings.register(siblingBindingKey, { threadId: "kept-thread" });
        const runtime = createNonExitingRuntime();
        vi.spyOn(runtime, "writeJson").mockImplementation(() => {});
        const warnings = vi.spyOn(runtime, "error").mockImplementation(() => {});
        const activeRegistry = getActivePluginRegistry();
        expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject(entry);

        await sessionsCleanupCommand({ store: storePath, enforce: true, json: true }, runtime);

        expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toBeUndefined();
        if (activation !== "enabled" && activation !== "implicit") {
          expect(bindings.lookup(key)).toEqual({ threadId: "removed-thread" });
          expect(fs.existsSync(path.join(owner.dir, "loaded"))).toBe(false);
          expect(warnings.mock.calls.flat().join("\n")).toContain(owner.id);
          expect(warnings.mock.calls.flat().join("\n")).toContain("not cleaned");
        } else {
          expect(bindings.lookup(key)).toBeUndefined();
          expect(bindings.entries()).toMatchObject([
            { key: siblingBindingKey, value: { threadId: "kept-thread" } },
          ]);
          expect(warnings).not.toHaveBeenCalled();
        }
        expect(loadSessionEntry({ ...scope, sessionKey: siblingKey })?.sessionId).toBe(sessionId);
        expect(bindings.lookup(siblingBindingKey)).toEqual({ threadId: "kept-thread" });
        expect(fs.existsSync(path.join(unrelated.dir, "loaded"))).toBe(false);
        expect(getActivePluginRegistry()).toBe(activeRegistry);
      });
    },
  );
});
