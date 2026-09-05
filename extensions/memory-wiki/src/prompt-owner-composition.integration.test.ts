// Memory Wiki composed proof: hosted prompt-owner selection, the real compiled
// SQLite digest reader, and production memory prompt assembly in one path.
import fs from "node:fs/promises";
import path from "node:path";
import {
  assembleHarnessContextEngine,
  type HarnessContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";
import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-host-core";
import type { OpenBlobStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createParams as createCodexParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir as codexTempDir,
} from "../../codex/src/app-server/run-attempt-test-harness.js";
import type { OpenClawConfig } from "../api.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  invalidateMemoryWikiCompiledCache,
} from "./compiled-cache.js";
import {
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createWikiPromptSectionPreparer } from "./prompt-section.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { activateExistingMemoryWikiVault, initializeMemoryWikiVault } from "./vault.js";

const REQUESTER_AGENT_ID = "hq";
const SESSION_AGENT_ID = "openclaw";
const SESSION_KEY = `agent:${SESSION_AGENT_ID}:main`;
const REQUESTER_CLAIM = "HQ closes the quarterly ledger on the fifth business day.";
const SESSION_CLAIM = "OpenClaw rotates gateway tokens every ninety days.";
const TEST_HOME = "/Users/tester";

const { createTempDir } = createMemoryWikiTestHarness();

setupRunAttemptTestHooks();

const knownAgentsConfig = {
  agents: { list: [{ id: SESSION_AGENT_ID, default: true }, { id: REQUESTER_AGENT_ID }] },
} as OpenClawConfig;
// Ownership reassignment: the requester is no longer a configured memory owner.
const reassignedAgentsConfig = {
  agents: { list: [{ id: SESSION_AGENT_ID, default: true }] },
} as OpenClawConfig;

let blobStoreEnv: NodeJS.ProcessEnv = {};
let baseConfig: ResolvedMemoryWikiConfig;
let requesterConfig: ResolvedMemoryWikiConfig;
let appConfig: OpenClawConfig = knownAgentsConfig;

/** Mirrors the plugin's compiled-cache store wiring over the SQLite-backed Blob store. */
function configureSqliteCompiledCacheStore(): void {
  configureMemoryWikiCompiledCacheStore(
    createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) =>
      createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv),
    ),
  );
}

async function compileAgentVault(
  agentId: string,
  claimText: string,
): Promise<ResolvedMemoryWikiConfig> {
  const config = resolveMemoryWikiAgentConfig({ config: baseConfig, appConfig, agentId });
  await initializeMemoryWikiVault(config);
  await fs.writeFile(
    path.join(config.vault.path, "entities", `${agentId}.md`),
    renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        id: `entity.${agentId}`,
        title: agentId,
        claims: [
          {
            id: `claim.${agentId}.operations`,
            text: claimText,
            status: "supported",
            confidence: 0.93,
            evidence: [{ sourceId: `source.${agentId}`, lines: "1-2" }],
          },
        ],
      },
      body: `# ${agentId}\n\nOperational notes.\n`,
    }),
    "utf8",
  );
  await compileMemoryWikiVault(config);
  return config;
}

/**
 * Stands in for a context engine plugin: production `buildMemorySystemPromptAddition`
 * is the only supported way to read the run-scoped prepared memory section.
 */
const contextEngine: HarnessContextEngine = {
  info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
  bootstrap: async () => ({ bootstrapped: true }),
  assemble: async ({ messages, availableTools, citationsMode }) => ({
    messages,
    estimatedTokens: 1,
    systemPromptAddition: buildMemorySystemPromptAddition({
      availableTools: availableTools ?? new Set(),
      citationsMode,
    }),
  }),
  ingest: async () => ({ ingested: true }),
  maintain: async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }),
  compact: async () => ({
    ok: true,
    compacted: false,
    result: { summary: "", firstKeptEntryId: "entry-1", tokensBefore: 1 },
  }),
};

/** Drives the hosted requester/fallback selection that owns memory prompt ownership. */
async function assembleMemoryPrompt(agentId?: string): Promise<string> {
  const assembled = await assembleHarnessContextEngine({
    contextEngine,
    sessionId: "session-1",
    sessionKey: SESSION_KEY,
    ...(agentId ? { agentId } : {}),
    messages: [],
    availableTools: new Set<string>(),
    modelId: "gpt-5.6-luna",
  });
  return assembled?.systemPromptAddition ?? "";
}

describe("Memory Wiki hosted prompt-owner composition", () => {
  beforeEach(async () => {
    clearMemoryPluginState();
    resetPluginBlobStoreForTests();
    configureMemoryWikiCompiledCacheStore(undefined);
    appConfig = knownAgentsConfig;
    const vaultRoot = await createTempDir("memory-wiki-prompt-owner-");
    blobStoreEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: await createTempDir("memory-wiki-prompt-owner-state-"),
    };
    configureSqliteCompiledCacheStore();
    baseConfig = resolveMemoryWikiConfig(
      {
        vault: { scope: "agent", path: vaultRoot },
        context: { includeCompiledDigestPrompt: true },
      },
      { homedir: TEST_HOME },
    );
    requesterConfig = await compileAgentVault(REQUESTER_AGENT_ID, REQUESTER_CLAIM);
    await compileAgentVault(SESSION_AGENT_ID, SESSION_CLAIM);

    const registry = createMockPluginRegistry([]);
    registry.memoryPromptPreparations.push({
      pluginId: "memory-wiki",
      // Constructed exactly as extensions/memory-wiki/index.ts registers it.
      prepare: createWikiPromptSectionPreparer({
        config: baseConfig,
        resolveConfig: (agentId) =>
          resolveMemoryWikiAgentConfig({ config: baseConfig, appConfig, agentId }),
      }),
    });
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    clearMemoryPluginState();
    configureMemoryWikiCompiledCacheStore(undefined);
    resetPluginBlobStoreForTests();
    blobStoreEnv = {};
  });

  it("assembles the requester's compiled digest and excludes the session fallback owner", async () => {
    const requesterPrompt = await assembleMemoryPrompt(REQUESTER_AGENT_ID);

    expect(requesterPrompt).toContain(REQUESTER_CLAIM);
    expect(requesterPrompt).not.toContain(SESSION_CLAIM);
  });

  it("submits the requester's real compiled digest to the Codex app-server boundary", async () => {
    const harness = createStartedThreadHarness();
    const params = createCodexParams(
      path.join(codexTempDir, "memory-wiki-owner.jsonl"),
      path.join(codexTempDir, "memory-wiki-owner-workspace"),
      { sessionKey: SESSION_KEY },
    );
    params.agentId = SESSION_AGENT_ID;
    params.memoryPromptAgentId = REQUESTER_AGENT_ID;
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const developerInstructions = readStringValue(
      (threadStart?.params as { developerInstructions?: unknown } | undefined)
        ?.developerInstructions,
    );

    expect(developerInstructions).toContain(REQUESTER_CLAIM);
    expect(developerInstructions).not.toContain(SESSION_CLAIM);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("falls back to the session owner's compiled digest when no requester is declared", async () => {
    const fallbackPrompt = await assembleMemoryPrompt();

    expect(fallbackPrompt).toContain(SESSION_CLAIM);
    expect(fallbackPrompt).not.toContain(REQUESTER_CLAIM);
  });

  it("withholds every digest after the requester's compiled cache is invalidated", async () => {
    await invalidateMemoryWikiCompiledCache(requesterConfig);

    const invalidatedPrompt = await assembleMemoryPrompt(REQUESTER_AGENT_ID);

    expect(invalidatedPrompt).not.toContain(REQUESTER_CLAIM);
    expect(invalidatedPrompt).not.toContain(SESSION_CLAIM);
    // The unrelated owner stays readable, so the withholding is ownership-scoped.
    await expect(assembleMemoryPrompt(SESSION_AGENT_ID)).resolves.toContain(SESSION_CLAIM);
    // Re-activating the retired owner must not resurrect the deleted publication.
    await activateExistingMemoryWikiVault(requesterConfig);
    await expect(assembleMemoryPrompt(REQUESTER_AGENT_ID)).resolves.not.toContain(REQUESTER_CLAIM);
  });

  it("fails assembly instead of substituting an owner when the requester is reassigned", async () => {
    appConfig = reassignedAgentsConfig;

    await expect(assembleMemoryPrompt(REQUESTER_AGENT_ID)).rejects.toThrow(
      `Unknown memory-wiki agentId: ${REQUESTER_AGENT_ID}.`,
    );
    // The still-owned vault stays readable, so rejection is scoped to the lost owner.
    await expect(assembleMemoryPrompt(SESSION_AGENT_ID)).resolves.toContain(SESSION_CLAIM);
  });
});
