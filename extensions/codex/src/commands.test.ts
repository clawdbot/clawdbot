// Codex tests cover commands plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  resolveDefaultAgentDir,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexComputerUseStatus } from "./app-server/computer-use.js";
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import type { JsonValue } from "./app-server/protocol.js";
import type { CodexAppServerThreadBinding } from "./app-server/session-binding.js";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./app-server/session-binding.test-helpers.js";
import { resetSharedCodexAppServerClientForTests } from "./app-server/shared-client.js";
import { codexDiagnosticsFeedbackState } from "./command-diagnostics-state.js";
import { handleCodexCommand } from "./command-dispatch.js";
import type { CodexCommandDepsOverride } from "./command-handlers.js";
import type {
  CodexPluginsConfigBlock,
  CodexPluginsManagementIO,
} from "./command-plugins-management.js";

type CodexPluginConfigEntry = NonNullable<CodexPluginsConfigBlock["plugins"]>[string];

let tempDir: string;

function createContext(
  args: string,
  sessionFile?: string,
  overrides: Partial<PluginCommandContext> = {},
): PluginCommandContext {
  return {
    channel: "test",
    isAuthorizedSender: true,
    senderIsOwner: true,
    senderId: "user-1",
    args,
    commandBody: `/codex ${args}`,
    config: {},
    sessionId: "session-1",
    sessionFile,
    requestConversationBinding: async () => ({ status: "error", message: "unused" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

function createSandboxedContext(
  args: string,
  sessionFile?: string,
  overrides: Partial<PluginCommandContext> = {},
): PluginCommandContext {
  return createContext(args, sessionFile, {
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
    sessionKey: "sandboxed-session",
    ...overrides,
  } as Partial<PluginCommandContext>);
}

function createNodeExecContext(
  args: string,
  sessionFile?: string,
  overrides: Partial<PluginCommandContext> = {},
): PluginCommandContext {
  return createContext(args, sessionFile, {
    config: { tools: { exec: { host: "node", node: "worker-1" } } },
    sessionKey: "node-session",
    ...overrides,
  } as Partial<PluginCommandContext>);
}

type CodexCommandDeps = CodexCommandDepsOverride & Record<string, unknown>;

function createDeps(overrides: Partial<CodexCommandDeps> = {}): CodexCommandDepsOverride {
  return {
    bindingStore: testCodexAppServerBindingStore,
    codexControlRequest: vi.fn(),
    listCodexAppServerModels: vi.fn(),
    readCodexStatusProbes: vi.fn(),
    requestOptions: vi.fn(
      (
        _pluginConfig: unknown,
        limit: number,
        config?: Parameters<NonNullable<CodexCommandDeps["requestOptions"]>>[2],
        _agentDir?: string,
      ) => ({
        limit,
        timeoutMs: 1000,
        startOptions: {
          transport: "stdio",
          command: "codex",
          args: ["app-server", "--listen", "stdio://"],
          headers: {},
        } satisfies CodexAppServerStartOptions,
        config,
        agentDir: _agentDir,
      }),
    ),
    safeCodexControlRequest: vi.fn(),
    ...overrides,
  };
}

function createThreadResumeResponse(params: {
  threadId: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
}) {
  const cwd = params.cwd ?? "/repo";
  const modelProvider = params.modelProvider ?? "openai";
  return {
    thread: {
      id: params.threadId,
      sessionId: params.threadId,
      cliVersion: "0.139.0",
      createdAt: 1,
      updatedAt: 1,
      cwd,
      ephemeral: false,
      modelProvider,
      preview: "",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
    },
    model: params.model ?? "gpt-5.4",
    modelProvider,
    cwd,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
  };
}

async function writeTestBinding(
  identity: Parameters<typeof testCodexAppServerBindingStore.mutate>[0],
  binding: CodexAppServerThreadBinding,
): Promise<void> {
  await testCodexAppServerBindingStore.mutate(identity, { kind: "set", binding });
}

function supervisedTestBinding(threadId = "thread-supervised"): CodexAppServerThreadBinding {
  return {
    threadId,
    connectionScope: "supervision",
    supervisionSourceThreadId: threadId,
    appServerRuntimeFingerprint: buildCodexSupervisionTestConnectionFingerprint(),
    cwd: "/repo",
    model: "gpt-5.5",
    modelProvider: "openai",
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
  };
}

async function createLockedSessionContextOverrides(
  sessionKey = "agent:main:test:locked",
): Promise<Pick<PluginCommandContext, "config" | "sessionKey">> {
  const storePath = path.join(tempDir, "locked-sessions.json");
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    },
  });
  return {
    config: { session: { store: storePath } },
    sessionKey,
  };
}

function inMemoryCodexPluginsIO(
  initial: Record<string, CodexPluginConfigEntry> = {},
  options: { enabled?: boolean } = { enabled: true },
): CodexPluginsManagementIO & {
  current: () => Record<string, CodexPluginConfigEntry>;
  currentConfig: () => CodexPluginsConfigBlock;
} {
  const store: CodexPluginsConfigBlock = {
    enabled: options.enabled,
    plugins: structuredClone(initial),
  };
  return {
    current: () => structuredClone(store.plugins ?? {}),
    currentConfig: () => structuredClone(store),
    readConfig: () => Promise.resolve(structuredClone(store)),
    mutate: async (update) => {
      update(store);
    },
  };
}

function readDiagnosticsConfirmationToken(
  result: PluginCommandResult,
  commandPrefix = "/codex diagnostics",
): string {
  const text = result.text ?? "";
  const token = new RegExp(`${escapeRegExp(commandPrefix)} confirm ([a-f0-9]{12})`).exec(text)?.[1];
  if (!token) {
    throw new Error(`expected ${commandPrefix} confirmation token in command output`);
  }
  return token;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireResultText(result: PluginCommandResult): string {
  if (typeof result.text !== "string") {
    throw new Error("expected command result text");
  }
  return result.text;
}

function expectResultTextContains(result: PluginCommandResult, expected: string): void {
  expect(requireResultText(result)).toContain(expected);
}

function buttonCommands(result: PluginCommandResult): string[] {
  const block = result.presentation?.blocks.find((candidate) => candidate.type === "buttons");
  if (!block || block.type !== "buttons") {
    throw new Error("expected button presentation");
  }
  return block.buttons.map((button) =>
    button.action?.type === "command" ? button.action.command : "",
  );
}

function installAuthProfileStore(
  store: AuthProfileStore,
  config: PluginCommandContext["config"],
  agentDir = resolveDefaultAgentDir(config),
) {
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir,
      store,
    },
  ]);
}

function codexRateLimitPayload(params: {
  primaryUsedPercent: number;
  secondaryUsedPercent: number;
  primaryResetSeconds: number;
  secondaryResetSeconds: number;
  reached?: boolean;
}) {
  return {
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: params.primaryUsedPercent,
          windowDurationMins: 300,
          resetsAt: params.primaryResetSeconds,
        },
        secondary: {
          usedPercent: params.secondaryUsedPercent,
          windowDurationMins: 10080,
          resetsAt: params.secondaryResetSeconds,
        },
        credits: null,
        planType: "plus",
        rateLimitReachedType: params.reached ? "rate_limit_reached" : null,
      },
    },
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function mockCall(mockFn: ReturnType<typeof vi.fn>, callIndex = 0): ReadonlyArray<unknown> {
  const call = mockFn.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call;
}

function mockArg(mockFn: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number) {
  return mockCall(mockFn, callIndex)[argIndex];
}
function requestParams(mockFn: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  return requireRecord(mockArg(mockFn, callIndex, 2), "expected request params object");
}

function expectedDiagnosticsTargetBlock(params: {
  index?: number;
  channel?: string;
  sessionKey?: string;
  sessionId?: string;
  threadId: string;
}): string[] {
  return [
    `Session ${params.index ?? 1}`,
    ...(params.channel ? [`Channel: ${params.channel}`] : []),
    ...(params.sessionKey ? [`OpenClaw session key: \`${params.sessionKey}\``] : []),
    ...(params.sessionId ? [`OpenClaw session id: \`${params.sessionId}\``] : []),
    `Codex thread id: \`${params.threadId}\``,
    `Inspect locally: \`codex resume ${params.threadId}\``,
  ];
}

describe("codex command", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-command-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(async () => {
    codexDiagnosticsFeedbackState.clear();
    resetSharedCodexAppServerClientForTests();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("escapes unknown subcommands before chat display", async () => {
    const result = await handleCodexCommand(
      createContext("<@U123> [trusted](https://evil) @here"),
      {
        deps: createDeps(),
      },
    );

    expect(result.text).toContain("Unknown Codex command: &lt;\uff20U123&gt;");
    expect(result.text).not.toContain("<@U123>");
  });

  it("keeps command loader failures on the Codex command surface", async () => {
    const result = await handleCodexCommand(createContext("account"), {
      deps: createDeps(),
      loadSubcommandHandler: async () => {
        throw new Error("<@U123> loader failed");
      },
    });

    expect(result.text).toContain("Codex command failed: &lt;\uff20U123&gt; loader failed");
    expect(result.text).not.toContain("<@U123>");
  });

  it("resolves one current plugin-config snapshot per command", async () => {
    const pluginConfig = { appServer: { mode: "guardian" } };
    const resolvePluginConfig = vi.fn(() => pluginConfig);
    const handler = vi.fn(
      async (_ctx: PluginCommandContext, options: { pluginConfig?: unknown }) => ({
        text: options.pluginConfig === pluginConfig ? "current" : "stale",
      }),
    );

    const result = await handleCodexCommand(createContext("status"), {
      pluginConfig: { appServer: { mode: "yolo" } },
      resolvePluginConfig,
      deps: createDeps(),
      loadSubcommandHandler: async () => handler,
    });

    expect(result).toEqual({ text: "current" });
    expect(resolvePluginConfig).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("renders the top-level Codex menu as portable native slash commands", async () => {
    const result = await handleCodexCommand(createContext(""), { deps: createDeps() });

    expectResultTextContains(result, "/codex plugins menu");
    expect(buttonCommands(result)).toEqual([
      "/codex plugins menu",
      "/codex permissions menu",
      "/codex fast menu",
      "/codex computer-use menu",
      "/codex account",
      "/codex help",
    ]);
  });

  it("routes /codex plugins menu to the Codex-owned plugin picker", async () => {
    const codexPluginsManagementIo = inMemoryCodexPluginsIO();

    const result = await handleCodexCommand(createContext("plugins menu"), {
      deps: createDeps({ codexPluginsManagementIo }),
    });

    expectResultTextContains(result, "/codex plugins enable");
    expect(buttonCommands(result)).toContain("/codex plugins list");
  });

  it("lists Codex sub-plugins through the /codex plugins command surface", async () => {
    const codexPluginsManagementIo = inMemoryCodexPluginsIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });

    const result = await handleCodexCommand(createContext("plugins list"), {
      deps: createDeps({ codexPluginsManagementIo }),
    });

    expectResultTextContains(result, "ON   google-calendar");
    expectResultTextContains(result, "openclaw.json");
  });

  it("enables and disables Codex sub-plugins through the /codex plugins command surface", async () => {
    const codexPluginsManagementIo = inMemoryCodexPluginsIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });

    const disabled = await handleCodexCommand(createContext("plugins disable google-calendar"), {
      deps: createDeps({ codexPluginsManagementIo }),
    });
    expectResultTextContains(disabled, "google-calendar: disabled in openclaw.json");
    expect(codexPluginsManagementIo.current()["google-calendar"]?.enabled).toBe(false);

    const enabled = await handleCodexCommand(createContext("plugins enable google-calendar"), {
      deps: createDeps({ codexPluginsManagementIo }),
    });
    expectResultTextContains(enabled, "google-calendar: enabled in openclaw.json");
    expect(codexPluginsManagementIo.currentConfig().enabled).toBe(true);
    expect(codexPluginsManagementIo.current()["google-calendar"]?.enabled).toBe(true);
  });

  it("attaches the current session to an existing Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: unknown; options: unknown }> = [];
    const deps = createDeps({
      codexControlRequest: vi.fn(
        async (
          _pluginConfig: unknown,
          method: string,
          requestParamsValue: unknown,
          options: unknown,
        ) => {
          requests.push({ method, params: requestParamsValue, options });
          return createThreadResumeResponse({ threadId: "thread-123" });
        },
      ),
    });

    await expect(
      handleCodexCommand(createContext("resume thread-123", sessionFile), { deps }),
    ).resolves.toEqual({
      text: "Attached this OpenClaw session to Codex thread thread-123.",
    });

    expect(requests).toEqual([
      {
        method: "thread/resume",
        params: { threadId: "thread-123", excludeTurns: true },
        options: expect.objectContaining({
          agentDir: path.join(tempDir, "agents", "main", "agent"),
          sessionId: "session-1",
        }),
      },
    ]);
    await expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      threadId: "thread-123",
      historyCoveredThrough: expect.any(String),
    });
  });

  it("serializes manual resume with other session binding owners", async () => {
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
    };
    const order: string[] = [];
    let resolveResume!: (value: ReturnType<typeof createThreadResumeResponse>) => void;
    const resumeResponse = new Promise<ReturnType<typeof createThreadResumeResponse>>((resolve) => {
      resolveResume = resolve;
    });
    const codexControlRequest = vi.fn(async () => {
      order.push("resume-start");
      const response = await resumeResponse;
      order.push("resume-done");
      return response;
    });

    const command = handleCodexCommand(createContext("resume thread-123"), {
      deps: createDeps({ codexControlRequest }),
    });
    await vi.waitFor(() => expect(codexControlRequest).toHaveBeenCalledTimes(1));
    const competingOwner = testCodexAppServerBindingStore.withLease(identity, async () => {
      order.push("competing-owner");
      await writeTestBinding(identity, { threadId: "thread-later", cwd: "/later" });
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(order).toEqual(["resume-start"]);

    resolveResume(createThreadResumeResponse({ threadId: "thread-123" }));
    await expect(command).resolves.toEqual({
      text: "Attached this OpenClaw session to Codex thread thread-123.",
    });
    await competingOwner;
    expect(order).toEqual(["resume-start", "resume-done", "competing-owner"]);
  });

  it("reclaims an unloaded plugin's stale generation before attaching a thread", async () => {
    const sessionKey = "agent:main:test:chat-1";
    const storePath = path.join(tempDir, "sessions.json");
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-old",
        sessionKey,
      },
      { threadId: "thread-old", cwd: "/old" },
    );
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "session-new", updatedAt: Date.now() },
    });
    const codexControlRequest = vi.fn(async () =>
      createThreadResumeResponse({ threadId: "thread-new" }),
    );

    const result = await handleCodexCommand(
      createContext("resume thread-new", undefined, {
        sessionId: "session-new",
        sessionKey,
        config: { session: { store: storePath } },
      }),
      { deps: createDeps({ codexControlRequest }) },
    );

    expect(result.text).toBe("Attached this OpenClaw session to Codex thread thread-new.");
    expect(codexControlRequest).toHaveBeenCalledTimes(1);
    await expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "main",
        sessionId: "session-new",
        sessionKey,
      }),
    ).resolves.toMatchObject({ threadId: "thread-new" });
  });

  it("does not report a resumed thread as attached after a generation conflict", async () => {
    const mutate = vi.fn(async () => false);
    const codexControlRequest = vi.fn(async () =>
      createThreadResumeResponse({ threadId: "thread-123", model: "gpt-5.5" }),
    );

    const result = await handleCodexCommand(createContext("resume thread-123"), {
      deps: createDeps({
        bindingStore: { ...testCodexAppServerBindingStore, mutate },
        codexControlRequest,
      }),
    });

    expect(result.text).toContain(
      "Codex thread binding changed while attaching the resumed thread",
    );
    expect(result.text).not.toContain("Attached this OpenClaw session");
  });

  it("normalizes resumed bindings against the requesting agent auth store", async () => {
    const agentDir = path.join(tempDir, "agents", "worker", "agent");
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: {
            "openai:work": {
              type: "oauth",
              provider: "openai",
              access: "scoped-access",
              refresh: "scoped-refresh",
              expires: Date.now() + 60_000,
            },
          },
          order: { openai: ["openai:work"] },
        },
      },
    ]);
    const codexControlRequest = vi.fn(async () =>
      createThreadResumeResponse({ threadId: "thread-123" }),
    );
    const storePath = path.join(tempDir, "worker-sessions.json");
    await upsertSessionEntry({
      agentId: "worker",
      storePath,
      sessionKey: "agent:worker:session-1",
      entry: { sessionId: "session-1", updatedAt: Date.now() },
    });

    await handleCodexCommand(
      createContext("resume thread-123", undefined, {
        sessionKey: "agent:worker:session-1",
        config: { session: { store: storePath } },
      }),
      { deps: createDeps({ codexControlRequest }) },
    );

    expect(codexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.resumeThread,
      expect.any(Object),
      expect.objectContaining({ agentDir, authProfileId: "openai:work" }),
    );
    await expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "worker",
        sessionId: "session-1",
        sessionKey: "agent:worker:session-1",
      }),
    ).resolves.toEqual({
      threadId: "thread-123",
      cwd: "/repo",
      authProfileId: "openai:work",
      model: "gpt-5.4",
      historyCoveredThrough: expect.any(String),
    });
  });

  it("uses the host agent for global session keys", async () => {
    const codexControlRequest = vi.fn(async () =>
      createThreadResumeResponse({ threadId: "thread-work", model: "gpt-5.5" }),
    );

    await handleCodexCommand(
      createContext("resume thread-work", undefined, {
        agentId: "work",
        sessionKey: "global",
        config: {
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
          session: { scope: "global" },
        },
      }),
      { deps: createDeps({ codexControlRequest }) },
    );

    await expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "work",
        sessionId: "session-1",
        sessionKey: "global",
      }),
    ).resolves.toMatchObject({ threadId: "thread-work" });
    await expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "global",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects malformed resume commands before attaching a Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const codexControlRequest = vi.fn();
    const writeBinding = vi.fn();

    await expect(
      handleCodexCommand(createContext("resume thread-123 extra", sessionFile), {
        deps: createDeps({
          codexControlRequest,
          bindingStore: { ...testCodexAppServerBindingStore, mutate: writeBinding },
        }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex resume <thread-id>",
    });
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(writeBinding).not.toHaveBeenCalled();
  });

  it.each([
    "bind",
    "resume thread-123",
    "steer keep going",
    "steer keep going --help",
    "model --help",
    "model gpt-5.5",
    "fast on",
    "permissions yolo",
    "compact",
    "review",
  ])("blocks /codex %s in sandboxed sessions before native Codex execution", async (args) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const codexControlRequest = vi.fn();
    const steerCodexConversationTurn = vi.fn();
    const setCodexConversationModel = vi.fn();
    const setCodexConversationFastMode = vi.fn();
    const setCodexConversationPermissions = vi.fn();
    const stopCodexConversationTurn = vi.fn();

    const result = await handleCodexCommand(createSandboxedContext(args, sessionFile), {
      deps: createDeps({
        codexControlRequest,
        steerCodexConversationTurn,
        setCodexConversationModel,
        setCodexConversationFastMode,
        setCodexConversationPermissions,
        stopCodexConversationTurn,
      }),
    });

    expect(result.text).toContain(
      "Codex-native /codex " +
        args.split(/\s+/u)[0] +
        " is unavailable because OpenClaw sandboxing is active for this session.",
    );
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(steerCodexConversationTurn).not.toHaveBeenCalled();
    expect(setCodexConversationModel).not.toHaveBeenCalled();
    expect(setCodexConversationFastMode).not.toHaveBeenCalled();
    expect(setCodexConversationPermissions).not.toHaveBeenCalled();
    expect(stopCodexConversationTurn).not.toHaveBeenCalled();
  });

  it.each([
    "bind",
    "resume thread-123",
    "steer keep going",
    "model gpt-5.5",
    "fast on",
    "permissions yolo",
    "compact",
    "review",
  ])("blocks /codex %s when exec host=node is active", async (args) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const codexControlRequest = vi.fn();
    const steerCodexConversationTurn = vi.fn();
    const setCodexConversationModel = vi.fn();
    const setCodexConversationFastMode = vi.fn();
    const setCodexConversationPermissions = vi.fn();
    const stopCodexConversationTurn = vi.fn();

    const result = await handleCodexCommand(createNodeExecContext(args, sessionFile), {
      deps: createDeps({
        codexControlRequest,
        steerCodexConversationTurn,
        setCodexConversationModel,
        setCodexConversationFastMode,
        setCodexConversationPermissions,
        stopCodexConversationTurn,
      }),
    });

    expect(result.text).toContain(
      "Codex-native /codex " +
        args.split(/\s+/u)[0] +
        " is unavailable because OpenClaw exec host=node is active for this session.",
    );
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(steerCodexConversationTurn).not.toHaveBeenCalled();
    expect(setCodexConversationModel).not.toHaveBeenCalled();
    expect(setCodexConversationFastMode).not.toHaveBeenCalled();
    expect(setCodexConversationPermissions).not.toHaveBeenCalled();
    expect(stopCodexConversationTurn).not.toHaveBeenCalled();
  });

  it("blocks config-level exec host=node without a session key", async () => {
    const result = await handleCodexCommand(
      createContext("bind", path.join(tempDir, "session.jsonl"), {
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      }),
      { deps: createDeps() },
    );

    expect(result.text).toContain(
      "Codex-native /codex bind is unavailable because OpenClaw exec host=node is active for this session.",
    );
  });

  it("still returns pre-native usage for malformed sandboxed native Codex commands", async () => {
    const setCodexConversationModel = vi.fn();

    await expect(
      handleCodexCommand(createSandboxedContext("bind --help"), {
        deps: createDeps(),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });

    await expect(
      handleCodexCommand(createSandboxedContext("model gpt-5.5 --help"), {
        deps: createDeps({ setCodexConversationModel }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex model <model>",
    });
    expect(setCodexConversationModel).not.toHaveBeenCalled();

    await expect(
      handleCodexCommand(createSandboxedContext("resume"), { deps: createDeps() }),
    ).resolves.toEqual({
      text: "Usage: /codex resume <thread-id>",
    });

    const resolveCodexCliSessionForBindingOnNode = vi.fn();
    await expect(
      handleCodexCommand(createSandboxedContext("resume cli-1 --host node-1"), {
        deps: createDeps({ resolveCodexCliSessionForBindingOnNode }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex resume <session-id> --host <node> --bind here",
    });
    expect(resolveCodexCliSessionForBindingOnNode).not.toHaveBeenCalled();

    await expect(
      handleCodexCommand(createSandboxedContext("resume cli-1 --host node-1 --bind here extra"), {
        deps: createDeps({ resolveCodexCliSessionForBindingOnNode }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex resume <thread-id>\nUsage: /codex resume <session-id> --host <node> --bind here",
    });
    expect(resolveCodexCliSessionForBindingOnNode).not.toHaveBeenCalled();

    await expect(
      handleCodexCommand(createSandboxedContext("steer", path.join(tempDir, "session.jsonl")), {
        deps: createDeps(),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex steer <message>",
    });

    await expect(
      handleCodexCommand(createSandboxedContext("stop now"), {
        deps: createDeps({ stopCodexConversationTurn: vi.fn() }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex stop",
    });
  });

  it("allows local Codex binding status forms in sandboxed sessions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "sandboxed-session",
      },
      {
        threadId: "thread-status",
        cwd: tempDir,
        model: "gpt-5.5",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        serviceTier: "priority",
      },
    );

    await expect(
      handleCodexCommand(createSandboxedContext("model", sessionFile), { deps: createDeps() }),
    ).resolves.toEqual({ text: "Codex model: gpt-5.5" });
    await expect(
      handleCodexCommand(createSandboxedContext("fast status", sessionFile), {
        deps: createDeps(),
      }),
    ).resolves.toEqual({ text: "Codex fast mode: on." });
    await expect(
      handleCodexCommand(createSandboxedContext("permissions status", sessionFile), {
        deps: createDeps(),
      }),
    ).resolves.toEqual({ text: "Codex permissions: full access." });
  });

  it("lists Codex CLI sessions from a requested node", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        sessions: [
          {
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
            updatedAt: "2026-05-13T06:30:00.000Z",
            lastMessage: "fix the bridge",
            messageCount: 2,
          },
        ],
      },
    }));

    const result = await handleCodexCommand(createContext("sessions --host mb-m5 bridge"), {
      deps: createDeps({ listCodexCliSessionsOnNode }),
    });

    expect(result.text).toContain("Codex CLI sessions on mb-m5 / mb-m5:");
    expect(result.text).toContain("019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd");
    expect(result.text).toContain(
      "Bind: /codex resume 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd --host mb-m5 --bind here",
    );
    expect(listCodexCliSessionsOnNode).toHaveBeenCalledWith({
      requestedNode: "mb-m5",
      filter: "bridge",
      limit: undefined,
    });
  });

  it("normalizes signed decimal Codex CLI session limits before node dispatch", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        sessions: [],
      },
    }));

    await handleCodexCommand(createContext("sessions --host mb-m5 --limit +05 bridge"), {
      deps: createDeps({ listCodexCliSessionsOnNode }),
    });

    expect(listCodexCliSessionsOnNode).toHaveBeenCalledWith({
      requestedNode: "mb-m5",
      filter: "bridge",
      limit: 5,
    });
  });

  it("rejects partial Codex CLI session limits before node dispatch", async () => {
    const listCodexCliSessionsOnNode = vi.fn();

    const result = await handleCodexCommand(createContext("sessions --host mb-m5 --limit 5x"), {
      deps: createDeps({ listCodexCliSessionsOnNode }),
    });

    expect(result.text).toBe("Usage: /codex sessions --host <node> [filter] [--limit <n>]");
    expect(listCodexCliSessionsOnNode).not.toHaveBeenCalled();
  });

  it("rejects fractional Codex CLI session limits before node dispatch", async () => {
    const listCodexCliSessionsOnNode = vi.fn();

    const result = await handleCodexCommand(createContext("sessions --host mb-m5 --limit 5.5"), {
      deps: createDeps({ listCodexCliSessionsOnNode }),
    });

    expect(result.text).toBe("Usage: /codex sessions --host <node> [filter] [--limit <n>]");
    expect(listCodexCliSessionsOnNode).not.toHaveBeenCalled();
  });

  it("binds the current conversation to a Codex CLI node session", async () => {
    const requestConversationBinding = vi.fn(async () => ({
      status: "bound" as const,
      binding: {
        bindingId: "binding-1",
        pluginId: "codex",
        pluginRoot: "/plugin",
        channel: "test",
        accountId: "default",
        conversationId: "conversation",
        boundAt: 1,
      },
    }));
    const resolveCodexCliSessionForBindingOnNode = vi.fn(async () => ({
      node: { nodeId: "node-123", displayName: "mb-m5" },
      session: {
        sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
        cwd: "/repo",
        messageCount: 2,
      },
    }));

    await expect(
      handleCodexCommand(
        createNodeExecContext(
          "resume 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd --host mb-m5 --bind here",
          undefined,
          { requestConversationBinding },
        ),
        {
          deps: createDeps({ resolveCodexCliSessionForBindingOnNode }),
        },
      ),
    ).resolves.toEqual({
      text: "Bound this conversation to Codex CLI session 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd on node-123.",
    });
    expect(resolveCodexCliSessionForBindingOnNode).toHaveBeenCalledWith({
      requestedNode: "mb-m5",
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
    });
    expect(requestConversationBinding).toHaveBeenCalledWith({
      summary: "Codex CLI session 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd on node-123",
      detachHint: "/codex detach",
      data: {
        kind: "codex-cli-node-session",
        version: 1,
        nodeId: "node-123",
        sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
        agentId: "main",
        cwd: "/repo",
      },
    });
  });

  it("refuses to bind a Codex CLI node session that the node did not list", async () => {
    const requestConversationBinding = vi.fn();
    const resolveCodexCliSessionForBindingOnNode = vi.fn(async () => ({
      node: { nodeId: "node-123", displayName: "mb-m5" },
      session: undefined,
    }));

    await expect(
      handleCodexCommand(
        createContext(
          "resume 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd --host mb-m5 --bind here",
          undefined,
          { requestConversationBinding },
        ),
        {
          deps: createDeps({ resolveCodexCliSessionForBindingOnNode }),
        },
      ),
    ).resolves.toEqual({
      text: "No Codex CLI session 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd was found on mb-m5.",
    });
    expect(requestConversationBinding).not.toHaveBeenCalled();
  });

  it("escapes resumed Codex thread ids before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const unsafe = "thread-123 <@U123> [trusted](https://evil)";
    const deps = createDeps({
      codexControlRequest: vi.fn(async () => createThreadResumeResponse({ threadId: unsafe })),
    });

    const result = await handleCodexCommand(createContext(`resume "${unsafe}"`, sessionFile), {
      deps,
    });

    expect(result.text).toContain(
      "thread-123 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });

  it("shows model ids from Codex app-server", async () => {
    const config = { auth: { order: { openai: ["openai:work"] } } };
    const listCodexAppServerModels = vi.fn(async (_options?: { config?: unknown }) => ({
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          inputModalities: ["text"],
          supportedReasoningEfforts: ["medium"],
        },
      ],
    }));
    const deps = createDeps({
      listCodexAppServerModels,
    });

    await expect(
      handleCodexCommand(createContext("models", undefined, { config }), { deps }),
    ).resolves.toEqual({
      text: "Codex models:\n- gpt-5.4",
    });
    expect(deps.requestOptions).toHaveBeenCalledWith(
      undefined,
      100,
      config,
      resolveDefaultAgentDir(config),
    );
    const modelsRequest = mockArg(listCodexAppServerModels, 0, 0) as {
      agentDir?: string;
      config?: unknown;
    };
    expect(modelsRequest?.config).toBe(config);
    expect(modelsRequest?.agentDir).toBe(resolveDefaultAgentDir(config));
  });

  it("shows when Codex app-server model output is truncated", async () => {
    const deps = createDeps({
      listCodexAppServerModels: vi.fn(async () => ({
        models: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["medium"],
          },
        ],
        nextCursor: "page-2",
        truncated: true,
      })),
    });

    await expect(handleCodexCommand(createContext("models"), { deps })).resolves.toEqual({
      text: "Codex models:\n- gpt-5.4\n- More models available; output truncated.",
    });
  });

  it("escapes Codex app-server model ids before chat display", async () => {
    const deps = createDeps({
      listCodexAppServerModels: vi.fn(async () => ({
        models: [
          {
            id: "gpt-5.4 <@U123> [trusted](https://evil)",
            model: "gpt-5.4",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["medium"],
          },
        ],
      })),
    });

    const result = await handleCodexCommand(createContext("models"), { deps });

    expect(result.text).toContain(
      "gpt-5.4 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });

  it("escapes markdown underscores in Codex app-server readouts", async () => {
    const deps = createDeps({
      listCodexAppServerModels: vi.fn(async () => ({
        models: [
          {
            id: "unsafe_model_name",
            model: "unsafe_model_name",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["medium"],
          },
        ],
      })),
    });

    const result = await handleCodexCommand(createContext("models"), { deps });

    expect(result.text).toContain("unsafe\uff3fmodel\uff3fname");
    expect(result.text).not.toContain("unsafe_model_name");
  });

  it("reports status unavailable when every Codex probe fails", async () => {
    const config = { auth: { order: { openai: ["openai:work"] } } };
    const offline = { ok: false as const, error: "offline" };
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: offline,
        account: offline,
        limits: offline,
        mcps: offline,
        skills: offline,
      })),
    });

    await expect(
      handleCodexCommand(createContext("status", undefined, { config }), { deps }),
    ).resolves.toEqual({
      text: [
        "Codex app-server: unavailable",
        "Models: offline",
        "Account: offline",
        "Rate limits: offline",
        "MCP servers: offline",
        "Skills: offline",
      ].join("\n"),
    });
    expect(deps.readCodexStatusProbes).toHaveBeenCalledWith(
      undefined,
      config,
      resolveDefaultAgentDir(config),
    );
  });

  it("escapes Codex status probe errors before chat display", async () => {
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const offline = { ok: false as const, error: unsafe };
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: offline,
        account: offline,
        limits: offline,
        mcps: offline,
        skills: offline,
      })),
    });

    const result = await handleCodexCommand(createContext("status"), { deps });

    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("escapes successful Codex status model ids and account summaries", async () => {
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: {
          ok: true as const,
          value: {
            models: [
              {
                id: unsafe,
                model: unsafe,
                inputModalities: ["text"],
                supportedReasoningEfforts: ["medium"],
              },
            ],
          },
        },
        account: {
          ok: true as const,
          value: {
            account: {
              type: "chatgpt" as const,
              email: unsafe,
              planType: "plus" as const,
            },
            requiresOpenaiAuth: false,
          },
        },
        limits: {
          ok: true as const,
          value: {
            rateLimits: {
              limitId: null,
              limitName: null,
              primary: null,
              secondary: null,
              credits: null,
              planType: null,
              rateLimitReachedType: null,
            },
            rateLimitsByLimitId: null,
          },
        },
        mcps: { ok: true as const, value: { data: [], nextCursor: null } },
        skills: { ok: true as const, value: { data: [] } },
      })),
    });

    const result = await handleCodexCommand(createContext("status"), { deps });

    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("summarizes Codex status skill groups by enabled nested skills", async () => {
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: { ok: true as const, value: { models: [] } },
        account: { ok: true as const, value: {} },
        limits: { ok: true as const, value: { rateLimits: null, rateLimitsByLimitId: null } },
        mcps: { ok: true as const, value: { data: [] } },
        skills: {
          ok: true as const,
          value: {
            data: [
              {
                cwd: "/repo-a",
                skills: [
                  {
                    name: "enabled-one",
                    description: "",
                    path: "/repo-a/.codex/skills/enabled-one/SKILL.md",
                    scope: "repo" as const,
                    enabled: true,
                  },
                  {
                    name: "disabled-one",
                    description: "",
                    path: "/repo-a/.codex/skills/disabled-one/SKILL.md",
                    scope: "repo" as const,
                    enabled: false,
                  },
                ],
                errors: [],
              },
              {
                cwd: "/repo-b",
                skills: [
                  {
                    name: "enabled-two",
                    description: "",
                    path: "/repo-b/.codex/skills/enabled-two/SKILL.md",
                    scope: "repo" as const,
                    enabled: true,
                  },
                ],
                errors: [{ path: "/repo-b/bad/SKILL.md", message: "bad skill" }],
              },
            ],
          },
        },
      })),
    });

    const result = await handleCodexCommand(createContext("status"), { deps });

    expect(result.text).toContain("Skills: 2");
    expect(result.text).not.toContain("Skills: 1");
  });

  it("summarizes generated Codex rate-limit payloads", async () => {
    const limits = {
      ok: true as const,
      value: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null },
            secondary: null,
            credits: null,
            planType: null,
            rateLimitReachedType: null,
          },
        },
      },
    };
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: { ok: false as const, error: "offline" },
        account: { ok: false as const, error: "offline" },
        limits,
        mcps: { ok: true as const, value: { data: [], nextCursor: null } },
        skills: { ok: true as const, value: { data: [] } },
      })),
      safeCodexControlRequest: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true as const,
          value: { account: { email: "codex@example.com" } },
        })
        .mockResolvedValueOnce(limits),
    });

    const statusResult = await handleCodexCommand(createContext("status"), { deps });
    expectResultTextContains(statusResult, "Rate limits: Codex: primary 58% left");
    const accountResult = await handleCodexCommand(createContext("account"), { deps });
    expectResultTextContains(accountResult, "Codex is available.");
  });

  it("does not count empty Codex rate-limit buckets as returned limits", async () => {
    const limits = {
      ok: true as const,
      value: {
        rateLimits: [
          {
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            credits: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
        ],
        rateLimitsByLimitId: {
          premium: {
            limitId: "premium",
            limitName: "premium",
            primary: null,
            secondary: null,
            credits: null,
            planType: "pro",
            rateLimitReachedType: null,
          },
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            credits: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
        },
      },
    };
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: { ok: false as const, error: "offline" },
        account: { ok: false as const, error: "offline" },
        limits,
        mcps: { ok: true as const, value: { data: [], nextCursor: null } },
        skills: { ok: true as const, value: { data: [] } },
      })),
      safeCodexControlRequest: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true as const,
          value: { account: { email: "codex@example.com" } },
        })
        .mockResolvedValueOnce(limits),
    });

    const statusResult = await handleCodexCommand(createContext("status"), { deps });
    expectResultTextContains(statusResult, "Rate limits: none returned");
    expect(statusResult.text).not.toContain("Rate limits: 1");
    expect(statusResult.text).not.toContain("premium");

    const accountResult = await handleCodexCommand(createContext("account"), { deps });
    expectResultTextContains(accountResult, "Rate limits: none returned");
    expect(accountResult.text).not.toContain("Rate limits: 1");
    expect(accountResult.text).not.toContain("premium");
  });

  it("rejects extra operands for read-only Codex commands", async () => {
    const readCodexStatusProbes = vi.fn();
    const listCodexAppServerModels = vi.fn();
    const safeCodexControlRequest = vi.fn();
    const codexControlRequest = vi.fn();
    const getCurrentConversationBinding = vi.fn();
    const deps = createDeps({
      codexControlRequest,
      listCodexAppServerModels,
      readCodexStatusProbes,
      safeCodexControlRequest,
    });

    await expect(handleCodexCommand(createContext("status now"), { deps })).resolves.toEqual({
      text: "Usage: /codex status",
    });
    await expect(handleCodexCommand(createContext("models all"), { deps })).resolves.toEqual({
      text: "Usage: /codex models",
    });
    await expect(handleCodexCommand(createContext("account refresh"), { deps })).resolves.toEqual({
      text: "Usage: /codex account",
    });
    await expect(handleCodexCommand(createContext("mcp list"), { deps })).resolves.toEqual({
      text: "Usage: /codex mcp",
    });
    await expect(handleCodexCommand(createContext("skills list"), { deps })).resolves.toEqual({
      text: "Usage: /codex skills",
    });
    await expect(
      handleCodexCommand(
        createContext("binding current", undefined, {
          getCurrentConversationBinding,
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex binding",
    });

    expect(readCodexStatusProbes).not.toHaveBeenCalled();
    expect(listCodexAppServerModels).not.toHaveBeenCalled();
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(getCurrentConversationBinding).not.toHaveBeenCalled();
  });

  it("formats generated account/read responses", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: { type: "chatgpt", email: "codex@example.com", planType: "pro" },
          requiresOpenaiAuth: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 50, windowDurationMins: 300, resetsAt },
            secondary: null,
            credits: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        },
      });

    const result = await handleCodexCommand(createContext("account"), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain("Account: codex@example.com");
    expect(result.text).toContain("Codex is available.");
    expect(safeCodexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.account,
      { refreshToken: false },
      expect.objectContaining({
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        sessionId: "session-1",
      }),
    );
  });

  it("escapes Codex account probe errors before chat display", async () => {
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: unsafe })
      .mockResolvedValueOnce({ ok: false as const, error: unsafe });

    const result = await handleCodexCommand(createContext("account"), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("summarizes blocked account rate limits as a human takeaway", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: { type: "chatgpt", email: "codex@example.com", planType: "pro" },
          requiresOpenaiAuth: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: { usedPercent: 0, windowDurationMins: 300, resetsAt },
              secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: resetsAt + 3600 },
              credits: null,
              planType: "plus",
              rateLimitReachedType: "rate_limit_reached",
            },
            "gpt-5.3-codex-spark": {
              limitId: "gpt-5.3-codex-spark",
              limitName: "GPT 5.3 Codex Spark",
              primary: { usedPercent: 0, windowDurationMins: 300, resetsAt },
              secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: resetsAt + 3600 },
              credits: null,
              planType: "plus",
              rateLimitReachedType: null,
            },
          },
        },
      });

    const result = await handleCodexCommand(createContext("account"), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain("Codex is paused until ");
    expect(result.text).toContain("Your weekly Codex usage limit is reached.");
    expect(result.text).not.toContain("GPT 5.3 Codex Spark");
    expect(result.text).not.toContain("Primary:");
    expect(result.text).not.toContain("Secondary:");
    expect(result.text).not.toContain("Bucket:");
    expect(result.text).not.toContain("Why:");
    expect(result.text).not.toContain("5-hour");
    expect(result.text).not.toContain("100%");
    expect(result.text).not.toContain("; GPT 5.3 Codex Spark");
    expect(result.text).not.toContain("\uff08rate limit reached\uff09");
  });

  it("shows the active ChatGPT subscription and API-key backup ladder", async () => {
    const config = {};
    const now = Date.now();
    const resetsAt = Math.ceil(now / 1000) + 120;
    installAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:personal-email@gmail.com": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: now + 60 * 60 * 1000,
            email: "personal-email@gmail.com",
          },
          "openai:api-key-backup": {
            type: "api_key",
            provider: "openai",
            key: "sk-test-backup",
          },
        },
        order: {
          openai: ["openai:personal-email@gmail.com", "openai:api-key-backup"],
        },
        lastGood: {
          openai: "openai:personal-email@gmail.com",
        },
        usageStats: {
          "openai:personal-email@gmail.com": {
            lastUsed: now - 1_000,
          },
        },
      },
      config,
    );

    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: { type: "chatgpt", email: "personal-email@gmail.com", planType: "pro" },
          requiresOpenaiAuth: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: codexRateLimitPayload({
          primaryUsedPercent: 12,
          secondaryUsedPercent: 63,
          primaryResetSeconds: resetsAt,
          secondaryResetSeconds: resetsAt + 3600,
        }),
      });

    const result = await handleCodexCommand(createContext("account", undefined, { config }), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain("Subscription  personal-email@gmail.com");
    expect(result.text).toContain("\n  Weekly 63% \u00b7 Short-term 12%");
    expect(result.text).toContain("Auth order");
    expect(result.text).toContain(
      "\n  1. personal-email@gmail.com   ChatGPT subscription   — active now",
    );
    expect(result.text).toContain("\n  2. api-key-backup   API key   — available if needed");
    expect(result.text).not.toContain("Now using:");
    expect(result.text).not.toContain("openai:api-key-backup");
    expect(result.text).not.toContain("primary");
    expect(result.text).not.toContain("secondary");
  });

  it("prefers the live ChatGPT account over stale API-key lastGood state", async () => {
    const config = {};
    const now = Date.now();
    installAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:personal-email@gmail.com": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: now + 60 * 60 * 1000,
            email: "personal-email@gmail.com",
          },
          "openai:api-key-backup": {
            type: "api_key",
            provider: "openai",
            key: "sk-test-backup",
          },
        },
        order: {
          openai: ["openai:personal-email@gmail.com", "openai:api-key-backup"],
        },
        lastGood: {
          openai: "openai:api-key-backup",
        },
      },
      config,
    );

    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: { type: "chatgpt", email: "personal-email@gmail.com", planType: "pro" },
          requiresOpenaiAuth: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: codexRateLimitPayload({
          primaryUsedPercent: 12,
          secondaryUsedPercent: 63,
          primaryResetSeconds: Math.ceil(now / 1000) + 120,
          secondaryResetSeconds: Math.ceil(now / 1000) + 3600,
        }),
      });

    const result = await handleCodexCommand(createContext("account", undefined, { config }), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain(
      "\n  1. personal-email@gmail.com   ChatGPT subscription   — active now",
    );
    expect(result.text).toContain("\n  2. api-key-backup   API key   — available if needed");
    expect(result.text).not.toContain("Now using: api-key-backup");
    expect(result.text).not.toContain("subscription unavailable");
  });

  it("shows OpenAI subscription auth before API-key fallback order", async () => {
    const config = {
      auth: {
        order: {
          openai: ["openai:personal-email@gmail.com", "openai:api-key"],
        },
      },
    };
    const now = Date.now();
    installAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
          "openai:personal-email@gmail.com": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: now + 60 * 60 * 1000,
            email: "personal-email@gmail.com",
          },
        },
        lastGood: {
          openai: "openai:personal-email@gmail.com",
        },
      },
      config,
    );

    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: { type: "chatgpt", email: "personal-email@gmail.com", planType: "plus" },
          requiresOpenaiAuth: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: codexRateLimitPayload({
          primaryUsedPercent: 10,
          secondaryUsedPercent: 20,
          primaryResetSeconds: Math.ceil(now / 1000) + 120,
          secondaryResetSeconds: Math.ceil(now / 1000) + 3600,
        }),
      });

    const result = await handleCodexCommand(createContext("account", undefined, { config }), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain(
      "\n  1. personal-email@gmail.com   ChatGPT subscription   — active now",
    );
    expect(result.text).toContain("\n  2. api-key   API key   — available if needed");
  });

  it("explains when an API-key backup is active because the subscription is paused", async () => {
    const config = {};
    const agentDir = path.join(tempDir, "agents", "worker", "agent");
    const now = Date.now();
    const primaryResetSeconds = Math.ceil(now / 1000) + 5 * 60 * 60;
    const secondaryResetSeconds = Math.ceil(now / 1000) + 23 * 60 * 60;
    installAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:personal-email@gmail.com": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: now + 60 * 60 * 1000,
            email: "personal-email@gmail.com",
          },
          "openai:api-key-backup": {
            type: "api_key",
            provider: "openai",
            key: "sk-test-backup",
          },
          "openai:work-email@gmail.com": {
            type: "oauth",
            provider: "openai",
            access: "work-access-token",
            refresh: "work-refresh-token",
            expires: now + 60 * 60 * 1000,
            email: "work-email@gmail.com",
          },
          "openai:work-api-key-backup": {
            type: "api_key",
            provider: "openai",
            key: "sk-test-work-backup",
          },
        },
        order: {
          openai: [
            "openai:personal-email@gmail.com",
            "openai:api-key-backup",
            "openai:work-email@gmail.com",
            "openai:work-api-key-backup",
          ],
        },
      },
      config,
      agentDir,
    );

    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: { type: "apiKey" },
          requiresOpenaiAuth: true,
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "chatgpt authentication required to read rate limits",
      })
      .mockResolvedValueOnce({
        ok: true,
        value: codexRateLimitPayload({
          primaryUsedPercent: 0,
          secondaryUsedPercent: 100,
          primaryResetSeconds,
          secondaryResetSeconds,
          reached: true,
        }),
      });

    const result = await handleCodexCommand(
      createContext("account", undefined, {
        config,
        sessionKey: "agent:worker:session-1",
      }),
      { deps: createDeps({ safeCodexControlRequest }) },
    );

    expect(result.text).toContain("Now using: api-key-backup");
    expect(result.text).toContain("subscription rate-limited \u00b7 switches back in");
    expect(result.text).toContain("Subscription  personal-email@gmail.com");
    expect(result.text).toContain("\n  Weekly 100% \u00b7 Short-term 0% \u00b7 Resets in");
    expect(result.text).toContain(
      "\n  1. personal-email@gmail.com   ChatGPT subscription   — rate-limited",
    );
    expect(result.text).toContain(
      "\n  2. api-key-backup   API key   — active now \u00b7 billed per token",
    );
    expect(result.text).toContain(
      "\n  3. work-email@gmail.com   ChatGPT subscription   — available if needed",
    );
    expect(result.text).toContain("\n  4. work-api-key-backup   API key   — available if needed");
    expect(result.text).not.toContain("Reason:");
    expect(result.text).not.toContain("fallback active");
    expect(result.text).not.toContain("not tracked");
    expect(result.text).not.toContain("chatgpt authentication required");
    expect(result.text).not.toContain("openai:");
    expect(result.text).not.toContain("primary");
    expect(result.text).not.toContain("secondary");
    expect(safeCodexControlRequest).toHaveBeenNthCalledWith(
      3,
      undefined,
      CODEX_CONTROL_METHODS.rateLimits,
      undefined,
      {
        config,
        agentDir,
        authProfileId: "openai:personal-email@gmail.com",
        isolated: true,
      },
    );
  });

  it("does not report a blocked last-good subscription as active", async () => {
    const config = {};
    const now = Date.now();
    const primaryResetSeconds = Math.ceil(now / 1000) + 5 * 60 * 60;
    const secondaryResetSeconds = Math.ceil(now / 1000) + 23 * 60 * 60;
    installAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:personal-email@gmail.com": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: now + 60 * 60 * 1000,
            email: "personal-email@gmail.com",
          },
          "openai:api-key-backup": {
            type: "api_key",
            provider: "openai",
            key: "sk-test-backup",
          },
        },
        order: {
          openai: ["openai:personal-email@gmail.com", "openai:api-key-backup"],
        },
        lastGood: {
          openai: "openai:personal-email@gmail.com",
        },
        usageStats: {
          "openai:personal-email@gmail.com": {
            lastUsed: now - 1_000,
            blockedUntil: now + 23 * 60 * 60 * 1000,
          },
        },
      },
      config,
    );

    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: { type: "unknown" },
          requiresOpenaiAuth: true,
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "chatgpt authentication required to read rate limits",
      })
      .mockResolvedValueOnce({
        ok: true,
        value: codexRateLimitPayload({
          primaryUsedPercent: 0,
          secondaryUsedPercent: 100,
          primaryResetSeconds,
          secondaryResetSeconds,
          reached: true,
        }),
      });

    const result = await handleCodexCommand(createContext("account", undefined, { config }), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain("Now using: api-key-backup");
    expect(result.text).toContain("subscription rate-limited");
    expect(result.text).toContain(
      "\n  1. personal-email@gmail.com   ChatGPT subscription   — rate-limited",
    );
    expect(result.text).toContain(
      "\n  2. api-key-backup   API key   — active now \u00b7 billed per token",
    );
    expect(result.text).not.toContain(
      "personal-email@gmail.com   ChatGPT subscription   — active now",
    );
  });

  it("respects explicit Codex auth order over stale lastGood after OAuth re-login", async () => {
    const config = {};
    const now = Date.now();
    installAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "oauth",
            provider: "openai",
            access: "stale-access-token",
            refresh: "stale-refresh-token",
            expires: now + 2 * 24 * 60 * 60 * 1000,
            email: "previous@example.com",
          },
          "openai:fresh-email@example.com": {
            type: "oauth",
            provider: "openai",
            access: "fresh-access-token",
            refresh: "fresh-refresh-token",
            expires: now + 9 * 24 * 60 * 60 * 1000,
            email: "fresh-email@example.com",
          },
        },
        order: {
          openai: ["openai:fresh-email@example.com", "openai:default"],
        },
        lastGood: {
          openai: "openai:default",
        },
      },
      config,
    );

    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { account: { type: "unknown" }, requiresOpenaiAuth: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: codexRateLimitPayload({
          primaryUsedPercent: 5,
          secondaryUsedPercent: 10,
          primaryResetSeconds: Math.ceil(now / 1000) + 60 * 60,
          secondaryResetSeconds: Math.ceil(now / 1000) + 6 * 60 * 60,
        }),
      });

    const result = await handleCodexCommand(createContext("account", undefined, { config }), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain(
      "\n  1. fresh-email@example.com   ChatGPT subscription   — active now",
    );
    expect(result.text).toContain(
      "\n  2. previous@example.com   ChatGPT subscription   — available if needed",
    );
    expect(result.text).not.toContain("previous@example.com   ChatGPT subscription   — active now");
    expect(result.text).not.toContain("openai:");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("respects openai-alias explicit order over stale lastGood for API key profiles", async () => {
    const config = {};
    const ignoredNow = Date.now();
    void ignoredNow;
    installAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:fresh-key": {
            type: "api_key",
            provider: "openai",
            key: "sk-fresh-111",
          },
          "openai:stale-key": {
            type: "api_key",
            provider: "openai",
            key: "sk-stale-222",
          },
        },
        order: {
          openai: ["openai:fresh-key", "openai:stale-key"],
        },
        lastGood: {
          openai: "openai:stale-key",
        },
      },
      config,
    );

    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { account: { type: "unknown" }, requiresOpenaiAuth: false },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "usage data unavailable",
      });

    const result = await handleCodexCommand(createContext("account", undefined, { config }), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain("\n  1. fresh-key   API key   — active now");
    expect(result.text).not.toContain("stale-key   API key   — active now");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("does not mark any profile active when all explicit-order token credentials are expired", async () => {
    // Both profiles use type:"token" with expired expiry, so resolveAuthProfileEligibility
    // returns eligible=false for both. resolveActiveProfileId must return undefined rather
    // than marking an ineligible profile as active; the display shows "no working credential".
    const config = {};
    const now = Date.now();
    installAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:fresh@example.com": {
            type: "token",
            provider: "openai",
            token: "fresh-token",
            expires: now - 1000,
            email: "fresh@example.com",
          },
          "openai:stale@example.com": {
            type: "token",
            provider: "openai",
            token: "stale-token",
            expires: now - 2000,
            email: "stale@example.com",
          },
        },
        order: {
          openai: ["openai:fresh@example.com", "openai:stale@example.com"],
        },
        lastGood: {
          openai: "openai:stale@example.com",
        },
      },
      config,
    );

    const safeCodexControlRequest = vi
      .fn()
      // call 1: account info for the active/first profile
      .mockResolvedValueOnce({
        ok: true,
        value: { account: { type: "unknown" }, requiresOpenaiAuth: true },
      })
      // call 2: rate limits for the active profile
      .mockResolvedValueOnce({
        ok: false,
        error: "rate limits unavailable",
      })
      // call 3: readSubscriptionUsage — no activeProfileId means the subscription
      // profile (fresh, type:"token") is fetched separately
      .mockResolvedValueOnce({
        ok: false,
        error: "subscription limits unavailable",
      });

    const result = await handleCodexCommand(createContext("account", undefined, { config }), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    // With all credentials expired, no profile is active — the display shows
    // "no working credential" and both profiles are labelled "sign-in expired".
    // lastGood (stale) must not override the stated operator rank, and the
    // first explicit-order entry must not be falsely marked active when ineligible.
    expect(result.text).toContain("no working credential");
    expect(result.text).toContain(
      "\n  1. fresh@example.com   ChatGPT subscription   — sign-in expired",
    );
    expect(result.text).toContain(
      "\n  2. stale@example.com   ChatGPT subscription   — sign-in expired",
    );
    expect(result.text).not.toContain("active now");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(3);
  });

  it("escapes successful Codex account fallback summaries before chat display", async () => {
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: { account: { id: unsafe } } })
      .mockResolvedValueOnce({ ok: true as const, value: [] });

    const result = await handleCodexCommand(createContext("account"), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("formats generated Amazon Bedrock account responses", async () => {
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { account: { type: "amazonBedrock" }, requiresOpenaiAuth: false },
      })
      .mockResolvedValueOnce({ ok: true, value: [] });

    await expect(
      handleCodexCommand(createContext("account"), {
        deps: createDeps({ safeCodexControlRequest }),
      }),
    ).resolves.toEqual({
      text: ["Account: Amazon Bedrock", "Rate limits: none returned"].join("\n\n"),
    });
  });

  it("starts compaction for the attached Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const identity = {
      kind: "session",
      agentId: "main",
      sessionId: "session-1",
    } as const;
    await writeTestBinding(identity, {
      threadId: "thread-123",
      cwd: "/repo",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
    const codexControlRequest = vi.fn(async () => undefined);
    const deps = createDeps({ codexControlRequest });

    await expect(
      handleCodexCommand(createContext("compact", sessionFile), { deps }),
    ).resolves.toEqual({
      text: "Started Codex compaction for thread thread-123.",
    });
    expect(codexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.compact,
      { threadId: "thread-123" },
      expect.objectContaining({ config: {} }),
    );
  });

  it("starts review with the generated app-server target shape", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-123", cwd: "/repo" },
    );
    const codexControlRequest = vi.fn(async () => undefined);

    await expect(
      handleCodexCommand(createContext("review", sessionFile), {
        deps: createDeps({ codexControlRequest }),
      }),
    ).resolves.toEqual({
      text: "Started Codex review for thread thread-123.",
    });
    expect(codexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.review,
      { threadId: "thread-123", target: { type: "uncommittedChanges" } },
      expect.objectContaining({ config: {} }),
    );
  });

  it("starts supervised compact and review actions through the native user-home connection", async () => {
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      supervisedTestBinding(),
    );
    const codexControlRequest = vi.fn(async () => undefined);
    const pluginConfig = { supervision: { enabled: true } };
    const deps = createDeps({ codexControlRequest });

    await handleCodexCommand(createContext("compact"), { deps, pluginConfig });
    await handleCodexCommand(createContext("review"), { deps, pluginConfig });

    expect(codexControlRequest).toHaveBeenCalledTimes(2);
    for (let callIndex = 0; callIndex < codexControlRequest.mock.calls.length; callIndex += 1) {
      expect(mockArg(codexControlRequest, callIndex, 3)).toMatchObject({
        authProfileId: null,
        startOptions: { homeScope: "user" },
      });
    }
  });

  it("rejects malformed compact and review commands before starting thread actions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const codexControlRequest = vi.fn();

    await expect(
      handleCodexCommand(createContext("compact now", sessionFile), {
        deps: createDeps({ codexControlRequest }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex compact",
    });
    await expect(
      handleCodexCommand(createContext("review staged", sessionFile), {
        deps: createDeps({ codexControlRequest }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex review",
    });
    expect(codexControlRequest).not.toHaveBeenCalled();
  });

  it("escapes started thread-action ids before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-123 <@U123>", cwd: "/repo" },
    );
    const result = await handleCodexCommand(createContext("compact", sessionFile), {
      deps: createDeps(),
    });

    expect(result.text).toContain("thread-123 &lt;\uff20U123&gt;");
    expect(result.text).not.toContain("<@U123>");
  });

  it("checks Codex Computer Use setup", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => computerUseReadyStatus());

    await expect(
      handleCodexCommand(
        createContext("computer-use status", undefined, {
          sessionKey: "agent:worker:session-1",
        }),
        {
          deps: createDeps({ readCodexComputerUseStatus }),
        },
      ),
    ).resolves.toEqual({
      text: [
        "Computer Use: ready",
        "Plugin: computer-use (installed)",
        "Installation: installed (ok)",
        "MCP server: computer-use (1 tools)",
        "Exposure: available (ok)",
        "Live test: passed (1 attempt, 60000ms)",
        "Marketplace: desktop-tools",
        "Tools: list\uff3fapps",
        "Computer Use is ready.",
      ].join("\n"),
    });
    expect(readCodexComputerUseStatus).toHaveBeenCalledWith({
      pluginConfig: undefined,
      config: {},
      agentDir: path.join(tempDir, "agents", "worker", "agent"),
      forceEnable: false,
    });
  });

  it("formats failed Codex Computer Use live probes as not ready", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...computerUseReadyStatus(),
      ready: false,
      reason: "live_test_failed" as const,
      liveTest: {
        status: "failed" as const,
        ok: false,
        attempted: true,
        attempts: 2,
        timeoutMs: 60_000,
        retried: true,
        repaired: false,
        message: "Computer Use live test failed after 2 attempts: list_apps timed out",
        error: "list_apps timed out",
      },
      warnings: [
        "Computer Use live test failed, but compatibility startup remains enabled; set computerUse.strictReadiness to true to fail closed.",
      ],
      message:
        "Computer Use live test failed after 2 attempts: list_apps timed out Startup is allowed because computerUse.strictReadiness is false.",
    }));

    const result = await handleCodexCommand(createContext("computer-use status"), {
      deps: createDeps({ readCodexComputerUseStatus }),
    });

    expectResultTextContains(result, "Computer Use: not ready");
    expectResultTextContains(result, "Live test: failed (2 attempts, 60000ms)");
    expectResultTextContains(result, "Warning: Computer Use live test failed");
  });

  it("escapes Codex Computer Use status fields before chat display", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...computerUseReadyStatus(),
      pluginName: "<@U123>",
      mcpServerName: "computer-use [server](https://evil)",
      marketplaceName: "desktop_tools",
      tools: ["list_apps", "[click](https://evil)"],
      message: "Computer Use is ready @here.",
    }));

    const result = await handleCodexCommand(createContext("computer-use status"), {
      deps: createDeps({ readCodexComputerUseStatus }),
    });

    expect(result.text).toContain("Plugin: &lt;\uff20U123&gt; (installed)");
    expect(result.text).toContain(
      "MCP server: computer-use \uff3bserver\uff3d\uff08https://evil\uff09 (2 tools)",
    );
    expect(result.text).toContain("Marketplace: desktop\uff3ftools");
    expect(result.text).toContain(
      "Tools: list\uff3fapps, \uff3bclick\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).toContain("Computer Use is ready \uff20here.");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[click](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("formats disabled installed Codex Computer Use plugins", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...computerUseReadyStatus(),
      ready: false,
      reason: "plugin_disabled" as const,
      pluginEnabled: false,
      mcpServerAvailable: false,
      tools: [],
      message:
        "Computer Use is installed, but the computer-use plugin is disabled. Run /codex computer-use install or enable computerUse.autoInstall to re-enable it.",
    }));

    const result = await handleCodexCommand(createContext("computer-use status"), {
      deps: createDeps({ readCodexComputerUseStatus }),
    });

    expectResultTextContains(result, "Plugin: computer-use (installed, disabled)");
  });

  it("installs Codex Computer Use from command overrides", async () => {
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await handleCodexCommand(
      createContext(
        "computer-use install --source github:example/desktop-tools --marketplace desktop-tools",
      ),
      {
        deps: createDeps({ installCodexComputerUse }),
      },
    );

    expectResultTextContains(result, "Computer Use: ready");
    expect(installCodexComputerUse).toHaveBeenCalledWith({
      pluginConfig: undefined,
      config: {},
      agentDir: path.join(tempDir, "agents", "main", "agent"),
      forceEnable: true,
      overrides: {
        marketplaceSource: "github:example/desktop-tools",
        marketplaceName: "desktop-tools",
      },
    });
  });

  it("shows help when Computer Use option values are missing", async () => {
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await handleCodexCommand(createContext("computer-use install --source"), {
      deps: createDeps({ installCodexComputerUse }),
    });

    expectResultTextContains(result, "Usage: /codex computer-use");
    expect(installCodexComputerUse).not.toHaveBeenCalled();
  });

  it.each([
    ["status --plugin custom_plugin@v2", 'computerUse.pluginName = "custom_plugin@v2"', "status"],
    ["install --server custom-server", 'computerUse.mcpServerName = "custom-server"', "install"],
    [
      "install --mcp-server custom-server",
      'computerUse.mcpServerName = "custom-server"',
      "install",
    ],
  ])(
    "routes legacy one-off Computer Use identity override %s to persistent config",
    async (command, setting, action) => {
      const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());
      const readCodexComputerUseStatus = vi.fn(async () => computerUseReadyStatus());

      const result = await handleCodexCommand(createContext(`computer-use ${command}`), {
        deps: createDeps({ installCodexComputerUse, readCodexComputerUseStatus }),
      });

      expectResultTextContains(result, setting);
      expectResultTextContains(result, `rerun /codex computer-use ${action}`);
      expect(installCodexComputerUse).not.toHaveBeenCalled();
      expect(readCodexComputerUseStatus).not.toHaveBeenCalled();
    },
  );

  it("preserves marketplace flags in legacy Computer Use migration guidance", async () => {
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await handleCodexCommand(
      createContext(
        "computer-use install --plugin custom-plugin --source github:example/tools --marketplace tools",
      ),
      { deps: createDeps({ installCodexComputerUse }) },
    );

    expectResultTextContains(result, 'computerUse.pluginName = "custom-plugin"');
    expectResultTextContains(
      result,
      'rerun /codex computer-use install --source "github:example/tools" --marketplace "tools"',
    );
    expect(installCodexComputerUse).not.toHaveBeenCalled();
  });

  it("quotes whitespace-containing marketplace paths in legacy migration guidance", async () => {
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await handleCodexCommand(
      createContext(
        'computer-use install --plugin custom-plugin --marketplace-path "/tmp/My Tools"',
      ),
      { deps: createDeps({ installCodexComputerUse }) },
    );

    expectResultTextContains(result, '--marketplace-path "/tmp/My Tools"');
    expect(installCodexComputerUse).not.toHaveBeenCalled();
  });

  it("rejects ambiguous Computer Use actions before setup checks", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => computerUseReadyStatus());
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await handleCodexCommand(createContext("computer-use status install"), {
      deps: createDeps({ readCodexComputerUseStatus, installCodexComputerUse }),
    });

    expectResultTextContains(result, "Usage: /codex computer-use");
    expect(readCodexComputerUseStatus).not.toHaveBeenCalled();
    expect(installCodexComputerUse).not.toHaveBeenCalled();
  });

  it("explains compaction when no Codex thread is attached", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");

    await expect(
      handleCodexCommand(createContext("compact", sessionFile), { deps: createDeps() }),
    ).resolves.toEqual({
      text: "No Codex thread is attached to this OpenClaw session yet.",
    });
  });

  it("asks before sending diagnostics feedback for the attached Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      },
      { threadId: "thread-123", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-123" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics tool loop repro", sessionFile, {
        senderId: "user-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      }),
      { deps },
    );

    const token = readDiagnosticsConfirmationToken(request);
    expect(request.text).toBe(
      [
        "Codex runtime thread detected.",
        "Codex diagnostics can send this thread's feedback bundle to OpenAI servers.",
        "Codex sessions:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "agent:main:session-1",
          sessionId: "session-1",
          threadId: "thread-123",
        }),
        "Note: tool loop repro",
        "Included: Codex logs and spawned Codex subthreads when available.",
        `To send: /codex diagnostics confirm ${token}`,
        `To cancel: /codex diagnostics cancel ${token}`,
        "This request expires in 5 minutes.",
      ].join("\n"),
    );
    expect(request.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Send diagnostics",
              action: { type: "command", command: `/codex diagnostics confirm ${token}` },
              value: `/codex diagnostics confirm ${token}`,
              style: "danger",
            },
            {
              label: "Cancel",
              action: { type: "command", command: `/codex diagnostics cancel ${token}` },
              value: `/codex diagnostics cancel ${token}`,
              style: "secondary",
            },
          ],
        },
      ],
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, sessionFile, {
          senderId: "user-1",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "agent:main:session-1",
          sessionId: "session-1",
          threadId: "thread-123",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      {
        classification: "bug",
        reason: "tool loop repro",
        threadId: "thread-123",
        includeLogs: true,
        tags: {
          source: "openclaw-diagnostics",
          channel: "test",
        },
      },
      {
        config: {},
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      },
    );
  });

  it("rejects diagnostics confirmation when the thread auth scope changes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await writeTestBinding(identity, {
      threadId: "thread-auth-change",
      cwd: "/repo",
      authProfileId: "openai:first",
    });
    const safeCodexControlRequest = vi.fn();
    const deps = createDeps({ safeCodexControlRequest });
    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    const token = readDiagnosticsConfirmationToken(request);
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "patch",
      threadId: "thread-auth-change",
      patch: { authProfileId: "openai:second" },
    });

    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("sends supervised diagnostics through the native user-home connection", async () => {
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await writeTestBinding(identity, supervisedTestBinding("thread-supervised-diagnostics"));
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-supervised-diagnostics" },
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const pluginConfig = { supervision: { enabled: true } };
    const request = await handleCodexCommand(createContext("diagnostics"), {
      deps,
      pluginConfig,
    });
    const token = readDiagnosticsConfirmationToken(request);

    await handleCodexCommand(createContext(`diagnostics confirm ${token}`), {
      deps,
      pluginConfig,
    });

    expect(safeCodexControlRequest).toHaveBeenCalledWith(
      pluginConfig,
      CODEX_CONTROL_METHODS.feedback,
      expect.objectContaining({ threadId: "thread-supervised-diagnostics" }),
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
  });

  it("rejects diagnostics confirmation when private connection scope changes", async () => {
    let binding: CodexAppServerThreadBinding = supervisedTestBinding("thread-scope-change");
    const readBinding = vi.fn(async () => binding);
    const safeCodexControlRequest = vi.fn();
    const deps = createDeps({
      bindingStore: { ...testCodexAppServerBindingStore, read: readBinding },
      safeCodexControlRequest,
    });
    const pluginConfig = { supervision: { enabled: true } };
    const request = await handleCodexCommand(createContext("diagnostics"), {
      deps,
      pluginConfig,
    });
    const token = readDiagnosticsConfirmationToken(request);
    binding = { threadId: "thread-scope-change", cwd: "/repo" };

    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`), {
        deps,
        pluginConfig,
      }),
    ).resolves.toEqual({
      text: "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("rejects diagnostics confirmation when the supervised connection changes", async () => {
    let binding: CodexAppServerThreadBinding = supervisedTestBinding("thread-connection-change");
    const readBinding = vi.fn(async () => binding);
    const safeCodexControlRequest = vi.fn();
    const deps = createDeps({
      bindingStore: { ...testCodexAppServerBindingStore, read: readBinding },
      safeCodexControlRequest,
    });
    const pluginConfig = { supervision: { enabled: true } };
    const request = await handleCodexCommand(createContext("diagnostics"), {
      deps,
      pluginConfig,
    });
    const token = readDiagnosticsConfirmationToken(request);
    binding = { ...binding, appServerRuntimeFingerprint: "changed-connection" };

    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`), {
        deps,
        pluginConfig,
      }),
    ).resolves.toEqual({
      text: "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("rejects malformed diagnostics confirmation commands without consuming the token", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-confirm-args", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-confirm-args" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token} extra`, sessionFile), {
        deps,
      }),
    ).resolves.toEqual({
      text: [
        "Usage: /codex diagnostics [note]",
        "Usage: /codex diagnostics confirm <token>",
        "Usage: /codex diagnostics cancel <token>",
      ].join("\n"),
    });
    await expect(
      handleCodexCommand(createContext(`diagnostics cancel ${token} extra`, sessionFile), {
        deps,
      }),
    ).resolves.toEqual({
      text: [
        "Usage: /codex diagnostics [note]",
        "Usage: /codex diagnostics confirm <token>",
        "Usage: /codex diagnostics cancel <token>",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();

    const confirmResult = await handleCodexCommand(
      createContext(`diagnostics confirm ${token}`, sessionFile),
      { deps },
    );
    expectResultTextContains(confirmResult, "Codex diagnostics sent to OpenAI servers:");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("previews exec-approved diagnostics upload without exposing Codex ids", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-preview",
        sessionKey: "agent:main:telegram:preview",
      },
      { threadId: "thread-preview", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-preview" },
    }));

    const result = await handleCodexCommand(
      createContext("diagnostics flaky tool call", sessionFile, {
        diagnosticsPreviewOnly: true,
        senderId: "user-1",
        sessionId: "session-preview",
        sessionKey: "agent:main:telegram:preview",
      }),
      { deps: createDeps({ safeCodexControlRequest }) },
    );

    expect(result.text).toBe(
      [
        "Codex runtime thread detected.",
        "Approving diagnostics will also send this thread's feedback bundle to OpenAI servers.",
        "The completed diagnostics reply will list the OpenClaw session ids and Codex thread ids that were sent.",
        "Note: flaky tool call",
        "Included: Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    );
    expect(result.text).not.toContain("thread-preview");
    expect(result.text).not.toContain("session-preview");
    expect(result.text).not.toContain("agent:main:telegram:preview");
    expect(result.text).not.toContain("To send:");
    expect(result.interactive).toBeUndefined();
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("sends diagnostics feedback immediately after exec approval", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-approved",
        sessionKey: "agent:main:telegram:approved",
      },
      { threadId: "thread-approved", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-approved" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    await expect(
      handleCodexCommand(
        createContext("diagnostics approved repro", sessionFile, {
          diagnosticsUploadApproved: true,
          senderId: "user-1",
          sessionId: "session-approved",
          sessionKey: "agent:main:telegram:approved",
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "agent:main:telegram:approved",
          sessionId: "session-approved",
          threadId: "thread-approved",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
    expect(safeCodexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      {
        classification: "bug",
        reason: "approved repro",
        threadId: "thread-approved",
        includeLogs: true,
        tags: {
          source: "openclaw-diagnostics",
          channel: "test",
        },
      },
      {
        config: {},
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        sessionId: "session-approved",
        sessionKey: "agent:main:telegram:approved",
      },
    );
  });

  it("uploads all Codex diagnostics sessions and reports their channel/thread breakdown", async () => {
    await writeTestBinding(
      {
        kind: "session",
        agentId: "first",
        sessionId: "session-one",
        sessionKey: "agent:first:whatsapp:one",
      },
      { threadId: "thread-111", cwd: "/repo", authProfileId: "openai:first" },
    );
    await writeTestBinding(
      {
        kind: "session",
        agentId: "second",
        sessionId: "session-two",
        sessionKey: "agent:second:discord:two",
      },
      { threadId: "thread-222", cwd: "/repo", authProfileId: "openai:second" },
    );
    const safeCodexControlRequest = vi.fn(async (configForTest, _method, requestParamsLocal) => ({
      ok: true as const,
      value: {
        threadId:
          requestParamsLocal &&
          typeof requestParamsLocal === "object" &&
          "threadId" in requestParamsLocal
            ? requestParamsLocal.threadId
            : undefined,
      },
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const diagnosticsSessions = [
      {
        sessionKey: "agent:first:whatsapp:one",
        sessionId: "session-one",
        channel: "whatsapp",
      },
      {
        sessionKey: "agent:second:discord:two",
        sessionId: "session-two",
        channel: "discord",
      },
    ];

    const request = await handleCodexCommand(
      createContext("diagnostics multi-session repro", undefined, {
        senderId: "user-1",
        channel: "whatsapp",
        agentId: "first",
        sessionKey: "agent:first:whatsapp:one",
        sessionId: "session-one",
        diagnosticsSessions,
      }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);
    expect(request.text).toContain("Codex runtime threads detected.");
    expect(request.text).toContain("OpenClaw session key: `agent:first:whatsapp:one`");
    expect(request.text).toContain("OpenClaw session id: `session-one`");
    expect(request.text).toContain("Codex thread id: `thread-111`");
    expect(request.text).toContain("OpenClaw session key: `agent:second:discord:two`");
    expect(request.text).toContain("OpenClaw session id: `session-two`");
    expect(request.text).toContain("Codex thread id: `thread-222`");
    expect(safeCodexControlRequest).not.toHaveBeenCalled();

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, undefined, {
          senderId: "user-1",
          channel: "whatsapp",
          agentId: "first",
          sessionKey: "agent:first:whatsapp:one",
          sessionId: "session-one",
          diagnosticsSessions,
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          index: 1,
          channel: "whatsapp",
          sessionKey: "agent:first:whatsapp:one",
          sessionId: "session-one",
          threadId: "thread-111",
        }),
        "",
        ...expectedDiagnosticsTargetBlock({
          index: 2,
          channel: "discord",
          sessionKey: "agent:second:discord:two",
          sessionId: "session-two",
          threadId: "thread-222",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
    expect(mockArg(safeCodexControlRequest, 0, 0)).toBeUndefined();
    expect(mockArg(safeCodexControlRequest, 0, 1)).toBe(CODEX_CONTROL_METHODS.feedback);
    const firstFeedbackParams = requestParams(safeCodexControlRequest);
    expect(firstFeedbackParams.threadId).toBe("thread-111");
    expect(firstFeedbackParams.includeLogs).toBe(true);
    expect(mockArg(safeCodexControlRequest, 0, 3)).toEqual({
      config: {},
      agentDir: path.join(tempDir, "agents", "first", "agent"),
      authProfileId: "openai:first",
      sessionId: "session-one",
      sessionKey: "agent:first:whatsapp:one",
    });
    expect(mockArg(safeCodexControlRequest, 1, 0)).toBeUndefined();
    expect(mockArg(safeCodexControlRequest, 1, 1)).toBe(CODEX_CONTROL_METHODS.feedback);
    const secondFeedbackParams = requestParams(safeCodexControlRequest, 1);
    expect(secondFeedbackParams.threadId).toBe("thread-222");
    expect(secondFeedbackParams.includeLogs).toBe(true);
    expect(mockArg(safeCodexControlRequest, 1, 3)).toEqual({
      config: {},
      agentDir: path.join(tempDir, "agents", "second", "agent"),
      authProfileId: "openai:second",
      sessionId: "session-two",
      sessionKey: "agent:second:discord:two",
    });
  });

  it("uses the host agent for diagnostics inventory sessions with unscoped keys", async () => {
    await writeTestBinding(
      {
        kind: "session",
        agentId: "first",
        sessionId: "session-global",
        sessionKey: "global",
      },
      { threadId: "thread-global", cwd: "/repo" },
    );

    const request = await handleCodexCommand(
      createContext("diagnostics global repro", undefined, {
        agentId: "first",
        sessionId: undefined,
        diagnosticsSessions: [
          {
            sessionKey: "global",
            sessionId: "session-global",
            channel: "telegram",
          },
        ],
      }),
      { deps: createDeps() },
    );

    expect(request.text).toContain("Codex runtime thread detected.");
    expect(request.text).toContain("OpenClaw session key: `global`");
    expect(request.text).toContain("Codex thread id: `thread-global`");
  });

  it("requires an owner for Codex diagnostics feedback uploads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-owner", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-owner" },
    }));

    await expect(
      handleCodexCommand(
        createContext("diagnostics", sessionFile, {
          senderIsOwner: false,
        }),
        { deps: createDeps({ safeCodexControlRequest }) },
      ),
    ).resolves.toEqual({
      text: "Only an owner can send Codex diagnostics.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("refuses diagnostics confirmations without a stable sender identity", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-sender-required", cwd: "/repo" },
    );

    await expect(
      handleCodexCommand(
        createContext("diagnostics", sessionFile, {
          senderId: undefined,
        }),
        { deps: createDeps() },
      ),
    ).resolves.toEqual({
      text: "Cannot send Codex diagnostics because this command did not include a sender identity.",
    });
  });

  it("keeps diagnostics confirmation scoped to the requesting sender", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-sender", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-sender" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics", sessionFile, { senderId: "user-1" }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, sessionFile, { senderId: "user-2" }),
        { deps },
      ),
    ).resolves.toEqual({
      text: "Only the user who requested these Codex diagnostics can confirm the upload.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("consumes diagnostics confirmations before async upload work", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    let releaseFirstConfirmBindingRead: () => void = () => undefined;
    let firstConfirmBindingReadStarted: () => void = () => undefined;
    const firstConfirmBindingRead = new Promise<void>((resolve) => {
      releaseFirstConfirmBindingRead = resolve;
    });
    const firstConfirmBindingReadStartedPromise = new Promise<void>((resolve) => {
      firstConfirmBindingReadStarted = resolve;
    });
    let bindingReadCount = 0;
    const readBinding = vi.fn(async () => {
      bindingReadCount += 1;
      if (bindingReadCount === 2) {
        firstConfirmBindingReadStarted();
        await firstConfirmBindingRead;
      }
      return {
        threadId: "thread-race",
        cwd: "/repo",
        createdAt: "2026-04-28T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
      };
    });
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-race" },
    }));
    const deps = createDeps({
      bindingStore: { ...testCodexAppServerBindingStore, read: readBinding },
      safeCodexControlRequest,
    });

    const request = await handleCodexCommand(
      createContext("diagnostics", sessionFile, { senderId: "user-1" }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);
    const firstConfirm = handleCodexCommand(
      createContext(`diagnostics confirm ${token}`, sessionFile, { senderId: "user-1" }),
      { deps },
    );
    await firstConfirmBindingReadStartedPromise;

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, sessionFile, { senderId: "user-1" }),
        { deps },
      ),
    ).resolves.toEqual({
      text: "No pending Codex diagnostics confirmation was found. Run /diagnostics again to create a fresh request.",
    });

    releaseFirstConfirmBindingRead();
    const firstConfirmResult = await firstConfirm;
    expectResultTextContains(firstConfirmResult, "Codex diagnostics sent to OpenAI servers:");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnostics confirmation scoped to account and channel identity", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "session-key-1",
      },
      { threadId: "thread-account", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-account" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics", sessionFile, {
        accountId: "account-1",
        channelId: "channel-1",
        messageThreadId: "thread-1",
        threadParentId: "parent-1",
        sessionKey: "session-key-1",
      }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, sessionFile, {
          accountId: "account-2",
          channelId: "channel-1",
          messageThreadId: "thread-1",
          threadParentId: "parent-1",
          sessionKey: "session-key-1",
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: "This Codex diagnostics confirmation belongs to a different account.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("allows private-routed diagnostics confirmations from the owner DM", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "group-session",
    };
    await writeTestBinding(identity, { threadId: "thread-private", cwd: "/repo" });
    const safeCodexControlRequest = vi.fn(
      async (_pluginConfig: unknown, _method: string, _requestParams: unknown) => ({
        ok: true as const,
        value: { threadId: "thread-private" },
      }),
    );
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics", sessionFile, {
        accountId: "account-1",
        channelId: "group-channel",
        messageThreadId: "group-topic",
        sessionKey: "group-session",
        diagnosticsPrivateRouted: true,
      }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, undefined, {
          accountId: "account-1",
          channelId: "owner-dm",
          sessionKey: "owner-dm-session",
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "group-session",
          sessionId: "session-1",
          threadId: "thread-private",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(mockArg(safeCodexControlRequest, 0, 0)).toBeUndefined();
    expect(mockArg(safeCodexControlRequest, 0, 1)).toBe(CODEX_CONTROL_METHODS.feedback);
    const feedbackParams = requestParams(safeCodexControlRequest);
    expect(feedbackParams.classification).toBe("bug");
    expect(feedbackParams.threadId).toBe("thread-private");
    expect(feedbackParams.includeLogs).toBe(true);

    await writeTestBinding(identity, { threadId: "thread-private-next", cwd: "/repo" });
    const repeated = await handleCodexCommand(
      createContext("diagnostics", sessionFile, {
        accountId: "account-1",
        channelId: "group-channel",
        messageThreadId: "group-topic",
        sessionKey: "group-session",
        diagnosticsPrivateRouted: true,
      }),
      { deps },
    );
    expect(repeated.text).toContain(
      "Codex diagnostics were already sent for this account or channel recently",
    );
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnostics confirmation eviction scoped to account identity", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-confirm-scope", cwd: "/repo" },
    );

    const firstRequest = await handleCodexCommand(
      createContext("diagnostics", sessionFile, {
        accountId: "account-kept",
        channelId: "channel-kept",
      }),
      { deps: createDeps() },
    );
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);

    for (let index = 0; index < 100; index += 1) {
      await handleCodexCommand(
        createContext(`diagnostics ${index}`, sessionFile, {
          accountId: "account-noisy",
          channelId: "channel-noisy",
        }),
        { deps: createDeps() },
      );
    }

    await expect(
      handleCodexCommand(
        createContext(`diagnostics cancel ${firstToken}`, sessionFile, {
          accountId: "account-kept",
          channelId: "channel-kept",
        }),
        { deps: createDeps() },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics upload canceled.",
        "Codex sessions:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionId: "session-1",
          threadId: "thread-confirm-scope",
        }),
      ].join("\n"),
    });
  });

  it("keeps diagnostics notes UTF-16 safe at the upload boundary", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-789", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(
      async (_pluginConfig: unknown, _method: string, _requestParams: unknown) => ({
        ok: true as const,
        value: { threadId: "thread-789" },
      }),
    );
    // The emoji's surrogate pair straddles the 2048-unit feedback limit.
    const expectedReason = "x".repeat(2047);
    const note = `${expectedReason}😀tail`;
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext(`diagnostics ${note}`, sessionFile), {
      deps,
    });
    expect(requireResultText(request).split("\n")).toContain(`Note: ${expectedReason}`);
    const token = readDiagnosticsConfirmationToken(request);
    await handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps });

    expect(mockArg(safeCodexControlRequest, 0, 0)).toBeUndefined();
    expect(mockArg(safeCodexControlRequest, 0, 1)).toBe(CODEX_CONTROL_METHODS.feedback);
    expect(requestParams(safeCodexControlRequest)).toEqual({
      classification: "bug",
      reason: expectedReason,
      threadId: "thread-789",
      includeLogs: true,
      tags: {
        source: "openclaw-diagnostics",
        channel: "test",
      },
    });
  });

  it("escapes diagnostics notes before showing approval text", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-note", cwd: "/repo" },
    );

    const request = await handleCodexCommand(
      createContext("diagnostics <@U123> [trusted](https://evil) @here `tick`", sessionFile),
      { deps: createDeps() },
    );

    expect(request.text).toContain(
      "Note: &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here \uff40tick\uff40",
    );
    expect(request.text).not.toContain("<@U123>");
    expect(request.text).not.toContain("[trusted](https://evil)");
  });

  it("throttles repeated diagnostics uploads for the same thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-cooldown", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-cooldown" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics first", sessionFile), {
      deps,
    });
    const token = readDiagnosticsConfirmationToken(request);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionId: "session-1",
          threadId: "thread-cooldown",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    await expect(
      handleCodexCommand(createContext("diagnostics again", sessionFile), { deps }),
    ).resolves.toEqual({
      text: "Codex diagnostics were already sent for thread thread-cooldown recently. Try again in 60s.",
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("throttles diagnostics uploads across threads", async () => {
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const sessionFile = path.join(tempDir, "global-cooldown-session.jsonl");

    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-global-1", cwd: "/repo" },
    );
    const request = await handleCodexCommand(createContext("diagnostics first", sessionFile), {
      deps,
    });
    const token = readDiagnosticsConfirmationToken(request);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionId: "session-1",
          threadId: "thread-global-1",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });

    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-global-2", cwd: "/repo" },
    );
    await expect(
      handleCodexCommand(createContext("diagnostics second", sessionFile), { deps }),
    ).resolves.toEqual({
      text: "Codex diagnostics were already sent for this account or channel recently. Try again in 60s.",
    });

    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("does not throttle diagnostics uploads across different account scopes", async () => {
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const sessionFile = path.join(tempDir, "scoped-cooldown-session.jsonl");

    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-scope-1", cwd: "/repo" },
    );
    const firstRequest = await handleCodexCommand(
      createContext("diagnostics first", sessionFile, {
        accountId: "account-1",
        channelId: "channel-1",
      }),
      { deps },
    );
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);
    const firstConfirmResult = await handleCodexCommand(
      createContext(`diagnostics confirm ${firstToken}`, sessionFile, {
        accountId: "account-1",
        channelId: "channel-1",
      }),
      { deps },
    );
    expectResultTextContains(firstConfirmResult, "Codex diagnostics sent to OpenAI servers:");

    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-scope-2", cwd: "/repo" },
    );
    const secondRequest = await handleCodexCommand(
      createContext("diagnostics second", sessionFile, {
        accountId: "account-2",
        channelId: "channel-2",
      }),
      { deps },
    );
    const secondToken = readDiagnosticsConfirmationToken(secondRequest);
    const secondConfirmResult = await handleCodexCommand(
      createContext(`diagnostics confirm ${secondToken}`, sessionFile, {
        accountId: "account-2",
        channelId: "channel-2",
      }),
      { deps },
    );
    expectResultTextContains(secondConfirmResult, "Codex diagnostics sent to OpenAI servers:");

    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("does not collide diagnostics cooldown scopes when ids contain delimiters", async () => {
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const sessionFile = path.join(tempDir, "delimiter-cooldown-session.jsonl");

    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-delimiter-1", cwd: "/repo" },
    );
    const firstScope = {
      accountId: "a",
      channelId: "b",
      channel: "test|channel:x",
    };
    const firstRequest = await handleCodexCommand(
      createContext("diagnostics first", sessionFile, firstScope),
      { deps },
    );
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);
    const firstConfirmResult = await handleCodexCommand(
      createContext(`diagnostics confirm ${firstToken}`, sessionFile, firstScope),
      { deps },
    );
    expectResultTextContains(firstConfirmResult, "Codex diagnostics sent to OpenAI servers:");

    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-delimiter-2", cwd: "/repo" },
    );
    const secondScope = {
      accountId: "a|channelId:b",
      channel: "test|channel:x",
    };
    const secondRequest = await handleCodexCommand(
      createContext("diagnostics second", sessionFile, secondScope),
      { deps },
    );
    const secondToken = readDiagnosticsConfirmationToken(secondRequest);
    const secondConfirmResult = await handleCodexCommand(
      createContext(`diagnostics confirm ${secondToken}`, sessionFile, secondScope),
      { deps },
    );
    expectResultTextContains(secondConfirmResult, "Codex diagnostics sent to OpenAI servers:");

    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("does not collide diagnostics cooldown scopes when long ids share a prefix", async () => {
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const sessionFile = path.join(tempDir, "long-scope-cooldown-session.jsonl");
    const sharedPrefix = "account-".repeat(40);

    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-long-scope-1", cwd: "/repo" },
    );
    const firstScope = {
      accountId: `${sharedPrefix}first`,
      channelId: "channel-long",
    };
    const firstRequest = await handleCodexCommand(
      createContext("diagnostics first", sessionFile, firstScope),
      { deps },
    );
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);
    const firstConfirmResult = await handleCodexCommand(
      createContext(`diagnostics confirm ${firstToken}`, sessionFile, firstScope),
      { deps },
    );
    expectResultTextContains(firstConfirmResult, "Codex diagnostics sent to OpenAI servers:");

    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-long-scope-2", cwd: "/repo" },
    );
    const secondScope = {
      accountId: `${sharedPrefix}second`,
      channelId: "channel-long",
    };
    const secondRequest = await handleCodexCommand(
      createContext("diagnostics second", sessionFile, secondScope),
      { deps },
    );
    const secondToken = readDiagnosticsConfirmationToken(secondRequest);
    const secondConfirmResult = await handleCodexCommand(
      createContext(`diagnostics confirm ${secondToken}`, sessionFile, secondScope),
      { deps },
    );
    expectResultTextContains(secondConfirmResult, "Codex diagnostics sent to OpenAI servers:");

    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("sanitizes diagnostics upload errors before showing them", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "<@U123>", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: false as const,
      error: "bad\n\u009b\u202e <@U123> [trusted](https://evil) @here",
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    expect(request.text).toContain("Codex thread id: &lt;\uff20U123&gt;");
    expect(request.text).not.toContain("<@U123>");
    const token = readDiagnosticsConfirmationToken(request);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: [
        "Could not send Codex diagnostics:",
        "- channel test, OpenClaw session session-1, Codex thread &lt;\uff20U123&gt;: bad??? &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
        "Inspect locally:",
        "- run codex resume and paste the thread id shown above",
      ].join("\n"),
    });
  });

  it("keeps diagnostics upload errors UTF-16 safe at the display boundary", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-error-boundary", cwd: "/repo" },
    );
    // The emoji's surrogate pair straddles the 500-unit display limit.
    const expectedError = "x".repeat(499);
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: false as const,
      error: `${expectedError}😀tail`,
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: [
        "Could not send Codex diagnostics:",
        `- channel test, OpenClaw session session-1, Codex thread thread-error-boundary: ${expectedError}`,
        "Inspect locally:",
        "- `codex resume thread-error-boundary`",
      ].join("\n"),
    });
  });

  it("does not throttle diagnostics retries after upload failures", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-retry", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "temporary outage" })
      .mockResolvedValueOnce({ ok: true as const, value: { threadId: "thread-retry" } });
    const deps = createDeps({ safeCodexControlRequest });

    const firstRequest = await handleCodexCommand(createContext("diagnostics", sessionFile), {
      deps,
    });
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${firstToken}`, sessionFile), {
        deps,
      }),
    ).resolves.toEqual({
      text: [
        "Could not send Codex diagnostics:",
        "- channel test, OpenClaw session session-1, Codex thread thread-retry: temporary outage",
        "Inspect locally:",
        "- `codex resume thread-retry`",
      ].join("\n"),
    });

    const secondRequest = await handleCodexCommand(createContext("diagnostics", sessionFile), {
      deps,
    });
    const secondToken = readDiagnosticsConfirmationToken(secondRequest);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${secondToken}`, sessionFile), {
        deps,
      }),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionId: "session-1",
          threadId: "thread-retry",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("omits inline diagnostics resume commands for unsafe thread ids", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      {
        threadId: "thread-123'`\n\u009b\u202e; echo bad",
        cwd: "/repo",
      },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-123'`\n\u009b\u202e; echo bad" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    const token = readDiagnosticsConfirmationToken(request);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        "Session 1",
        "Channel: test",
        "OpenClaw session id: `session-1`",
        "Codex thread id: thread-123'\uff40???; echo bad",
        "Inspect locally: run codex resume and paste the thread id shown above",
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
  });

  it("explains diagnostics when no Codex thread is attached", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");

    await expect(
      handleCodexCommand(createContext("diagnostics", sessionFile), { deps: createDeps() }),
    ).resolves.toEqual({
      text: [
        "No Codex thread is attached to this OpenClaw session yet.",
        "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
      ].join("\n"),
    });
  });

  it("passes filters to Codex thread listing", async () => {
    const codexControlRequest = vi.fn(async () => ({
      data: [{ id: "thread-123", title: "Fix the thing", model: "gpt-5.4", cwd: "/repo" }],
    }));
    const deps = createDeps({
      codexControlRequest,
    });

    await expect(handleCodexCommand(createContext("threads fix"), { deps })).resolves.toEqual({
      text: [
        "Codex threads:",
        "- thread-123 - Fix the thing (gpt-5.4, /repo)",
        "  Resume: /codex resume thread-123",
      ].join("\n"),
    });
    expect(codexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.listThreads,
      { limit: 10, searchTerm: "fix" },
      expect.objectContaining({
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        sessionId: "session-1",
      }),
    );
  });

  it("escapes Codex thread fields and avoids unsafe resume commands", async () => {
    const codexControlRequest = vi.fn(async () => ({
      data: [
        {
          id: "thread-123\n`bad`",
          title: "<@U123> [trusted](https://evil) @here",
          model: "gpt_5",
          cwd: "/repo_(x)",
        },
      ],
    }));
    const deps = createDeps({ codexControlRequest });

    const result = await handleCodexCommand(createContext("threads"), { deps });

    expect(result.text).toContain("thread-123?\uff40bad\uff40");
    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).toContain("(gpt\uff3f5, /repo\uff3f\uff08x\uff09)");
    expect(result.text).toContain(
      "Resume: copy the thread id above and run /codex resume <thread-id>",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("Resume: /codex resume thread-123");
  });

  it("escapes Codex MCP and skill list entries before chat display", async () => {
    const codexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ name: "<@U123> [mcp](https://evil)" }] })
      .mockResolvedValueOnce({
        data: [
          {
            cwd: "/repo",
            skills: [
              {
                name: "skill_1 @here",
                description: "",
                path: "/repo/.codex/skills/skill_1/SKILL.md",
                scope: "repo",
                enabled: true,
              },
            ],
            errors: [],
          },
        ],
      });
    const deps = createDeps({ codexControlRequest });

    const mcp = await handleCodexCommand(createContext("mcp"), { deps });
    const skills = await handleCodexCommand(createContext("skills"), { deps });

    expect(mcp.text).toContain("&lt;\uff20U123&gt; \uff3bmcp\uff3d\uff08https://evil\uff09");
    expect(skills.text).toContain("- `skill\uff3f1 \uff20here`");
    expect(`${mcp.text}\n${skills.text}`).not.toContain("<@U123>");
    expect(`${mcp.text}\n${skills.text}`).not.toContain("[mcp](https://evil)");
    expect(`${mcp.text}\n${skills.text}`).not.toContain("@here");
  });

  it("scopes Codex read commands to the bound agent and auth profile", async () => {
    const agentDir = path.join(tempDir, "agents", "worker", "agent");
    const getCurrentConversationBinding = async () => ({
      bindingId: "binding-1",
      pluginId: "codex",
      pluginRoot: "/plugin",
      channel: "test",
      accountId: "default",
      conversationId: "conversation",
      boundAt: 1,
      data: {
        kind: "codex-app-server-session" as const,
        version: 2 as const,
        bindingId: "binding-data-1",
        workspaceDir: "/repo",
        agentDir,
        start: { id: "generation-1", authProfileId: "openai:work" },
      },
    });
    const codexControlRequest = vi.fn(async (_pluginConfig: unknown, _method: string) => ({
      data: [],
    }));
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ codexControlRequest, safeCodexControlRequest });
    const context = (args: string) =>
      createContext(args, undefined, {
        sessionKey: "agent:worker:session-1",
        getCurrentConversationBinding,
      });

    await handleCodexCommand(context("mcp"), { deps });
    await handleCodexCommand(context("skills"), { deps });
    await handleCodexCommand(context("account"), { deps });

    const expectedScope = expect.objectContaining({
      agentDir,
      authProfileId: "openai:work",
      sessionKey: "agent:worker:session-1",
      sessionId: "session-1",
    });
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      1,
      undefined,
      CODEX_CONTROL_METHODS.listMcpServers,
      { limit: 100 },
      expectedScope,
    );
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      2,
      undefined,
      CODEX_CONTROL_METHODS.listSkills,
      {},
      expectedScope,
    );
    expect(safeCodexControlRequest).toHaveBeenNthCalledWith(
      1,
      undefined,
      CODEX_CONTROL_METHODS.account,
      { refreshToken: false },
      expectedScope,
    );
    expect(safeCodexControlRequest).toHaveBeenNthCalledWith(
      2,
      undefined,
      CODEX_CONTROL_METHODS.rateLimits,
      undefined,
      expectedScope,
    );
  });

  it("scopes supervised Codex reads to the native user-home connection", async () => {
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      supervisedTestBinding(),
    );
    const codexControlRequest = vi.fn(async () => ({ data: [] }));
    const pluginConfig = { supervision: { enabled: true } };

    await handleCodexCommand(createContext("threads"), {
      deps: createDeps({ codexControlRequest }),
      pluginConfig,
    });

    expect(codexControlRequest).toHaveBeenCalledWith(
      pluginConfig,
      CODEX_CONTROL_METHODS.listThreads,
      { limit: 10 },
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
  });

  it("formats every Codex skill as a code-styled bullet and tolerates malformed entries", async () => {
    const malformedSkillEntries: JsonValue[] = [
      null,
      { description: "missing name" },
      {
        name: "final-skill",
        description: "Final skill",
        path: "/repo-b/.codex/skills/final-skill/SKILL.md",
        scope: "repo",
        enabled: true,
      },
    ];
    const codexControlRequest = vi.fn(async () => ({
      data: [
        {
          cwd: "/repo-a",
          skills: Array.from({ length: 26 }, (_, index) => ({
            name: `skill-${index + 1}`,
            description: `Skill ${index + 1}`,
            path: `/repo-a/.codex/skills/skill-${index + 1}/SKILL.md`,
            scope: "repo",
            enabled: true,
          })).concat({
            name: "disabled-skill",
            description: "Disabled skill",
            path: "/repo-a/.codex/skills/disabled-skill/SKILL.md",
            scope: "repo",
            enabled: false,
          }),
          errors: [{ path: "/repo-a/bad/SKILL.md", message: "bad skill" }],
        },
        {
          cwd: "/repo-b",
          skills: malformedSkillEntries,
          errors: [],
        },
        "malformed group",
      ],
    }));
    const deps = createDeps({ codexControlRequest });

    const result = await handleCodexCommand(createContext("skills"), { deps });

    expect(result.text).toContain("- `skill-1`");
    expect(result.text).toContain("- `skill-26`");
    expect(result.text).toContain("- `&lt;unknown&gt;`");
    expect(result.text).toContain("- `final-skill`");
    expect(result.text).not.toContain("Workspace:");
    expect(result.text).not.toContain("Error:");
    expect(result.text).not.toContain("More skills available");
    expect(result.text).not.toContain("Skill 1");
    expect(result.text).not.toContain("/repo-a/.codex/skills");
    expect(result.text).not.toContain("disabled-skill");
  });

  it("reports Codex skill load errors when no skills render", async () => {
    const codexControlRequest = vi.fn(async () => ({
      data: [
        {
          cwd: "/repo-a",
          skills: [
            {
              name: "disabled-skill",
              description: "Disabled skill",
              path: "/repo-a/.codex/skills/disabled-skill/SKILL.md",
              scope: "repo",
              enabled: false,
            },
          ],
          errors: [
            { path: "/repo-a/bad/SKILL.md", message: "bad skill <@U123>" },
            { path: "/repo-a/other/SKILL.md", message: "other bad skill @here" },
          ],
        },
      ],
    }));
    const deps = createDeps({ codexControlRequest });

    const result = await handleCodexCommand(createContext("skills"), { deps });

    expect(result.text).toBe("Codex skills: none returned (2 load errors).");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("@here");
  });

  it("returns sanitized command failures instead of leaking app-server errors", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-123", cwd: "/repo" },
    );
    const failure = () => {
      throw new Error("app-server failed <@U123> [trusted](https://evil) @here");
    };
    const expectSanitizedFailure = (result: PluginCommandResult) => {
      expect(result.text).toContain(
        "Codex command failed: app-server failed &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
      );
      expect(result.text).not.toContain("<@U123>");
      expect(result.text).not.toContain("[trusted](https://evil)");
      expect(result.text).not.toContain("@here");
    };

    for (const [args, deps] of [
      ["models", createDeps({ listCodexAppServerModels: vi.fn(failure) })],
      ["threads", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["mcp", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["skills", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["resume thread-123", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["compact", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["review", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["stop", createDeps({ stopCodexConversationTurn: vi.fn(failure) })],
      ["steer keep going", createDeps({ steerCodexConversationTurn: vi.fn(failure) })],
      ["model gpt-5.4", createDeps({ setCodexConversationModel: vi.fn(failure) })],
    ] as const) {
      expectSanitizedFailure(await handleCodexCommand(createContext(args, sessionFile), { deps }));
    }
  });

  it("records an approved Codex bind intent without starting a thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      {
        threadId: "thread-123",
        cwd: "/repo",
        authProfileId: "openai:work",
        modelProvider: "openai",
      },
    );
    const requestConversationBinding = vi.fn(async (_request?: { summary?: string }) => ({
      status: "bound" as const,
      binding: {
        bindingId: "binding-1",
        pluginId: "codex",
        pluginRoot: "/plugin",
        channel: "test",
        accountId: "default",
        conversationId: "conversation",
        boundAt: 1,
      },
    }));

    await expect(
      handleCodexCommand(
        createContext(
          "bind thread-123 --cwd /repo --model gpt-5.4 --provider openai",
          sessionFile,
          {
            requestConversationBinding,
          },
        ),
        {
          deps: createDeps({
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Bound this conversation to thread-123 in /repo. The next message will initialize it.",
    });
    expect(requestConversationBinding).toHaveBeenCalledWith({
      summary: "Codex app-server thread thread-123 in /repo",
      detachHint: "/codex detach",
      data: {
        kind: "codex-app-server-session",
        version: 2,
        bindingId: expect.any(String),
        workspaceDir: "/repo",
        agentId: "main",
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        source: {
          agentId: "main",
          sessionId: "session-1",
          threadId: "thread-123",
        },
        start: {
          id: expect.any(String),
          threadId: "thread-123",
          model: "gpt-5.4",
          modelProvider: "openai",
          authProfileId: "openai:work",
        },
      },
    });
    await expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ threadId: "thread-123" });
  });

  it("does not transfer a replacement session thread while recording bind intent", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await writeTestBinding(identity, { threadId: "thread-old", cwd: "/repo" });
    let requestedData: Record<string, unknown> | undefined;
    const requestConversationBinding = vi.fn(
      async (request?: { data?: Record<string, unknown> }) => {
        requestedData = request?.data;
        await writeTestBinding(identity, { threadId: "thread-new", cwd: "/repo" });
        return {
          status: "bound" as const,
          binding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: "/plugin",
            channel: "test",
            accountId: "default",
            conversationId: "conversation",
            boundAt: 1,
          },
        };
      },
    );

    await handleCodexCommand(
      createContext("bind thread-target --cwd /repo", sessionFile, {
        requestConversationBinding,
      }),
      { deps: createDeps() },
    );

    expect(requestedData).toMatchObject({
      source: {
        agentId: "main",
        sessionId: "session-1",
        threadId: "thread-old",
      },
    });
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: "thread-new",
    });
  });

  it("reuses the existing owner for a lazy Codex rebind", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      { threadId: "thread-old", cwd: "/old-repo", authProfileId: "openai:work" },
    );
    const requestConversationBinding = vi.fn(async () => ({
      status: "bound" as const,
      binding: {
        bindingId: "binding-1",
        pluginId: "codex",
        pluginRoot: "/plugin",
        channel: "test",
        accountId: "default",
        conversationId: "conversation",
        boundAt: Date.now(),
      },
    }));
    const getCurrentConversationBinding = vi.fn(async () => ({
      bindingId: "binding-1",
      pluginId: "codex",
      pluginRoot: "/plugin",
      channel: "test",
      accountId: "default",
      conversationId: "conversation",
      boundAt: Date.now(),
      data: {
        kind: "codex-app-server-session",
        version: 2,
        bindingId: "binding-data-1",
        workspaceDir: "/old-repo",
      },
    }));

    await handleCodexCommand(
      createContext("bind thread-456 --cwd /repo", sessionFile, {
        getCurrentConversationBinding,
        requestConversationBinding,
      }),
      { deps: createDeps({ resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default") }) },
    );

    await expect(
      testCodexAppServerBindingStore.read({
        kind: "conversation",
        bindingId: "binding-data-1",
      }),
    ).resolves.toMatchObject({ threadId: "thread-old" });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bindingId: "binding-data-1",
          start: expect.objectContaining({
            id: expect.any(String),
            threadId: "thread-456",
            authProfileId: "openai:work",
          }),
        }),
      }),
    );
  });

  it("preserves the current Codex conversation owner when refresh fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      { threadId: "thread-old", cwd: "/old-repo" },
    );
    const getCurrentConversationBinding = vi.fn(async () => ({
      bindingId: "binding-1",
      pluginId: "codex",
      pluginRoot: "/plugin",
      channel: "test",
      accountId: "default",
      conversationId: "conversation",
      boundAt: Date.now(),
      data: {
        kind: "codex-app-server-session",
        version: 2,
        bindingId: "binding-data-1",
        workspaceDir: "/old-repo",
      },
    }));

    const result = await handleCodexCommand(
      createContext("bind thread-456 --cwd /repo", sessionFile, {
        getCurrentConversationBinding,
        requestConversationBinding: async () => {
          throw new Error("binding refresh failed");
        },
      }),
      { deps: createDeps() },
    );

    expect(result.text).toContain("binding refresh failed");
    await expect(
      testCodexAppServerBindingStore.read({
        kind: "conversation",
        bindingId: "binding-data-1",
      }),
    ).resolves.toMatchObject({ threadId: "thread-old" });
  });

  it("binds quoted workspace paths that contain spaces", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requestConversationBinding = vi.fn(async (_request?: { summary?: string }) => ({
      status: "bound" as const,
      binding: {
        bindingId: "binding-1",
        pluginId: "codex",
        pluginRoot: "/plugin",
        channel: "test",
        accountId: "default",
        conversationId: "conversation",
        boundAt: 1,
      },
    }));

    await expect(
      handleCodexCommand(
        createContext('bind thread-123 --cwd "/repo with space"', sessionFile, {
          requestConversationBinding,
        }),
        {
          deps: createDeps({
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Bound this conversation to thread-123 in /repo with space. The next message will initialize it.",
    });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceDir: "/repo with space" }),
      }),
    );
  });

  it("escapes bound Codex thread ids and workspace paths before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const unsafeThread = "thread-123 <@U123>";
    const unsafeWorkspace = "/repo [trusted](https://evil)";
    const requestConversationBinding = vi.fn(async (_request?: { summary?: string }) => ({
      status: "bound" as const,
      binding: {
        bindingId: "binding-1",
        pluginId: "codex",
        pluginRoot: "/plugin",
        channel: "test",
        accountId: "default",
        conversationId: "conversation",
        boundAt: 1,
      },
    }));

    const result = await handleCodexCommand(
      createContext(`bind "${unsafeThread}" --cwd "${unsafeWorkspace}"`, sessionFile, {
        requestConversationBinding,
      }),
      {
        deps: createDeps({
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        }),
      },
    );

    expect(result.text).toContain("thread-123 &lt;\uff20U123&gt;");
    expect(result.text).toContain("/repo \uff3btrusted\uff3d\uff08https://evil\uff09");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    const bindingRequest = mockArg(requestConversationBinding, 0, 0) as { summary?: string };
    expect(bindingRequest?.summary).toBe(
      "Codex app-server thread thread-123 &lt;\uff20U123&gt; in /repo \uff3btrusted\uff3d\uff08https://evil\uff09",
    );
  });

  it("rejects bind options with missing, blank, or repeated values before starting Codex", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requestConversationBinding = vi.fn();

    await expect(
      handleCodexCommand(
        createContext("bind thread-123 --cwd --model gpt-5.4", sessionFile, {
          requestConversationBinding,
        }),
        {
          deps: createDeps({
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    await expect(
      handleCodexCommand(
        createContext('bind thread-123 --cwd ""', sessionFile, {
          requestConversationBinding,
        }),
        {
          deps: createDeps({
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    await expect(
      handleCodexCommand(
        createContext("bind thread-123 --cwd /repo --cwd /other", sessionFile, {
          requestConversationBinding,
        }),
        {
          deps: createDeps({
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    expect(requestConversationBinding).not.toHaveBeenCalled();
  });

  it("rejects malformed bind arguments before requiring a session file", async () => {
    await expect(
      handleCodexCommand(createContext("bind thread-123 --cwd", undefined), {
        deps: createDeps({
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
  });

  it("returns the binding approval reply when conversation bind needs approval", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-before-approval", cwd: "/repo" },
    );
    const reply = { text: "Approve this?" };
    const requestConversationBinding = vi.fn(async () => ({
      status: "pending" as const,
      approvalId: "approval-1",
      reply,
    }));
    await expect(
      handleCodexCommand(
        createContext("bind", sessionFile, {
          requestConversationBinding,
        }),
        {
          deps: createDeps({
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual(reply);
    const request = mockArg(requestConversationBinding, 0, 0) as {
      data?: { bindingId?: string };
    };
    await expect(
      testCodexAppServerBindingStore.read({
        kind: "conversation",
        bindingId: request.data?.bindingId ?? "missing",
      }),
    ).resolves.toBeUndefined();
    await expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ threadId: "thread-before-approval" });
  });

  it("does not start Codex when conversation binding is rejected", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const clearBinding = vi.fn(async () => true);

    await expect(
      handleCodexCommand(
        createContext("bind", sessionFile, {
          requestConversationBinding: async () => ({
            status: "error",
            message: "binding unsupported <@U123> [trusted](https://evil)",
          }),
        }),
        {
          deps: createDeps({
            bindingStore: { ...testCodexAppServerBindingStore, mutate: clearBinding },
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "binding unsupported &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09",
    });
    expect(clearBinding).not.toHaveBeenCalled();
  });

  it("detaches the current conversation and clears the Codex app-server thread binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const clearBinding = vi.fn(async () => true);
    const detachConversationBinding = vi.fn(async () => ({ removed: true }));

    await expect(
      handleCodexCommand(
        createContext("detach", sessionFile, {
          detachConversationBinding,
          getCurrentConversationBinding: async () => ({
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: "/plugin",
            channel: "test",
            accountId: "default",
            conversationId: "conversation",
            boundAt: 1,
            data: {
              kind: "codex-app-server-session",
              version: 2,
              bindingId: "binding-data-1",
              workspaceDir: "/repo",
            },
          }),
        }),
        {
          deps: createDeps({
            bindingStore: { ...testCodexAppServerBindingStore, mutate: clearBinding },
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Detached this conversation from Codex.",
    });
    expect(detachConversationBinding).toHaveBeenCalled();
    expect(clearBinding).toHaveBeenCalledWith(
      { kind: "conversation", bindingId: "binding-data-1" },
      { kind: "clear" },
    );
  });

  it("rejects malformed detach commands before clearing bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const clearBinding = vi.fn();
    const detachConversationBinding = vi.fn();

    await expect(
      handleCodexCommand(
        createContext("detach now", sessionFile, {
          detachConversationBinding,
        }),
        {
          deps: createDeps({
            bindingStore: { ...testCodexAppServerBindingStore, mutate: clearBinding },
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex detach",
    });
    expect(detachConversationBinding).not.toHaveBeenCalled();
    expect(clearBinding).not.toHaveBeenCalled();
  });

  it("stops the active bound Codex turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const pluginConfig = { appServer: { homeScope: "agent" as const } };
    const stopCodexConversationTurn = vi.fn(async () => ({
      stopped: true,
      message: "Codex stop requested.",
    }));

    await expect(
      handleCodexCommand(createContext("stop", sessionFile), {
        pluginConfig,
        deps: createDeps({ stopCodexConversationTurn }),
      }),
    ).resolves.toEqual({ text: "Codex stop requested." });
    expect(stopCodexConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { kind: "session", agentId: "main", sessionId: "session-1" },
        pluginConfig,
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        config: {},
      }),
    );
  });

  it("stops the active bound Codex turn in sandboxed sessions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const stopCodexConversationTurn = vi.fn(async () => ({
      stopped: true,
      message: "Codex stop requested.",
    }));

    await expect(
      handleCodexCommand(createSandboxedContext("stop", sessionFile), {
        deps: createDeps({ stopCodexConversationTurn }),
      }),
    ).resolves.toEqual({ text: "Codex stop requested." });
    expect(stopCodexConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          kind: "session",
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "sandboxed-session",
        },
      }),
    );
  });

  it("rejects malformed stop commands before interrupting Codex", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const stopCodexConversationTurn = vi.fn();

    await expect(
      handleCodexCommand(createContext("stop now", sessionFile), {
        deps: createDeps({ stopCodexConversationTurn }),
      }),
    ).resolves.toEqual({ text: "Usage: /codex stop" });
    expect(stopCodexConversationTurn).not.toHaveBeenCalled();
  });

  it("steers the active bound Codex turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const pluginConfig = { appServer: { homeScope: "agent" as const } };
    const steerCodexConversationTurn = vi.fn(async () => ({
      steered: true,
      message: "Sent steer message to Codex.",
    }));

    await expect(
      handleCodexCommand(createContext("steer focus tests first", sessionFile), {
        pluginConfig,
        deps: createDeps({ steerCodexConversationTurn }),
      }),
    ).resolves.toEqual({ text: "Sent steer message to Codex." });
    expect(steerCodexConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { kind: "session", agentId: "main", sessionId: "session-1" },
        message: "focus tests first",
        pluginConfig,
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        config: {},
      }),
    );
  });

  it("sets per-binding model, fast mode, and permissions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const setCodexConversationModel = vi.fn(async () => "Codex model set to gpt-5.4.");
    const setCodexConversationFastMode = vi.fn(async () => "Codex fast mode enabled.");
    const setCodexConversationPermissions = vi.fn(
      async () => "Codex permissions set to full access.",
    );
    const deps = createDeps({
      setCodexConversationModel,
      setCodexConversationFastMode,
      setCodexConversationPermissions,
    });

    await expect(
      handleCodexCommand(createContext("model gpt-5.4", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Codex model set to gpt-5.4." });
    await expect(
      handleCodexCommand(createContext("fast on", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Codex fast mode enabled." });
    await expect(
      handleCodexCommand(createContext("permissions yolo", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Codex permissions set to full access." });

    expect(setCodexConversationModel).toHaveBeenCalledWith({
      identity: { kind: "session", agentId: "main", sessionId: "session-1" },
      bindingStore: testCodexAppServerBindingStore,
      pluginConfig: undefined,
      model: "gpt-5.4",
      agentDir: path.join(tempDir, "agents", "main", "agent"),
      config: {},
    });
    expect(setCodexConversationFastMode).toHaveBeenCalledWith({
      identity: { kind: "session", agentId: "main", sessionId: "session-1" },
      bindingStore: testCodexAppServerBindingStore,
      enabled: true,
    });
    expect(setCodexConversationPermissions).toHaveBeenCalledWith({
      identity: { kind: "session", agentId: "main", sessionId: "session-1" },
      bindingStore: testCodexAppServerBindingStore,
      mode: "yolo",
    });
  });

  it("rejects model and binding replacement commands for a locked supervised session", async () => {
    const locked = await createLockedSessionContextOverrides();
    const requestConversationBinding = vi.fn<PluginCommandContext["requestConversationBinding"]>();
    const detachConversationBinding = vi.fn<PluginCommandContext["detachConversationBinding"]>();
    const getCurrentConversationBinding =
      vi.fn<PluginCommandContext["getCurrentConversationBinding"]>();
    const setCodexConversationModel = vi.fn();
    const codexControlRequest = vi.fn();
    const resolveCodexCliSessionForBindingOnNode = vi.fn();
    const deps = createDeps({
      codexControlRequest,
      resolveCodexCliSessionForBindingOnNode,
      setCodexConversationModel,
    });

    for (const args of [
      "model gpt-5.4",
      "bind thread-other",
      "resume thread-other",
      "resume cli-other --host node-1 --bind here",
      "detach",
      "unbind",
    ]) {
      await expect(
        handleCodexCommand(
          createContext(args, undefined, {
            ...locked,
            detachConversationBinding,
            getCurrentConversationBinding,
            requestConversationBinding,
          }),
          { deps },
        ),
      ).resolves.toEqual({ text: MODEL_SELECTION_LOCKED_MESSAGE });
    }

    expect(setCodexConversationModel).not.toHaveBeenCalled();
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(resolveCodexCliSessionForBindingOnNode).not.toHaveBeenCalled();
    expect(requestConversationBinding).not.toHaveBeenCalled();
    expect(detachConversationBinding).not.toHaveBeenCalled();
    expect(getCurrentConversationBinding).not.toHaveBeenCalled();
  });

  it("rejects bind and resume replacement from private supervision state without a public lock", async () => {
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      supervisedTestBinding("thread-private-owner"),
    );
    const requestConversationBinding = vi.fn<PluginCommandContext["requestConversationBinding"]>();
    const codexControlRequest = vi.fn();
    const resolveCodexCliSessionForBindingOnNode = vi.fn();
    const deps = createDeps({ codexControlRequest, resolveCodexCliSessionForBindingOnNode });

    for (const args of [
      "bind thread-other",
      "resume thread-other",
      "resume cli-other --host node-1 --bind here",
    ]) {
      const result = await handleCodexCommand(
        createContext(args, undefined, { requestConversationBinding }),
        { deps, pluginConfig: { supervision: { enabled: true } } },
      );
      expectResultTextContains(result, "Refusing to replace supervised Codex thread");
    }

    expect(requestConversationBinding).not.toHaveBeenCalled();
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(resolveCodexCliSessionForBindingOnNode).not.toHaveBeenCalled();
  });

  it("keeps model status, fast mode, and permissions available for a locked session", async () => {
    const locked = await createLockedSessionContextOverrides();
    const sessionKey = locked.sessionKey ?? "missing";
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1", sessionKey },
      { threadId: "thread-native", cwd: "/repo", model: "native-model" },
    );
    const setCodexConversationFastMode = vi.fn(async () => "Codex fast mode enabled.");
    const setCodexConversationPermissions = vi.fn(
      async () => "Codex permissions set to full access.",
    );
    const deps = createDeps({
      setCodexConversationFastMode,
      setCodexConversationPermissions,
    });

    await expect(
      handleCodexCommand(createContext("model", undefined, locked), { deps }),
    ).resolves.toEqual({ text: "Codex model: native-model" });
    await expect(
      handleCodexCommand(createContext("fast on", undefined, locked), { deps }),
    ).resolves.toEqual({ text: "Codex fast mode enabled." });
    await expect(
      handleCodexCommand(createContext("permissions yolo", undefined, locked), { deps }),
    ).resolves.toEqual({ text: "Codex permissions set to full access." });

    expect(setCodexConversationFastMode).toHaveBeenCalledOnce();
    expect(setCodexConversationPermissions).toHaveBeenCalledOnce();
  });

  it("escapes current bound model status before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      {
        threadId: "thread-model",
        cwd: "/repo",
        model: "model_<@U123>_[trusted](https://evil)",
      },
    );

    const result = await handleCodexCommand(createContext("model", sessionFile), {
      deps: createDeps(),
    });

    expect(result.text).toContain(
      "model\uff3f&lt;\uff20U123&gt;\uff3f\uff3btrusted\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });

  it("rejects malformed model commands before persisting the model", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const setCodexConversationModel = vi.fn();

    await expect(
      handleCodexCommand(createContext("model gpt-5.4 extra", sessionFile), {
        deps: createDeps({ setCodexConversationModel }),
      }),
    ).resolves.toEqual({ text: "Usage: /codex model <model>" });
    expect(setCodexConversationModel).not.toHaveBeenCalled();
  });

  it("rejects extra fast and permissions arguments", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const setCodexConversationFastMode = vi.fn();
    const setCodexConversationPermissions = vi.fn();
    const deps = createDeps({
      setCodexConversationFastMode,
      setCodexConversationPermissions,
    });

    await expect(
      handleCodexCommand(createContext("fast on now", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Usage: /codex fast [on|off|status]" });
    await expect(
      handleCodexCommand(createContext("permissions yolo now", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Usage: /codex permissions [default|yolo|status]" });

    expect(setCodexConversationFastMode).not.toHaveBeenCalled();
    expect(setCodexConversationPermissions).not.toHaveBeenCalled();
  });

  it("rejects malformed control arguments before requiring a session file", async () => {
    const deps = createDeps({
      setCodexConversationModel: vi.fn(),
      setCodexConversationFastMode: vi.fn(),
      setCodexConversationPermissions: vi.fn(),
    });

    await expect(
      handleCodexCommand(createContext("model gpt-5.4 extra"), { deps }),
    ).resolves.toEqual({
      text: "Usage: /codex model <model>",
    });
    await expect(handleCodexCommand(createContext("fast on now"), { deps })).resolves.toEqual({
      text: "Usage: /codex fast [on|off|status]",
    });
    await expect(
      handleCodexCommand(createContext("permissions yolo now"), { deps }),
    ).resolves.toEqual({
      text: "Usage: /codex permissions [default|yolo|status]",
    });
    expect(deps.setCodexConversationModel).not.toHaveBeenCalled();
    expect(deps.setCodexConversationFastMode).not.toHaveBeenCalled();
    expect(deps.setCodexConversationPermissions).not.toHaveBeenCalled();
  });

  it("uses current plugin binding data for follow-up control commands", async () => {
    const pluginSessionFile = path.join(tempDir, "plugin-session.jsonl");
    const setCodexConversationFastMode = vi.fn(async () => "Codex fast mode enabled.");

    await expect(
      handleCodexCommand(
        createContext("fast on", pluginSessionFile, {
          getCurrentConversationBinding: async () => ({
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: "/plugin",
            channel: "slack",
            accountId: "default",
            conversationId: "user:U123",
            boundAt: 1,
            data: {
              kind: "codex-app-server-session",
              version: 2,
              bindingId: "binding-data-1",
              workspaceDir: tempDir,
            },
          }),
        }),
        {
          deps: createDeps({
            setCodexConversationFastMode,
          }),
        },
      ),
    ).resolves.toEqual({ text: "Codex fast mode enabled." });

    expect(setCodexConversationFastMode).toHaveBeenCalledWith({
      identity: { kind: "conversation", bindingId: "binding-data-1" },
      bindingStore: testCodexAppServerBindingStore,
      enabled: true,
    });
  });

  it("describes active binding preferences", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      {
        threadId: "thread-123",
        cwd: "/repo",
        model: "gpt-5.4",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    );

    await expect(
      handleCodexCommand(
        createContext("binding", sessionFile, {
          getCurrentConversationBinding: async () => ({
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: "/plugin",
            channel: "test",
            accountId: "default",
            conversationId: "conversation",
            boundAt: 1,
            data: {
              kind: "codex-app-server-session",
              version: 2,
              bindingId: "binding-data-1",
              workspaceDir: "/repo",
            },
          }),
        }),
        {
          deps: createDeps({
            readCodexConversationActiveTurn: vi.fn(() => ({
              identity: { kind: "conversation" as const, bindingId: "binding-data-1" },
              client: { request: vi.fn() } as never,
              threadId: "thread-123",
              turnId: "turn-1",
              interrupt: vi.fn(),
              steer: vi.fn(),
            })),
          }),
        },
      ),
    ).resolves.toEqual({
      text: [
        "Codex conversation binding:",
        "- Thread: thread-123",
        "- Workspace: /repo",
        "- Model: gpt-5.4",
        "- Fast: on",
        "- Permissions: full access",
        "- Active run: turn-1",
        "- Binding: binding-data-1",
      ].join("\n"),
    });
  });

  it("escapes active binding fields before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      {
        threadId: "thread-123 <@U123>",
        cwd: "/repo",
        model: "gpt [trusted](https://evil)",
      },
    );

    const result = await handleCodexCommand(
      createContext("binding", sessionFile, {
        getCurrentConversationBinding: async () => ({
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: "/plugin",
          channel: "test",
          accountId: "default",
          conversationId: "conversation",
          boundAt: 1,
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: "binding-data-1",
            workspaceDir: "/repo <@U123>",
          },
        }),
      }),
      { deps: createDeps() },
    );

    expect(result.text).toContain("Thread: thread-123 &lt;\uff20U123&gt;");
    expect(result.text).toContain("Workspace: /repo &lt;\uff20U123&gt;");
    expect(result.text).toContain("Model: gpt \uff3btrusted\uff3d\uff08https://evil\uff09");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });
});

function computerUseReadyStatus(): CodexComputerUseStatus {
  return {
    enabled: true,
    ready: true,
    reason: "ready",
    installed: true,
    pluginEnabled: true,
    mcpServerAvailable: true,
    pluginName: "computer-use",
    mcpServerName: "computer-use",
    marketplaceName: "desktop-tools",
    tools: ["list_apps"],
    installation: {
      status: "installed",
      ok: true,
      message: "Computer Use plugin is installed and enabled.",
    },
    exposure: {
      status: "available",
      ok: true,
      message: "Computer Use MCP server computer-use exposes 1 tools.",
    },
    liveTest: {
      status: "passed",
      ok: true,
      attempted: true,
      attempts: 1,
      timeoutMs: 60_000,
      retried: false,
      repaired: false,
      message: "Computer Use live test passed.",
    },
    warnings: [],
    message: "Computer Use is ready.",
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
