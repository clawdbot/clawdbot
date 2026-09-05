// Memory Wiki composed proof: hosted prompt-owner selection, the real compiled
// SQLite digest reader, production memory prompt assembly, and the Codex
// app-server stdio transport in one path. Transport assertions read the frames
// the client actually serialized, not the pre-encode request arguments.
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexRunAttemptHarnessForTest } from "../extensions/codex/test-api.js";
import type { OpenClawConfig } from "../extensions/memory-wiki/api.js";
import {
  activateExistingMemoryWikiVault,
  compileMemoryWikiVault,
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  createMemoryWikiTestHarness,
  createWikiPromptSectionPreparer,
  initializeMemoryWikiVault,
  invalidateMemoryWikiCompiledCache,
  renderWikiMarkdown,
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  type ResolvedMemoryWikiConfig,
} from "../extensions/memory-wiki/test-api.js";
import { createSystemAgentSession } from "../src/system-agent/agent-turn.js";
import {
  runSystemAgentTurnWithDeps,
  type SystemAgentTurnDeps,
} from "../src/system-agent/agent-turn.test-support.js";
import { ChatTurnRouter } from "../src/system-agent/chat-turn-router.js";
import { ChatWizardHost } from "../src/system-agent/chat-wizard-host.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../src/system-agent/system-agent.test-helpers.js";

const REQUESTER_AGENT_ID = "hq";
/** Distinct owner the turn runner selects when no requester is delegated. */
const FALLBACK_AGENT_ID = "ops";
const SESSION_AGENT_ID = "openclaw";
const SESSION_KEY = `agent:${SESSION_AGENT_ID}:main`;
const REQUESTER_CLAIM = "HQ closes the quarterly ledger on the fifth business day.";
const FALLBACK_CLAIM = "Ops keeps the escalation pager on a two-week rotation.";
const SESSION_CLAIM = "OpenClaw rotates gateway tokens every ninety days.";
const EVERY_CLAIM = [REQUESTER_CLAIM, FALLBACK_CLAIM, SESSION_CLAIM];
const TEST_HOME = "/Users/tester";

const { createTempDir } = createMemoryWikiTestHarness();
const codexRunAttemptHarness = await loadCodexRunAttemptHarnessForTest();

codexRunAttemptHarness.setupRunAttemptTestHooks();

const knownAgentsConfig = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
    },
    list: [
      { id: FALLBACK_AGENT_ID, default: true },
      { id: REQUESTER_AGENT_ID },
      { id: SESSION_AGENT_ID },
    ],
  },
} as OpenClawConfig;
// Ownership reassignment: the requester is no longer a configured memory owner.
const reassignedAgentsConfig = {
  ...knownAgentsConfig,
  agents: {
    ...knownAgentsConfig.agents,
    list: [{ id: FALLBACK_AGENT_ID, default: true }, { id: SESSION_AGENT_ID }],
  },
} as OpenClawConfig;

let blobStoreEnv: NodeJS.ProcessEnv = {};
let baseConfig: ResolvedMemoryWikiConfig;
let requesterConfig: ResolvedMemoryWikiConfig;
let appConfig: OpenClawConfig = knownAgentsConfig;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot;

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

type WireFrame = { method?: string; params?: Record<string, unknown> };

/** Decodes the newline-framed JSON-RPC bytes the client wrote to the app-server. */
function readWireFrames(writes: string[]): WireFrame[] {
  return writes
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WireFrame);
}

/**
 * Real-transport harness: `persistedThreads` selects the synthetic native
 * app-server, so the production client, its guards, and stdio JSON-RPC framing
 * all stay live and `writes` holds the bytes Codex would actually receive.
 */
function createWireHarness() {
  const harness = codexRunAttemptHarness.createStartedThreadHarness(async () => undefined, {
    persistedThreads: [],
  });
  if (!("writes" in harness)) {
    throw new Error("expected the wire-backed Codex app-server harness");
  }
  return harness;
}

/** Runs the attempt against the real Codex stdio transport, not a client mock. */
function startCodexAttempt(options: {
  name: string;
  memoryPromptAgentId: string;
  runParams?: Parameters<NonNullable<SystemAgentTurnDeps["runEmbeddedAgent"]>>[0];
}) {
  const identity = options.runParams
    ? {
        prompt: options.runParams.prompt,
        provider: options.runParams.provider,
        runId: options.runParams.runId,
        sessionId: options.runParams.sessionId,
        sessionKey: options.runParams.sessionKey,
      }
    : { sessionKey: SESSION_KEY };
  const params = codexRunAttemptHarness.createParams(
    path.join(codexRunAttemptHarness.tempDir, `${options.name}.jsonl`),
    path.join(codexRunAttemptHarness.tempDir, `${options.name}-workspace`),
    identity,
  );
  params.agentId = options.runParams?.agentId ?? SESSION_AGENT_ID;
  params.memoryPromptAgentId = options.memoryPromptAgentId;
  params.contextEngine = contextEngine;
  return codexRunAttemptHarness.runCodexAppServerAttempt(params);
}

/**
 * Runs the production hosted owner selector into the Codex transport and returns
 * the serialized developer instructions off the wire.
 */
async function submitHostedCodexAttempt(options: {
  name: string;
  requesterAgentId?: string;
}): Promise<string> {
  const harness = createWireHarness();
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(knownAgentsConfig);
  let developerInstructions = "";
  const runEmbeddedAgent: NonNullable<SystemAgentTurnDeps["runEmbeddedAgent"]> = async (
    runParams,
  ) => {
    const memoryPromptAgentId = runParams.memoryPromptAgentId;
    if (!memoryPromptAgentId) {
      throw new Error("hosted turn omitted its memory owner");
    }
    const run = startCodexAttempt({
      name: options.name,
      memoryPromptAgentId,
      runParams,
    });
    await harness.waitForMethod("turn/start");
    const threadStart = readWireFrames(harness.writes).find(
      (frame) => frame.method === "thread/start",
    );
    developerInstructions = readStringValue(threadStart?.params?.developerInstructions) ?? "";
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    return {
      payloads: [{ text: "ready" }],
      meta: { durationMs: 1, finalAssistantVisibleText: "ready" },
    };
  };

  const turnDeps: SystemAgentTurnDeps = {
    ...fixture.deps,
    runEmbeddedAgent,
    readConfigFileSnapshot: vi.fn(async () => ({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "memory-owner-proof",
      config: knownAgentsConfig,
      runtimeConfig: knownAgentsConfig,
      sourceConfig: knownAgentsConfig,
      issues: [],
    })) as never,
  };
  const router = new ChatTurnRouter(
    {
      surface: "gateway",
      operatorApprovalOnly: options.requesterAgentId !== undefined,
      ...(options.requesterAgentId ? { requesterAgentId: options.requesterAgentId } : {}),
      runAgentTurn: async (params) => await runSystemAgentTurnWithDeps(params, turnDeps),
    },
    {},
    createSystemAgentSession(fixture.binding),
    new ChatWizardHost({ beforePersistentApply: async () => {} }),
    {
      requireVerifiedInference: async () => fixture.binding.execution,
      requirePersistentApplyInference: async () => fixture.binding.execution,
      rebindVerifiedInference: () => {},
      getVerifiedInference: () => fixture.binding,
      loadOverview: async () => ({ defaultModel: "openai/gpt-5.4" }) as never,
      getHistory: () => [],
      verifyConfigAfterWrite: async () => null,
    },
  );

  await router.resolveTurn("inspect scoped memory");

  return developerInstructions;
}

beforeAll(() => {
  pluginMetadataSnapshot = installSystemAgentPluginMetadataTestSnapshot(knownAgentsConfig);
});

afterAll(() => {
  pluginMetadataSnapshot.restore();
});

describe("Memory Wiki hosted prompt-owner composition", () => {
  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", await createTempDir("memory-wiki-system-agent-state-"));
    pluginMetadataSnapshot.rebindForCurrentEnv();
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
    await compileAgentVault(FALLBACK_AGENT_ID, FALLBACK_CLAIM);
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

  it("submits only the requester's compiled digest across hosted delegation and Codex transport", async () => {
    const developerInstructions = await submitHostedCodexAttempt({
      name: "memory-wiki-requester",
      requesterAgentId: REQUESTER_AGENT_ID,
    });

    expect(developerInstructions).toContain(REQUESTER_CLAIM);
    expect(developerInstructions).not.toContain(FALLBACK_CLAIM);
    expect(developerInstructions).not.toContain(SESSION_CLAIM);
  });

  it("submits the verified fallback owner's digest when no requester is delegated", async () => {
    const developerInstructions = await submitHostedCodexAttempt({
      name: "memory-wiki-fallback",
    });

    expect(developerInstructions).toContain(FALLBACK_CLAIM);
    expect(developerInstructions).not.toContain(REQUESTER_CLAIM);
    expect(developerInstructions).not.toContain(SESSION_CLAIM);
  });

  it("withholds every digest at final I/O after the requester's publication is invalidated", async () => {
    await invalidateMemoryWikiCompiledCache(requesterConfig);

    const developerInstructions = await submitHostedCodexAttempt({
      name: "memory-wiki-invalidated",
      requesterAgentId: REQUESTER_AGENT_ID,
    });

    for (const claim of EVERY_CLAIM) {
      expect(developerInstructions).not.toContain(claim);
    }
  });

  it("withholds every digest at final I/O after the requester loses ownership", async () => {
    appConfig = reassignedAgentsConfig;

    const developerInstructions = await submitHostedCodexAttempt({
      name: "memory-wiki-reassigned",
      requesterAgentId: REQUESTER_AGENT_ID,
    });

    // Codex catches assemble failures and submits its baseline prompt, so the
    // owner rejection must withhold every digest instead of degrading into a
    // substitute owner's memory.
    for (const claim of EVERY_CLAIM) {
      expect(developerInstructions).not.toContain(claim);
    }
  });

  it("assembles the requester's compiled digest and excludes the session fallback owner", async () => {
    const requesterPrompt = await assembleMemoryPrompt(REQUESTER_AGENT_ID);

    expect(requesterPrompt).toContain(REQUESTER_CLAIM);
    expect(requesterPrompt).not.toContain(SESSION_CLAIM);
  });

  it("falls back to the session owner's compiled digest when no owner is declared", async () => {
    const fallbackPrompt = await assembleMemoryPrompt();

    expect(fallbackPrompt).toContain(SESSION_CLAIM);
    expect(fallbackPrompt).not.toContain(REQUESTER_CLAIM);
  });

  it("keeps invalidation and reassignment scoped to the losing owner", async () => {
    await invalidateMemoryWikiCompiledCache(requesterConfig);

    // The unrelated owner stays readable, so the withholding is ownership-scoped.
    await expect(assembleMemoryPrompt(SESSION_AGENT_ID)).resolves.toContain(SESSION_CLAIM);
    // Re-activating the retired owner must not resurrect the deleted publication.
    await activateExistingMemoryWikiVault(requesterConfig);
    await expect(assembleMemoryPrompt(REQUESTER_AGENT_ID)).resolves.not.toContain(REQUESTER_CLAIM);

    appConfig = reassignedAgentsConfig;
    await expect(assembleMemoryPrompt(REQUESTER_AGENT_ID)).rejects.toThrow(
      `Unknown memory-wiki agentId: ${REQUESTER_AGENT_ID}.`,
    );
    await expect(assembleMemoryPrompt(SESSION_AGENT_ID)).resolves.toContain(SESSION_CLAIM);
  });
});
