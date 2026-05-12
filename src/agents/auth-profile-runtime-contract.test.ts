import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUTH_PROFILE_RUNTIME_CONTRACT,
  createAuthAliasManifestRegistry,
  expectedForwardedAuthProfile,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type * as ManifestRegistryModule from "../plugins/manifest-registry.js";
import { runAgentAttempt } from "./command/attempt-execution.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "./pi-embedded.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

type LoadPluginManifestRegistry = typeof ManifestRegistryModule.loadPluginManifestRegistry;

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<LoadPluginManifestRegistry>(() => ({
    plugins: [],
    diagnostics: [],
  })),
);
const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedPiAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry,
  };
});

vi.mock("../plugins/manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex: loadPluginManifestRegistry,
  };
});

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshot: () => ({ plugins: [] }),
  };
});

vi.mock("./cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("./model-selection.js", () => ({
  isCliProvider: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    return (
      normalized === AUTH_PROFILE_RUNTIME_CONTRACT.claudeCliProvider ||
      normalized === AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider
    );
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("./pi-embedded.js", () => ({
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
}));

function mockCallArg(
  mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  argIndex = 0,
): unknown {
  const call = mockFn.mock.calls[0];
  if (!call) {
    throw new Error("expected mock to be called");
  }
  return call[argIndex];
}

function capturedCliRunParams(): { authProfileId?: string } {
  expect(runCliAgentMock).toHaveBeenCalledTimes(1);
  return mockCallArg(runCliAgentMock) as { authProfileId?: string };
}

function capturedEmbeddedRunParams(): RunEmbeddedPiAgentParams {
  expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
  return mockCallArg(runEmbeddedPiAgentMock) as RunEmbeddedPiAgentParams;
}

function makeCliResult(text: string): EmbeddedPiRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        model: "gpt-5.4",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      executionTrace: {
        winnerProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        winnerModel: "gpt-5.4",
        fallbackUsed: false,
        runner: "cli",
      },
    },
  };
}

function makeEmbeddedResult(text: string): EmbeddedPiRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        model: "gpt-5.4",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      executionTrace: {
        winnerProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        winnerModel: "gpt-5.4",
        fallbackUsed: false,
        runner: "embedded",
      },
    },
  };
}

function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://api.openclaw.test/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

async function runAuthContractAttempt(params: {
  tmpDir: string;
  storePath: string;
  providerOverride: string;
  authProfileProvider: string;
  authProfileOverride: string;
  cfg?: OpenClawConfig;
  sessionHasHistory?: boolean;
}) {
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  const sessionEntry: SessionEntry = {
    sessionId: AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
    updatedAt: Date.now(),
    authProfileOverride: params.authProfileOverride,
    authProfileOverrideSource: "user",
  };
  const sessionStore: Record<string, SessionEntry> = {
    [AUTH_PROFILE_RUNTIME_CONTRACT.sessionKey]: sessionEntry,
  };
  await fs.writeFile(params.storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

  await runAgentAttempt({
    providerOverride: params.providerOverride,
    originalProvider: params.providerOverride,
    modelOverride: "gpt-5.4",
    cfg,
    sessionEntry,
    sessionId: sessionEntry.sessionId,
    sessionKey: AUTH_PROFILE_RUNTIME_CONTRACT.sessionKey,
    sessionAgentId: "main",
    sessionFile: path.join(params.tmpDir, "session.jsonl"),
    workspaceDir: params.tmpDir,
    body: AUTH_PROFILE_RUNTIME_CONTRACT.workspacePrompt,
    isFallbackRetry: false,
    resolvedThinkLevel: "medium",
    timeoutMs: 1_000,
    runId: AUTH_PROFILE_RUNTIME_CONTRACT.runId,
    opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
    runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
    spawnedBy: undefined,
    messageChannel: undefined,
    skillsSnapshot: undefined,
    resolvedVerboseLevel: undefined,
    agentDir: params.tmpDir,
    onAgentEvent: vi.fn(),
    authProfileProvider: params.authProfileProvider,
    sessionStore,
    storePath: params.storePath,
    sessionHasHistory: params.sessionHasHistory ?? false,
  });

  return {
    aliasLookupParams: {
      config: cfg,
      workspaceDir: params.tmpDir,
    },
  };
}

describe("Auth profile runtime contract - Pi and CLI adapter", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-contract-"));
    storePath = path.join(tmpDir, "sessions.json");
    loadPluginManifestRegistry.mockReset().mockReturnValue(createAuthAliasManifestRegistry());
    runCliAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
    runCliAgentMock.mockResolvedValue(makeCliResult("ok"));
    runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedResult("ok"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each([
    [AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider],
    [
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
    ],
    [
      AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
    ],
    [
      AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider,
      AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider,
    ],
  ] as const)(
    "resolves %s through the provider auth alias resolver using a mocked manifest",
    (provider, expectedAuthProvider) => {
      expect(
        resolveProviderIdForAuth(provider, {
          config: {} as OpenClawConfig,
          workspaceDir: tmpDir,
        }),
      ).toBe(expectedAuthProvider);
    },
  );

  it("forwards an OpenAI Codex auth profile when the selected provider is codex-cli", async () => {
    const { aliasLookupParams } = await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(capturedCliRunParams().authProfileId).toBe(
      expectedForwardedAuthProfile({
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        aliasLookupParams,
        sessionAuthProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      }),
    );
  });

  it("forwards an OpenAI Codex auth profile when the auth provider is the legacy codex-cli alias", async () => {
    const { aliasLookupParams } = await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(capturedCliRunParams().authProfileId).toBe(
      expectedForwardedAuthProfile({
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        aliasLookupParams,
        sessionAuthProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      }),
    );
  });

  it("does not leak an OpenAI API-key auth profile into the Codex CLI alias", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProfileId,
    });

    expect(capturedCliRunParams().authProfileId).toBeUndefined();
  });

  it("does not leak an OpenAI Codex auth profile into an unrelated CLI provider", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.claudeCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(capturedCliRunParams().authProfileId).toBeUndefined();
  });

  it("does not let a configured Codex harness leak OpenAI Codex auth into unrelated CLI providers", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.claudeCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      cfg: {
        models: {
          providers: {
            [AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider]: {
              baseUrl: "https://api.openclaw.test/v1",
              agentRuntime: { id: "codex" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(capturedCliRunParams().authProfileId).toBeUndefined();
  });

  it("forwards an OpenAI Codex auth profile through the embedded Pi path", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(capturedEmbeddedRunParams().authProfileId).toBe(
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    );
  });

  it("accepts the legacy codex-cli auth-provider alias on the embedded OpenAI Codex path", async () => {
    const { aliasLookupParams } = await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(capturedEmbeddedRunParams().authProfileId).toBe(
      expectedForwardedAuthProfile({
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        aliasLookupParams,
        sessionAuthProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      }),
    );
  });

  it("forwards an OpenAI auth profile through the explicit embedded OpenAI PI path", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProfileId,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, "pi"),
    });

    const params = capturedEmbeddedRunParams();
    expect(params.provider).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider);
    expect(params.authProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProfileId);
  });

  it("forwards an OpenAI Codex auth profile through the default OpenAI Codex harness path", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(capturedEmbeddedRunParams().authProfileId).toBe(
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    );
  });

  it("routes explicit OpenAI PI runs with Codex OAuth through OpenAI Codex transport", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, "pi"),
    });

    const params = capturedEmbeddedRunParams();
    expect(params.provider).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider);
    expect(params.authProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId);
  });

  it("preserves OpenAI Codex auth profiles through the real codex/* harness startup path", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider, "codex"),
    });

    expect(capturedEmbeddedRunParams().authProfileId).toBe(
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    );
  });

  it("validates openai/* forced through the Codex harness can use OpenAI Codex OAuth profiles", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, "codex"),
    });

    expect(capturedEmbeddedRunParams().authProfileId).toBe(
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    );
  });

  it("preserves configured Codex harness when a skeleton session entry is considered history", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      sessionHasHistory: true,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, "codex"),
    });

    expect(capturedEmbeddedRunParams().authProfileId).toBe(
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    );
  });
});
