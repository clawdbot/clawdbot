// Proves the Talk shortcut stops at the durable cutover authority before it can acquire legacy memory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMemoryIsolationCutoverForTest } from "../plugins/memory-cutover.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({
  loadPluginRegistryHandle: vi.fn(),
  requireActivePluginRegistry: vi.fn(),
  resolvePluginRegistryLoadCacheKey: vi.fn(),
}));

vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: mocks.loadPluginRegistryHandle,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
}));

vi.mock("../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime.js")>()),
  requireActivePluginRegistry: mocks.requireActivePluginRegistry,
}));

import { resolveRealtimeVoiceFastContextConsult } from "./fast-context-runtime.js";

let testState: OpenClawTestState | undefined;

describe("Talk fast context after scoped-memory cutover", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-talk-fast-context-cutover-",
    });
    resetMemoryIsolationCutoverForTest();
    mocks.loadPluginRegistryHandle.mockReset();
    mocks.requireActivePluginRegistry.mockReset();
    mocks.resolvePluginRegistryLoadCacheKey.mockReset();
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    resetMemoryIsolationCutoverForTest();
    await testState?.cleanup();
    testState = undefined;
  });

  it.each([
    { fallbackToConsult: true, expected: { handled: false } },
    {
      fallbackToConsult: false,
      expected: {
        handled: true,
        result: {
          text: expect.stringContaining("No relevant OpenClaw memory context was found quickly"),
        },
      },
    },
  ])(
    "does not acquire or search legacy memory when fallbackToConsult is $fallbackToConsult",
    async ({ fallbackToConsult, expected }) => {
      const agentId = "talk-cutover";
      const legacySearch = vi.fn().mockResolvedValue([
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          snippet: "legacy memory must never reach the voice prompt",
          source: "memory",
          score: 1,
        },
      ]);
      const acquireLegacyManager = vi.fn().mockResolvedValue({
        manager: { search: legacySearch },
      });
      const registry = createEmptyPluginRegistry();
      registry.plugins.push({ id: "memory-core", memorySlotSelected: true } as never);
      registry.memoryCapabilities.push({
        pluginId: "memory-core",
        capability: {
          runtime: {
            getMemorySearchManager: acquireLegacyManager,
            resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
          },
        },
      } as never);
      mocks.requireActivePluginRegistry.mockReturnValue(registry);

      const database = openOpenClawAgentDatabase({ agentId });
      database.db
        .prepare(
          `INSERT INTO memory_migrations
            (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
             verified_at, cutover_at, updated_at)
           VALUES ('talk-fast-context-cutover', 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
        )
        .run();
      resetMemoryIsolationCutoverForTest();

      const result = await resolveRealtimeVoiceFastContextConsult({
        cfg: { plugins: { slots: { memory: "memory-core" } } } as never,
        agentId,
        sessionKey: "agent:talk-cutover:voice:15550001234",
        config: {
          enabled: true,
          timeoutMs: 1_000,
          maxResults: 1,
          sources: ["memory"],
          fallbackToConsult,
        },
        args: { question: "Can you help?" },
        logger: {},
      });

      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(
        "legacy memory must never reach the voice prompt",
      );
      expect(mocks.requireActivePluginRegistry).not.toHaveBeenCalled();
      expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
      expect(acquireLegacyManager).not.toHaveBeenCalled();
      expect(legacySearch).not.toHaveBeenCalled();
    },
  );
});
