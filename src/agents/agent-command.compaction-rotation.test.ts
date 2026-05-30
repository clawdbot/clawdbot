import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const state = vi.hoisted(() => ({
  cfg: undefined as OpenClawConfig | undefined,
  workspaceDir: undefined as string | undefined,
  agentDir: undefined as string | undefined,
  runAgentAttemptMock: vi.fn(),
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
  loadManifestModelCatalog: () => [],
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
    runAgentAttempt: (...args: unknown[]) => state.runAgentAttemptMock(...args),
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

beforeEach(async () => {
  vi.clearAllMocks();
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
  agentCommand ??= (await import("./agent-command.js")).agentCommand;
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
}) {
  return {
    payloads: [{ text: params.text }],
    meta: {
      durationMs: 1,
      stopReason: "end_turn",
      executionTrace: {
        runner: "embedded",
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

describe("agentCommand compaction transcript rotation", () => {
  it("keeps sessions.json on the rotated successor and resumes the next turn from it", async () => {
    const storePath = state.cfg?.session?.store;
    if (!storePath) {
      throw new Error("missing test session store path");
    }
    const sessionsDir = await fs.realpath(path.dirname(storePath));
    const rotatedSessionFile = path.join(sessionsDir, "rotated-session.jsonl");
    state.runAgentAttemptMock
      .mockResolvedValueOnce(
        makeResult({
          sessionId: "rotated-session",
          sessionFile: rotatedSessionFile,
          text: "first answer after rotation",
          compactionCount: 1,
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          sessionId: "rotated-session",
          text: "second answer",
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

    await agentCommand({
      message: "second prompt",
      sessionId: "rotated-session",
      cwd: state.workspaceDir,
    });

    const secondAttempt = state.runAgentAttemptMock.mock.calls[1]?.[0] as
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
