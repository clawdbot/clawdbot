import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import type { CliBackendConfig, OpenClawConfig } from "../config/types.js";
import {
  cleanupSystemAgentSession,
  createSystemAgentSession,
  type SystemAgentSession,
} from "./agent-turn.js";
import { runSystemAgentTurnWithDeps, type SystemAgentTurnDeps } from "./agent-turn.test-support.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";
import { createSystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));

vi.mock("../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

type RunCliAgentParams = Parameters<NonNullable<SystemAgentTurnDeps["runCliAgent"]>>[0];
type RunEmbeddedAgentParams = Parameters<NonNullable<SystemAgentTurnDeps["runEmbeddedAgent"]>>[0];

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    meta: { finalAssistantVisibleText: "ready" },
  })),
}));

vi.mock("../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    runtimeConfig: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    sourceConfig: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    issues: [],
  })),
}));

const tempDirs: string[] = [];

function useTempStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-turn-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return stateDir;
}

function configSnapshot(config: OpenClawConfig) {
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: [],
  };
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function createVerifiedSession(config: OpenClawConfig) {
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(config);
  return {
    ...fixture,
    session: createSystemAgentSession(fixture.binding),
  };
}

const cliBackendRouteChanges: Array<{
  name: string;
  first: CliBackendConfig;
  second: CliBackendConfig;
}> = [
  {
    name: "backend command",
    first: { command: "claude" },
    second: { command: "/opt/openclaw/bin/claude" },
  },
  {
    name: "effective model alias",
    first: { command: "claude", modelAliases: { current: "claude-opus-4-8" } },
    second: { command: "claude", modelAliases: { current: "claude-sonnet-5" } },
  },
  {
    name: "resume protocol",
    first: { command: "claude", resumeArgs: ["--resume", "{sessionId}", "--print", "{prompt}"] },
    second: {
      command: "claude",
      resumeArgs: ["--resume-session", "{sessionId}", "--print", "{prompt}"],
    },
  },
];

beforeEach(() => {
  // Core tests install a contract-level selectable backend instead of loading
  // a plugin's generated setup artifact from dist/.
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "anthropic",
        modelProvider: "anthropic",
        bundleMcp: true,
        bundleMcpMode: "claude-config-file",
        config: { command: "claude" },
        normalizeConfig: (config, context) => ({
          ...config,
          args: [
            ...(config.args ?? []),
            "--test-exec-policy",
            JSON.stringify(context?.config?.tools?.exec ?? null),
          ],
        }),
        nativeToolMode: "selectable",
        sideQuestionToolMode: "disabled",
        resolveExecutionArgs: (context) => context.baseArgs,
      },
    ],
  });
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runSystemAgentTurn", () => {
  it("keeps every turn on the verified profile and clears continuity on route drift", async () => {
    useTempStateDir();
    const verifiedConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
      auth: {
        profiles: { "openai:p2": { provider: "openai", mode: "api_key" } },
      },
    } satisfies OpenClawConfig;
    const configuredRoute = await resolveSystemAgentConfiguredRouteFromConfig(verifiedConfig);
    if (!configuredRoute) {
      throw new Error("missing test route");
    }
    const resolvedAuth = {
      apiKey: "test-key",
      profileId: "openai:p2",
      source: "profile:openai:p2",
      mode: "api-key" as const,
    };
    const authDeps = {
      ensureAuthProfileStore: vi.fn(() => ({
        version: 1,
        profiles: {
          "openai:p2": { type: "api_key", provider: "openai", key: "test-key" },
        },
      })) as never,
      resolveApiKeyForProvider: vi.fn(async () => resolvedAuth),
    };
    const executionRoute = { ...configuredRoute, authProfileId: "openai:p2" };
    const authFingerprint = fingerprintResolvedProviderAuth(resolvedAuth);
    if (!authFingerprint) {
      throw new Error("missing test auth fingerprint");
    }
    const binding = await createSystemAgentVerifiedInferenceBinding({
      configuredRoute,
      executionRoute,
      auth: {
        authProfileId: "openai:p2",
        authFingerprint,
        agentHarnessId: "openclaw",
      },
      deps: authDeps,
    });
    const session = createSystemAgentSession(binding);
    let currentConfig: OpenClawConfig = verifiedConfig;
    const runEmbeddedAgent = vi.fn(async () => ({
      meta: { finalAssistantVisibleText: "ready" },
    }));
    const turn = async () =>
      await runSystemAgentTurnWithDeps(
        {
          input: "continue setup",
          overview: { defaultModel: "openai/gpt-5.5" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...authDeps,
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        },
      );

    await turn();
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:p2",
        authProfileIdSource: "user",
        config: binding.execution.runConfig,
      }),
    );

    currentConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    };
    await expect(turn()).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(session.verifiedInference).toBe(binding);
    expect(session.cliSession).toBeUndefined();
  });

  it("uses a distinct transcript for each chat session", async () => {
    useTempStateDir();
    const config = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const overview = { defaultModel: "openai/gpt-5.5" } as never;
    const fixture = await createSystemAgentVerifiedInferenceTestFixture(config);
    const first = createSystemAgentSession(fixture.binding);
    const second = createSystemAgentSession(fixture.binding);
    const deps = {
      ...fixture.deps,
      readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
    };

    await runSystemAgentTurnWithDeps(
      {
        input: "hello",
        overview,
        surface: "gateway",
        approvalArmed: false,
        session: first,
      },
      deps,
    );
    await runSystemAgentTurnWithDeps(
      {
        input: "hello",
        overview,
        surface: "gateway",
        approvalArmed: false,
        session: second,
      },
      deps,
    );

    const firstPath = requireValue(
      mocks.runEmbeddedAgent.mock.calls[0]?.[0]?.sessionFile,
      "missing first embedded transcript path",
    );
    const secondPath = requireValue(
      mocks.runEmbeddedAgent.mock.calls[1]?.[0]?.sessionFile,
      "missing second embedded transcript path",
    );
    expect(firstPath).toContain(`${first.sessionId}.jsonl`);
    expect(secondPath).toContain(`${second.sessionId}.jsonl`);
    expect(firstPath).not.toBe(secondPath);

    await fs.promises.writeFile(firstPath, "transcript");
    await cleanupSystemAgentSession(first);
    await expect(fs.promises.access(firstPath)).rejects.toThrow();
  });

  it("uses the default agent CLI route while keeping OpenClaw session identity", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-global" },
          cliBackends: { "claude-cli": { command: "claude" } },
        },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: { primary: "claude-cli/claude-opus-4-8@claude-cli:ops" },
          },
        ],
      },
    } as OpenClawConfig;
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
    }));
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      payloads: [],
    }));
    const { session, deps } = await createVerifiedSession(config);

    await runSystemAgentTurnWithDeps(
      {
        input: "hello",
        overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
        surface: "gateway",
        approvalArmed: false,
        session,
      },
      {
        ...deps,
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
      },
    );

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    const call = requireValue(runCliAgent.mock.calls[0]?.[0], "missing CLI runner call");
    expect(call).toMatchObject({
      provider: "claude-cli",
      model: "claude-opus-4-8",
      agentDir,
      authProfileId: "claude-cli:ops",
      agentId: "openclaw",
      sessionKey: "agent:openclaw:main",
      sessionId: session.sessionId,
      workspaceDir: path.join(stateDir, "openclaw", "workspace"),
      sessionFile: path.join(stateDir, "openclaw", "sessions", `${session.sessionId}.jsonl`),
      messageChannel: "openclaw",
      messageProvider: "openclaw",
    });
    expect(call.disableCliLiveSession).toBe(true);
    expect(call.cleanupCliLiveSessionOnRunEnd).toBe(true);
    expect(call.cliToolAvailability).toEqual({
      native: [],
      mcp: ["mcp__openclaw__openclaw"],
    });
    expect(call.toolsAllow).toBeUndefined();
    expect(requireValue(call.systemAgentTool, "missing CLI OpenClaw tool").proposalRef).toBe(
      session.proposalRef,
    );
  });

  it("rejects an always-on CLI backend before launching OpenClaw", async () => {
    useTempStateDir();
    const config = {
      agents: {
        defaults: {
          cliBackends: { "google-gemini-cli": { command: "gemini" } },
          model: "google-gemini-cli/gemini-3.1-pro-preview",
        },
      },
    } as OpenClawConfig;
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const { session, deps } = await createVerifiedSession(config);
    let failure: unknown;

    try {
      await runSystemAgentTurnWithDeps(
        {
          input: "set up my workspace",
          overview: { defaultModel: "google-gemini-cli/gemini-3.1-pro-preview" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          runCliAgent: runCliAgent as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect((failure as SystemAgentInferenceUnavailableError).failures).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "CLI backend google-gemini-cli cannot enforce OpenClaw's exact tool availability",
        ),
      }),
    ]);
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("resumes Claude's native transcript through fresh per-turn processes", async () => {
    const stateDir = useTempStateDir();
    const config = {
      agents: {
        defaults: {
          cliBackends: { "claude-cli": { command: "claude" } },
          model: "claude-cli/claude-opus-4-8@claude-cli:ops",
        },
      },
    } as OpenClawConfig;
    const binding = {
      sessionId: "native-claude-session",
      authProfileId: "claude-cli:ops",
      authEpochVersion: 1,
    };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const { session, deps } = await createVerifiedSession(config);
    const turn = async (input: string) =>
      await runSystemAgentTurnWithDeps(
        {
          input,
          overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        },
      );

    await turn("propose setup");
    await turn("yes");

    const firstCall = requireValue(runCliAgent.mock.calls[0]?.[0], "missing first CLI call");
    const secondCall = requireValue(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
    expect(firstCall.cliSessionBinding).toBeUndefined();
    expect(secondCall.cliSessionBinding).toEqual(binding);
    expect(firstCall).toMatchObject({
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
    });
    expect(secondCall).toMatchObject({
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
    });
    const transcript = path.join(stateDir, "openclaw", "sessions", `${session.sessionId}.jsonl`);
    await fs.promises.writeFile(transcript, "transcript");

    await cleanupSystemAgentSession(session);

    expect(session.cliSession).toBeUndefined();
    await expect(fs.promises.access(transcript)).rejects.toThrow();
  });

  it("runs a canonical Anthropic model through its configured Claude CLI runtime", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: { cliBackends: { "claude-cli": { command: "claude" } } },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: { primary: "anthropic/claude-opus-4-8@anthropic:claude-cli" },
            models: {
              "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
    }));
    const { session, deps } = await createVerifiedSession(config);

    await runSystemAgentTurnWithDeps(
      {
        input: "hello",
        overview: { defaultModel: "anthropic/claude-opus-4-8" } as never,
        surface: "gateway",
        approvalArmed: false,
        session,
      },
      {
        ...deps,
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
          payloads: [],
        })) as never,
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
      },
    );

    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "claude-opus-4-8",
        agentDir,
        authProfileId: "anthropic:claude-cli",
      }),
    );
  });

  it("reuses the guarded CLI binding when a denied proposal becomes approved", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: { cliBackends: { "claude-cli": { command: "claude" } } },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: "claude-cli/claude-opus-4-8@claude-cli:ops",
          },
        ],
      },
    } as OpenClawConfig;
    const binding = {
      sessionId: "native-claude-session",
      authProfileId: "claude-cli:ops",
      authEpoch: "auth-epoch",
      authEpochVersion: 1,
      cwdHash: "cwd-hash",
      mcpResumeHash: "openclaw-mcp-resume",
    };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const { session, deps } = await createVerifiedSession(config);
    const readConfigFileSnapshot = vi.fn(async () => configSnapshot(config)) as never;

    await runSystemAgentTurnWithDeps(
      {
        input: "set the default model",
        overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
        surface: "gateway",
        approvalArmed: false,
        session,
      },
      { ...deps, runCliAgent: runCliAgent as never, readConfigFileSnapshot },
    );
    // Mirrors the denied tool result that arms the exact-operation hash.
    session.proposalRef.current = "proposal-sha256";
    await runSystemAgentTurnWithDeps(
      {
        input: "yes",
        overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
        surface: "gateway",
        approvalArmed: true,
        session,
      },
      { ...deps, runCliAgent: runCliAgent as never, readConfigFileSnapshot },
    );

    expect(runCliAgent).toHaveBeenCalledTimes(2);
    const firstCall = requireValue(runCliAgent.mock.calls[0]?.[0], "missing first CLI call");
    const secondCall = requireValue(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
    expect(firstCall.cliSessionBinding).toBeUndefined();
    expect(secondCall).toMatchObject({
      cliSessionBinding: binding,
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
      systemAgentTool: {
        approvalArmed: true,
        proposalRef: { current: "proposal-sha256" },
      },
    });
  });

  it("rejects a configured auth-route change without resuming the CLI binding", async () => {
    useTempStateDir();
    const configForProfile = (profileId: string) =>
      ({
        agents: {
          defaults: {
            cliBackends: { "claude-cli": { command: "claude" } },
            model: `claude-cli/claude-opus-4-8@${profileId}`,
          },
        },
      }) as OpenClawConfig;
    const binding = { sessionId: "native-claude-session", authEpochVersion: 1 };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(configForProfile("claude-cli:ops")))
      .mockResolvedValueOnce(configSnapshot(configForProfile("claude-cli:ops")))
      .mockResolvedValueOnce(configSnapshot(configForProfile("claude-cli:other")));
    const { session, deps } = await createVerifiedSession(configForProfile("claude-cli:ops"));
    const turn = async () =>
      await runSystemAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
        },
      );

    await turn();
    await expect(turn()).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(session.cliSession).toBeUndefined();
  });

  it.each(cliBackendRouteChanges)(
    "rejects a $name change without resuming the CLI binding",
    async ({ first, second }) => {
      useTempStateDir();
      const configForBackend = (backend: CliBackendConfig) =>
        ({
          agents: {
            defaults: {
              cliBackends: { "claude-cli": backend },
              model: "claude-cli/current@claude-cli:ops",
            },
          },
        }) as OpenClawConfig;
      const binding = {
        sessionId: "native-claude-session",
        authProfileId: "claude-cli:ops",
        authEpoch: "auth-epoch",
        authEpochVersion: 4,
        cwdHash: "cwd-hash",
        mcpResumeHash: "resume-hash",
      };
      const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
        payloads: [{ text: "ready" }],
        meta: { agentMeta: { cliSessionBinding: binding } },
      }));
      const readConfigFileSnapshot = vi
        .fn()
        .mockResolvedValueOnce(configSnapshot(configForBackend(first)))
        .mockResolvedValueOnce(configSnapshot(configForBackend(first)))
        .mockResolvedValueOnce(configSnapshot(configForBackend(second)));
      const { session, deps } = await createVerifiedSession(configForBackend(first));
      const turn = async () =>
        await runSystemAgentTurnWithDeps(
          {
            input: "hello",
            overview: { defaultModel: "claude-cli/current" } as never,
            surface: "gateway",
            approvalArmed: false,
            session,
          },
          {
            ...deps,
            runCliAgent: runCliAgent as never,
            readConfigFileSnapshot: readConfigFileSnapshot as never,
          },
        );

      await turn();
      await expect(turn()).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);

      expect(runCliAgent).toHaveBeenCalledOnce();
      const firstCall = requireValue(runCliAgent.mock.calls[0]?.[0], "missing first CLI call");
      expect(firstCall.cliSessionBinding).toBeUndefined();
      expect(session.cliSession).toBeUndefined();
    },
  );

  it("rejects an alias-identity change without resuming the CLI binding", async () => {
    useTempStateDir();
    const configForModel = (model: string) =>
      ({
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
                modelAliases: {
                  current: "claude-opus-4-8",
                  stable: "claude-opus-4-8",
                },
              },
            },
            model: `claude-cli/${model}@claude-cli:ops`,
          },
        },
      }) as OpenClawConfig;
    const binding = { sessionId: "native-claude-session", authEpochVersion: 1 };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(configForModel("current")))
      .mockResolvedValueOnce(configSnapshot(configForModel("current")))
      .mockResolvedValueOnce(configSnapshot(configForModel("stable")));
    const { session, deps } = await createVerifiedSession(configForModel("current"));
    const turn = async () =>
      await runSystemAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
        },
      );

    await turn();
    await expect(turn()).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(session.cliSession).toBeUndefined();
  });

  it("rejects an executable-policy change and invalidates CLI continuity", async () => {
    useTempStateDir();
    const configForGlobalPolicy = (security: "full" | "deny", ask: "off" | "always") =>
      ({
        tools: { exec: { security, ask } },
        agents: {
          defaults: {
            cliBackends: { "claude-cli": { command: "claude" } },
            model: "claude-cli/claude-opus-4-8@claude-cli:ops",
          },
          list: [
            {
              id: "ops",
              default: true,
              // Keep the model owner's policy stable. OpenClaw executes with
              // its own identity and therefore follows the changing global policy.
              tools: { exec: { security: "allowlist", ask: "on-miss" } },
            },
          ],
        },
      }) as OpenClawConfig;
    const binding = {
      sessionId: "native-claude-session",
      authProfileId: "claude-cli:ops",
      authEpochVersion: 1,
    };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(configForGlobalPolicy("full", "off")))
      .mockResolvedValueOnce(configSnapshot(configForGlobalPolicy("full", "off")))
      .mockResolvedValueOnce(configSnapshot(configForGlobalPolicy("deny", "always")));
    const { session, deps } = await createVerifiedSession(configForGlobalPolicy("full", "off"));
    const turn = async () =>
      await runSystemAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
        },
      );

    await turn();
    await expect(turn()).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(session.cliSession).toBeUndefined();
  });

  it("rejects an intervening embedded route before it can revive CLI continuity", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const cliConfig = {
      agents: {
        defaults: { cliBackends: { "claude-cli": { command: "claude" } } },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: "claude-cli/claude-opus-4-8@claude-cli:ops",
          },
        ],
      },
    } as OpenClawConfig;
    const embeddedConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: "openai/gpt-5.4@openai:ops",
            models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } as OpenClawConfig;
    const binding = { sessionId: "native-claude-session", authEpochVersion: 1 };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "cli" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      payloads: [{ text: "embedded" }],
    }));
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(cliConfig))
      .mockResolvedValueOnce(configSnapshot(cliConfig))
      .mockResolvedValueOnce(configSnapshot(embeddedConfig));
    const { session, deps } = await createVerifiedSession(cliConfig);
    const turn = async (input: string) =>
      await runSystemAgentTurnWithDeps(
        {
          input,
          overview: { defaultModel: "configured" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          runCliAgent: runCliAgent as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
        },
      );

    await turn("first CLI turn");
    expect(session.cliSession?.binding.sessionId).toBe(binding.sessionId);
    await expect(turn("embedded turn")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    expect(session.cliSession).toBeUndefined();

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("uses the default agent embedded model, auth directory, profile, and runtime", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-global" },
          models: {
            "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
          },
        },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: { primary: "openai/gpt-5.4@openai:ops" },
            params: { temperature: 0.2 },
            tools: { allow: ["read"], deny: ["exec"] },
            models: {
              "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
            },
          },
          {
            id: "openclaw",
            params: { temperature: 1.7 },
            tools: { allow: ["exec"] },
          },
        ],
      },
    } as OpenClawConfig;
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({ payloads: [] }));
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      payloads: [{ text: "ready" }],
    }));
    const { session, deps } = await createVerifiedSession(config);

    await runSystemAgentTurnWithDeps(
      {
        input: "hello",
        overview: { defaultModel: "openai/gpt-5.4" } as never,
        surface: "gateway",
        approvalArmed: false,
        session,
      },
      {
        ...deps,
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
      },
    );

    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(runCliAgent).not.toHaveBeenCalled();
    const call = requireValue(runEmbeddedAgent.mock.calls[0]?.[0], "missing embedded runner call");
    expect(call).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      agentDir,
      authProfileId: "openai:ops",
      authProfileIdSource: "user",
      agentHarnessRuntimeOverride: "codex",
      agentId: "openclaw",
      sessionKey: "agent:openclaw:main",
      sessionId: session.sessionId,
      workspaceDir: path.join(stateDir, "openclaw", "workspace"),
      sessionFile: path.join(stateDir, "openclaw", "sessions", `${session.sessionId}.jsonl`),
      messageChannel: "openclaw",
      messageProvider: "openclaw",
      toolsAllow: ["openclaw"],
      disableMessageTool: true,
    });
    expect(call.agentHarnessId).toBeUndefined();
    expect(call.config?.agents?.list?.find((agent) => agent.id === "openclaw")).toEqual({
      id: "openclaw",
      params: { temperature: 0.2 },
      tools: { allow: ["read"], deny: ["exec"] },
    });
    expect(requireValue(call.systemAgentTool, "missing embedded OpenClaw tool").proposalRef).toBe(
      session.proposalRef,
    );
  });

  it("rejects a low-level session without verified inference before lookup or run", async () => {
    useTempStateDir();
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const readConfigFileSnapshot = vi.fn(async () =>
      configSnapshot({ agents: { defaults: { model: "openai/gpt-5.5" } } }),
    );
    const unverifiedSession = {
      sessionId: "openclaw-unverified",
      proposalRef: {},
    } as unknown as SystemAgentSession;

    await expect(
      runSystemAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/stale-overview-model" } as never,
          surface: "gateway",
          approvalArmed: false,
          session: unverifiedSession,
        },
        {
          runCliAgent: runCliAgent as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
        },
      ),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("converts route-planning failures to a typed error and clears session state", async () => {
    useTempStateDir();
    const config = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } satisfies OpenClawConfig;
    const { session, deps } = await createVerifiedSession(config);
    session.proposalRef.current = "partial-proposal";
    session.cliSession = {
      routeKey: "stale-route",
      binding: { sessionId: "uncertain-cli-session" },
    };

    await expect(
      runSystemAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/gpt-5.5" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          readConfigFileSnapshot: vi.fn(async () => {
            throw new Error("config read failed");
          }) as never,
        },
      ),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.cliSession).toBeUndefined();
  });

  it.each([
    {
      name: "runner rejection",
      runEmbeddedAgent: async () => {
        throw new Error("provider unavailable");
      },
    },
    {
      name: "empty model output",
      runEmbeddedAgent: async () => ({ payloads: [] }),
    },
  ])("clears partial session state after $name", async ({ runEmbeddedAgent }) => {
    useTempStateDir();
    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };
    const { session, deps } = await createVerifiedSession(config);
    session.proposalRef.current = "partial-proposal";
    session.cliSession = {
      routeKey: "stale-route",
      binding: { sessionId: "uncertain-cli-session" },
    };

    await expect(
      runSystemAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/gpt-5.5" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        },
      ),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.cliSession).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
