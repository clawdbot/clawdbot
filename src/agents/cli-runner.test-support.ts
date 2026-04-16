import fs from "node:fs/promises";
import type { Mock } from "vitest";
import { beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import type { enqueueSystemEvent } from "../infra/system-events.js";
import type { CliBackendPlugin } from "../plugin-sdk/cli-backend.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "../plugin-sdk/cli-backend.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { getProcessSupervisor } from "../process/supervisor/index.js";
import { setCliAuthEpochTestDeps } from "./cli-auth-epoch.js";
import { setCliRunnerExecuteTestDeps } from "./cli-runner/execute.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];
type EnqueueSystemEventFn = typeof enqueueSystemEvent;
type RequestHeartbeatNowFn = typeof requestHeartbeatNow;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type BootstrapContext = {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};
type ResolveBootstrapContextForRunMock = Mock<() => Promise<BootstrapContext>>;

export const supervisorSpawnMock: UnknownMock = vi.fn();
export const enqueueSystemEventMock: UnknownMock = vi.fn();
export const requestHeartbeatNowMock: UnknownMock = vi.fn();
export const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
let cliRunnerModulePromise: Promise<typeof import("./cli-runner.js")> | undefined;

const hoisted = vi.hoisted(
  (): {
    resolveBootstrapContextForRunMock: ResolveBootstrapContextForRunMock;
  } => {
    return {
      resolveBootstrapContextForRunMock: vi.fn<() => Promise<BootstrapContext>>(async () => ({
        bootstrapFiles: [],
        contextFiles: [],
      })),
    };
  },
);

setCliRunnerExecuteTestDeps({
  getProcessSupervisor: () => ({
    spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
      supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
  enqueueSystemEvent: (
    text: Parameters<EnqueueSystemEventFn>[0],
    options: Parameters<EnqueueSystemEventFn>[1],
  ) => enqueueSystemEventMock(text, options) as ReturnType<EnqueueSystemEventFn>,
  requestHeartbeatNow: (options?: Parameters<RequestHeartbeatNowFn>[0]) =>
    requestHeartbeatNowMock(options) as ReturnType<RequestHeartbeatNowFn>,
});

setCliRunnerPrepareTestDeps({
  makeBootstrapWarn: () => () => {},
  resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
  resolveOpenClawDocsPath: async () => null,
});

type MockRunExit = {
  reason:
    | "manual-cancel"
    | "overall-timeout"
    | "no-output-timeout"
    | "spawn-error"
    | "signal"
    | "exit";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

type TestCliBackendConfig = {
  command: string;
  env?: Record<string, string>;
  clearEnv?: string[];
};

type ManagedRunMock = {
  runId: string;
  pid: number;
  startedAtMs: number;
  stdin: undefined;
  wait: Mock<() => Promise<MockRunExit>>;
  cancel: Mock<() => void>;
};

function buildOpenAICodexCliBackendFixture(): CliBackendPlugin {
  return {
    id: "codex-cli",
    bundleMcp: true,
    bundleMcpMode: "codex-config-overrides",
    config: {
      command: "codex",
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
      ],
      resumeArgs: [
        "exec",
        "resume",
        "{sessionId}",
        "-c",
        'sandbox_mode="workspace-write"',
        "--skip-git-repo-check",
      ],
      output: "jsonl",
      resumeOutput: "text",
      input: "arg",
      modelArg: "--model",
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
      systemPromptFileConfigArg: "-c",
      systemPromptFileConfigKey: "model_instructions_file",
      systemPromptWhen: "first",
      imageArg: "--image",
      imageMode: "repeat",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}

function buildAnthropicCliBackendFixture(): CliBackendPlugin {
  const clearEnv = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY_OLD",
    "ANTHROPIC_API_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_UNIX_SOCKET",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_PLUGIN_CACHE_DIR",
    "CLAUDE_CODE_PLUGIN_SEED_DIR",
    "CLAUDE_CODE_REMOTE",
    "CLAUDE_CODE_USE_COWORK_PLUGINS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    "OTEL_LOGS_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_SDK_DISABLED",
    "OTEL_TRACES_EXPORTER",
  ] as const;
  return {
    id: "claude-cli",
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    config: {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--setting-sources",
        "user",
        "--permission-mode",
        "bypassPermissions",
      ],
      resumeArgs: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--setting-sources",
        "user",
        "--permission-mode",
        "bypassPermissions",
        "--resume",
        "{sessionId}",
      ],
      output: "jsonl",
      input: "stdin",
      modelArg: "--model",
      modelAliases: {
        opus: "opus",
        "claude-opus-4-6": "opus",
        sonnet: "sonnet",
        "claude-sonnet-4-6": "sonnet",
        "claude-sonnet-4-5": "sonnet",
        haiku: "haiku",
      },
      sessionArg: "--session-id",
      sessionMode: "always",
      sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
      systemPromptArg: "--append-system-prompt",
      systemPromptMode: "append",
      systemPromptWhen: "first",
      clearEnv: [...clearEnv],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}

function buildGoogleGeminiCliBackendFixture(): CliBackendPlugin {
  return {
    id: "google-gemini-cli",
    bundleMcp: true,
    bundleMcpMode: "gemini-system-settings",
    config: {
      command: "gemini",
      args: ["--output-format", "json", "--prompt", "{prompt}"],
      resumeArgs: ["--resume", "{sessionId}", "--output-format", "json", "--prompt", "{prompt}"],
      output: "json",
      input: "arg",
      imageArg: "@",
      imagePathScope: "workspace",
      modelArg: "--model",
      modelAliases: {
        pro: "gemini-3.1-pro-preview",
        flash: "gemini-3.1-flash-preview",
        "flash-lite": "gemini-3.1-flash-lite-preview",
      },
      sessionMode: "existing",
      sessionIdFields: ["session_id", "sessionId"],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}

export function createManagedRun(
  exit: MockRunExit,
  pid = 1234,
): ManagedRunMock & Awaited<ReturnType<SupervisorSpawnFn>> {
  return {
    runId: "run-supervisor",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue(exit),
    cancel: vi.fn(),
  };
}

export function mockSuccessfulCliRun() {
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 50,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
  );
}

export const EXISTING_CODEX_CONFIG = {
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "codex",
          args: ["exec", "--json"],
          resumeArgs: ["exec", "resume", "{sessionId}", "--json"],
          output: "text",
          modelArg: "--model",
          sessionMode: "existing",
        },
      },
    },
  },
} satisfies OpenClawConfig;

export async function setupCliRunnerTestModule() {
  setupCliRunnerTestRegistry();
  cliRunnerModulePromise ??= import("./cli-runner.js");
  return (await cliRunnerModulePromise).runCliAgent;
}

export function setupCliRunnerTestRegistry() {
  setCliAuthEpochTestDeps({
    readClaudeCliCredentialsCached: () => null,
    readCodexCliCredentialsCached: () => null,
    loadAuthProfileStoreForRuntime: () => ({ version: 1, profiles: {} }),
  });
  const registry = createEmptyPluginRegistry();
  registry.cliBackends = [
    {
      pluginId: "anthropic",
      backend: buildAnthropicCliBackendFixture(),
      source: "test",
    },
    {
      pluginId: "openai",
      backend: buildOpenAICodexCliBackendFixture(),
      source: "test",
    },
    {
      pluginId: "google",
      backend: buildGoogleGeminiCliBackendFixture(),
      source: "test",
    },
  ];
  setActivePluginRegistry(registry);
  supervisorSpawnMock.mockClear();
  enqueueSystemEventMock.mockClear();
  requestHeartbeatNowMock.mockClear();
  hoisted.resolveBootstrapContextForRunMock.mockReset().mockResolvedValue({
    bootstrapFiles: [],
    contextFiles: [],
  });
}

export function stubBootstrapContext(params: {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}) {
  hoisted.resolveBootstrapContextForRunMock.mockResolvedValueOnce(params);
}

export function restoreCliRunnerPrepareTestDeps() {
  setCliRunnerPrepareTestDeps({
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
    resolveOpenClawDocsPath: async () => null,
  });
}

export async function runCliAgentWithBackendConfig(params: {
  runCliAgent: typeof import("./cli-runner.js").runCliAgent;
  backend: TestCliBackendConfig;
  runId: string;
}) {
  await params.runCliAgent({
    sessionId: "s1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp",
    config: {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": params.backend,
          },
        },
      },
    } satisfies OpenClawConfig,
    prompt: "hi",
    provider: "codex-cli",
    model: "gpt-5.4",
    timeoutMs: 1_000,
    runId: params.runId,
    cliSessionId: "thread-123",
  });
}

export async function runExistingCodexCliAgent(params: {
  runCliAgent: typeof import("./cli-runner.js").runCliAgent;
  runId: string;
  cliSessionBindingAuthProfileId: string;
  authProfileId: string;
}) {
  await params.runCliAgent({
    sessionId: "s1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp",
    config: EXISTING_CODEX_CONFIG,
    prompt: "hi",
    provider: "codex-cli",
    model: "gpt-5.4",
    timeoutMs: 1_000,
    runId: params.runId,
    cliSessionBinding: {
      sessionId: "thread-123",
      authProfileId: params.cliSessionBindingAuthProfileId,
    },
    authProfileId: params.authProfileId,
  });
}

export async function withTempImageFile(
  prefix: string,
): Promise<{ tempDir: string; sourceImage: string }> {
  const os = await import("node:os");
  const path = await import("node:path");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sourceImage = path.join(tempDir, "image.png");
  await fs.writeFile(sourceImage, Buffer.from(SMALL_PNG_BASE64, "base64"));
  return { tempDir, sourceImage };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
