/** Tests agent command compaction rotation and persisted transcript/session updates. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../config/sessions.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { runAgentAttempt } from "./command/attempt-execution.runtime.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent.js";
import type { loadManifestModelCatalog } from "./model-catalog.js";

type ProviderModelNormalizationParams = { provider: string; context: { modelId: string } };
type LoadManifestModelCatalogParams = Parameters<typeof loadManifestModelCatalog>[0];
type RunAgentAttempt = typeof runAgentAttempt;

const state = vi.hoisted(() => ({
  cfg: undefined as OpenClawConfig | undefined,
  workspaceDir: undefined as string | undefined,
  agentDir: undefined as string | undefined,
  runAgentAttemptMock: vi.fn<RunAgentAttempt>(),
  loadManifestModelCatalogMock: vi.fn((_params: LoadManifestModelCatalogParams) => []),
  normalizeProviderModelIdWithRuntimeMock: vi.fn(
    (_params: ProviderModelNormalizationParams) => undefined,
  ),
  deliveryFreshEntries: [] as Array<SessionEntry | undefined>,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => state.cfg,
  readConfigFileSnapshotForWrite: async () => ({ snapshot: { valid: false } }),
}));

vi.mock("./agent-runtime-config.js", () => ({
  resolveAgentRuntimeConfig: async () => ({
    loadedRaw: state.cfg,
    sourceConfig: state.cfg,
    cfg: state.cfg,
  }),
}));

vi.mock("./agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  return {
    ...actual,
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    entryMatchesAutoFallbackPrimaryProbe: () => false,
    hasSessionAutoModelFallbackProvenance: () => false,
    listAgentIds: () => ["main"],
    markAutoFallbackPrimaryProbe: vi.fn(),
    resolveAutoFallbackPrimaryProbe: () => undefined,
    resolveAgentConfig: () => undefined,
    resolveAgentDir: () => state.agentDir ?? "/tmp/openclaw-agent",
    resolveDefaultAgentId: () => "main",
    resolveEffectiveModelFallbacks: () => undefined,
    resolveSessionAgentId: () => "main",
    resolveAgentWorkspaceDir: () => state.workspaceDir ?? "/tmp/openclaw-workspace",
  };
});

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({ plugins: [] }),
}));

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: (params: LoadManifestModelCatalogParams) =>
    state.loadManifestModelCatalogMock(params),
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: {
    provider: string;
    context: { modelId: string };
  }) => state.normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("./workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async () => undefined),
}));

vi.mock("./auth-profiles/store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-profiles/store.js")>(
    "./auth-profiles/store.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ profiles: {} }),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => ({ profiles: {} })),
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => null,
  }),
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({ enabled: false, reason: "test" }),
}));

vi.mock("../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: () => ({
    shouldRefresh: true,
    snapshot: {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    },
  }),
}));

vi.mock("./exec-defaults.js", () => ({
  canExecRequestNode: () => false,
}));

vi.mock("./model-fallback.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("./command/attempt-execution.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./command/attempt-execution.runtime.js")>(
    "./command/attempt-execution.runtime.js",
  );
  return {
    ...actual,
    runAgentAttempt: (...args: Parameters<RunAgentAttempt>) => state.runAgentAttemptMock(...args),
  };
});

vi.mock("./command/cli-compaction.js", () => ({
  runCliTurnCompactionLifecycle: async (params: { sessionEntry?: SessionEntry }) =>
    params.sessionEntry,
}));

vi.mock("./command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: async (params: {
    resolveFreshSessionEntryForDelivery?: () => Promise<SessionEntry | undefined>;
  }) => {
    state.deliveryFreshEntries.push(await params.resolveFreshSessionEntryForDelivery?.());
    return { deliverySucceeded: true };
  },
}));

let agentCommand: typeof import("./agent-command.js").agentCommand;

beforeAll(async () => {
  agentCommand = (await import("./agent-command.js")).agentCommand;
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.loadManifestModelCatalogMock.mockReturnValue([]);
  state.normalizeProviderModelIdWithRuntimeMock.mockImplementation(() => undefined);
  state.deliveryFreshEntries = [];
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rotation-e2e-"));
  state.workspaceDir = path.join(tmpDir, "workspace");
  state.agentDir = path.join(tmpDir, "agent");
  await fs.mkdir(state.workspaceDir, { recursive: true });
  await fs.mkdir(state.agentDir, { recursive: true });
  state.cfg = {
    session: {
      store: path.join(tmpDir, "sessions.json"),
    },
    agents: {
      defaults: {
        models: {
          "openai/gpt-5.5": {},
        },
      },
    },
  } as OpenClawConfig;
});

afterEach(async () => {
  const storePath = state.cfg?.session?.store;
  state.cfg = undefined;
  state.workspaceDir = undefined;
  state.agentDir = undefined;
  if (storePath) {
    await fs.rm(path.dirname(storePath), { recursive: true, force: true });
  }
});

function makeResult(params: {
  sessionId: string;
  sessionFile?: string;
  text: string;
  compactionCount?: number;
}): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: params.text }],
    meta: {
      durationMs: 1,
      stopReason: "end_turn",
      executionTrace: {
        runner: "embedded" as const,
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.5",
      },
      finalAssistantVisibleText: params.text,
      agentMeta: {
        sessionId: params.sessionId,
        ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
        provider: "openai",
        model: "gpt-5.5",
        ...(params.compactionCount ? { compactionCount: params.compactionCount } : {}),
      },
    },
  };
}

async function readSessionMessages(sessionFile: string) {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } })
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

function requireStorePath(): string {
  const storePath = state.cfg?.session?.store;
  if (!storePath) {
    throw new Error("missing test session store path");
  }
  return storePath;
}

describe("agentCommand compaction transcript rotation", () => {
  it("does not re-normalize an exact configured custom provider through plugin runtime", async () => {
    state.normalizeProviderModelIdWithRuntimeMock.mockImplementation(
      ({ provider }: ProviderModelNormalizationParams) => {
        if (provider === "tui-pty-mock") {
          throw new Error("custom provider should not use plugin runtime normalization");
        }
        return undefined;
      },
    );
    state.cfg = {
      ...state.cfg,
      plugins: {
        enabled: false,
      },
      agents: {
        defaults: {
          model: { primary: "tui-pty-mock/gpt-5.5" },
          models: {
            "tui-pty-mock/gpt-5.5": {},
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          "tui-pty-mock": {
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "test",
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "gpt-5.5",
                name: "GPT 5.5",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "custom-provider-session",
        text: "custom answer",
      }),
    );

    await agentCommand({
      message: "custom provider prompt",
      sessionId: "custom-provider-session",
      cwd: state.workspaceDir,
    });

    const attempt = state.runAgentAttemptMock.mock.calls[0]?.[0] as
      | { providerOverride?: string; modelOverride?: string; pluginsEnabled?: boolean }
      | undefined;
    expect(attempt).toMatchObject({
      providerOverride: "tui-pty-mock",
      modelOverride: "gpt-5.5",
      pluginsEnabled: false,
    });
    expect(state.normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "tui-pty-mock" }),
    );
    expect(state.loadManifestModelCatalogMock).not.toHaveBeenCalled();
  });

  it("keeps sessions.json on the rotated successor", async () => {
    const storePath = requireStorePath();
    const sessionsDir = await fs.realpath(path.dirname(storePath));
    const rotatedSessionFile = path.join(sessionsDir, "rotated-session.jsonl");
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "rotated-session",
        sessionFile: rotatedSessionFile,
        text: "first answer after rotation",
        compactionCount: 1,
      }),
    );

    await agentCommand({
      message: "first prompt",
      sessionId: "old-session",
      cwd: state.workspaceDir,
    });

    const storeAfterRotation = loadSessionStore(storePath, { skipCache: true });
    const entriesAfterRotation = Object.entries(storeAfterRotation);
    expect(entriesAfterRotation).toHaveLength(1);
    const [sessionKey, rotatedEntry] = entriesAfterRotation[0] ?? [];
    expect(sessionKey).toBe("agent:main:explicit:old-session");
    expect(rotatedEntry).toMatchObject({
      sessionId: "rotated-session",
      sessionFile: rotatedSessionFile,
      usageFamilyKey: "agent:main:explicit:old-session",
      usageFamilySessionIds: ["old-session", "rotated-session"],
      compactionCount: 1,
    });
    await expect(readSessionMessages(rotatedSessionFile)).resolves.toEqual([
      expect.objectContaining({ role: "assistant" }),
    ]);
  });

  it("resumes the next turn from the rotated successor", async () => {
    const storePath = requireStorePath();
    const sessionsDir = await fs.realpath(path.dirname(storePath));
    const rotatedSessionFile = path.join(sessionsDir, "rotated-session.jsonl");
    const sessionKey = "agent:main:explicit:old-session";
    await fs.writeFile(
      rotatedSessionFile,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "rotated-session",
        timestamp: new Date(0).toISOString(),
        cwd: state.workspaceDir,
      })}\n`,
      "utf-8",
    );
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "rotated-session",
        sessionFile: rotatedSessionFile,
        updatedAt: Date.now(),
        usageFamilyKey: sessionKey,
        usageFamilySessionIds: ["old-session", "rotated-session"],
        compactionCount: 1,
      },
    });
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "rotated-session",
        text: "second answer",
      }),
    );

    await agentCommand({
      message: "second prompt",
      sessionId: "rotated-session",
      cwd: state.workspaceDir,
    });

    const secondAttempt = state.runAgentAttemptMock.mock.calls[0]?.[0] as
      | { sessionId?: string; sessionFile?: string; sessionKey?: string }
      | undefined;
    expect(secondAttempt).toMatchObject({
      sessionId: "rotated-session",
      sessionKey,
      sessionFile: rotatedSessionFile,
    });
    expect(state.deliveryFreshEntries.at(-1)).toMatchObject({
      sessionId: "rotated-session",
      sessionFile: rotatedSessionFile,
    });
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey ?? ""]).toMatchObject({
      sessionId: "rotated-session",
      sessionFile: rotatedSessionFile,
    });
  });
});
