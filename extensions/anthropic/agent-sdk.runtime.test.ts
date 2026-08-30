import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import type {
  SpawnOptions as ClaudeAgentSdkSpawnOptions,
  SpawnedProcess as ClaudeAgentSdkSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  CliBackendExecute,
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeClaudeAgentSdk } from "./agent-sdk.runtime.js";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const SESSION_ID = "a174e16f-b6e9-48da-ad5a-c437dfc2f9b4";
const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: SESSION_ID,
};
const liveCapabilities = new Set<CliBackendLiveSessionCapability>();

function createContext(
  overrides: Partial<CliBackendExecuteContext> = {},
): CliBackendExecuteContext {
  return {
    command: "/usr/local/bin/claude",
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
      "user",
      "--allowedTools",
      "mcp__openclaw__*",
      "--disallowedTools",
      "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor",
    ],
    cwd: "/tmp/openclaw-workspace",
    env: {
      HOME: "/tmp/claude-login-home",
      CLAUDE_CONFIG_DIR: "/tmp/claude-login-home/custom-config",
      PATH: "/usr/local/bin:/usr/bin",
      OPENCLAW_MCP_TOKEN: "test-grant-not-a-real-secret",
    },
    prompt: "Remember the launch code.",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "Follow the OpenClaw execution policy.",
    sessionId: SESSION_ID,
    useResume: false,
    timeoutMs: 30_000,
    executionMode: "agent",
    requestToolPermission: vi.fn(async () => ({
      behavior: "deny" as const,
      message: "OpenClaw denied this action.",
    })),
    requestUserInput: vi.fn(async () => ({
      status: "cancelled" as const,
      message: "OpenClaw cancelled this question.",
    })),
    ...overrides,
  };
}

function useSdkMessages(
  messages: ReadonlyArray<Record<string, unknown>> = [SUCCESS_RESULT],
  onQuery?: (options: Record<string, unknown>) => Promise<void>,
) {
  const close = vi.fn();
  queryMock.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
    const stream = (async function* () {
      await onQuery?.(options);
      yield* messages;
    })();
    return Object.assign(stream, { close });
  });
  return { close };
}

async function collect(context: CliBackendExecuteContext): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeAgentSdk(context)) {
    records.push(record);
  }
  return records;
}

function sdkOptions(): Record<string, unknown> {
  const call = queryMock.mock.calls[0]?.[0] as { options?: Record<string, unknown> } | undefined;
  expect(call?.options).toBeDefined();
  return call?.options ?? {};
}

type SdkNativeToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  details: { signal: AbortSignal; toolUseID: string; requestId?: string },
) => Promise<unknown>;

function sdkNativeTool(options: Record<string, unknown>): SdkNativeToolCallback {
  const callback = options.canUseTool as SdkNativeToolCallback;
  expect(callback).toEqual(expect.any(Function));
  return callback;
}

type SdkPreToolUseCallback = (
  input: {
    hook_event_name: "PreToolUse";
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
  },
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<unknown>;

function sdkPreToolUse(options: Record<string, unknown>): SdkPreToolUseCallback {
  const hooks = options.hooks as {
    PreToolUse?: Array<{ hooks?: SdkPreToolUseCallback[] }>;
  };
  const callback = hooks.PreToolUse?.[0]?.hooks?.[0];
  if (!callback) {
    throw new Error("Claude Agent SDK did not register its native permission hook.");
  }
  return callback;
}

type SdkPromptHook = (
  input: { hook_event_name: "UserPromptSubmit"; prompt: string },
  toolUseId: undefined,
  request: { signal: AbortSignal },
) => Promise<unknown>;

function sdkPromptHook(options = sdkOptions()): SdkPromptHook {
  const hooks = options.hooks as { UserPromptSubmit?: Array<{ hooks: SdkPromptHook[] }> };
  const callback = hooks.UserPromptSubmit?.[0]?.hooks[0];
  if (!callback) {
    throw new Error("Missing native private-context hook");
  }
  return callback;
}

function createLiveCapability(
  fingerprint = "matching-session-policy",
  state: { current?: CliBackendLiveSessionHandle } = {},
): CliBackendLiveSessionCapability {
  const capability: CliBackendLiveSessionCapability = {
    fingerprint,
    current: () => state.current,
    register: vi.fn((handle) => {
      state.current = handle;
    }),
    activate: vi.fn(),
    remove: vi.fn((handle) => {
      if (state.current === handle) {
        state.current = undefined;
      }
    }),
  };
  liveCapabilities.add(capability);
  return capability;
}

function useLiveSdkStreams() {
  const streams: PassThrough[] = [];
  const prompts: Array<Record<string, unknown>[]> = [];
  const closes: ReturnType<typeof vi.fn>[] = [];
  queryMock.mockImplementation(({ prompt }: { prompt: PassThrough }) => {
    const stream = new PassThrough({ objectMode: true });
    const messages: Record<string, unknown>[] = [];
    const close = vi.fn(() => stream.end());
    prompt.on("data", (message: Record<string, unknown>) => messages.push(message));
    streams.push(stream);
    prompts.push(messages);
    closes.push(close);
    return Object.assign(stream, { close });
  });
  return { streams, prompts, closes };
}

afterEach(async () => {
  for (const capability of liveCapabilities) {
    const session = capability.current();
    if (session) {
      session.close("restart");
      await session.waitForExit();
    }
  }
  liveCapabilities.clear();
  queryMock.mockReset();
  vi.restoreAllMocks();
});

describe("Anthropic Agent SDK runtime ownership", () => {
  it("pins SDK identity, keeps selected credentials private, and isolates side questions", () => {
    const backend = buildAnthropicCliBackend();
    const base = {
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "claude-cli",
      modelId: "claude-sonnet-4-6",
      executionMode: "agent" as const,
    };

    const credential = backend.prepareExecution?.({
      ...base,
      authCredential: { type: "token", token: "fixture-token" },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0]);
    const emptyCredential = backend.prepareExecution?.({
      ...base,
      authCredential: { type: "token", token: "   " },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0]);
    const sideQuestion = backend.prepareExecution?.({
      ...base,
      executionMode: "side-question",
      isolatedCompletionPrompt: "Return a JSON summary.",
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0]);

    expect(credential).toEqual(
      expect.objectContaining({
        env: {
          CLAUDE_AGENT_SDK_VERSION: "0.3.239",
          NoDefaultCurrentDirectoryInExePath: "1",
          CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
        },
        secretInput: expect.objectContaining({ fd: 3 }),
        execute: expect.any(Function),
      }),
    );
    expect(emptyCredential).toEqual(
      expect.objectContaining({
        env: { CLAUDE_AGENT_SDK_VERSION: "0.3.239", NoDefaultCurrentDirectoryInExePath: "1" },
        execute: expect.any(Function),
      }),
    );
    expect(emptyCredential).not.toHaveProperty("secretInput");
    expect(sideQuestion).not.toHaveProperty("execute");
  });

  it.each([
    { type: "token" as const, descriptor: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" },
    { type: "api_key" as const, descriptor: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR" },
  ])(
    "owns the selected $type process tree while keeping its descriptor private and zeroed",
    async ({ type, descriptor: descriptorEnv }) => {
      const backend = buildAnthropicCliBackend();
      const token = "selected-private-descriptor-fixture";
      const prepared = (await backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-workspace",
        provider: "claude-cli",
        modelId: "claude-sonnet-4-6",
        executionMode: "agent",
        authCredential: type === "token" ? { type, token } : { type, key: token },
      } as Parameters<NonNullable<typeof backend.prepareExecution>>[0])) as {
        env: Record<string, string>;
        secretInput: { fd: 3; createData: () => Buffer };
        execute: CliBackendExecute;
        cleanup?: () => Promise<void>;
      };
      let deliveredBuffer: Buffer | undefined;
      const originalCreateData = prepared.secretInput.createData;
      vi.spyOn(prepared.secretInput, "createData").mockImplementation(() => {
        deliveredBuffer = originalCreateData();
        return deliveredBuffer;
      });
      let descriptorOutput: { fd: number; digest: string } | undefined;
      useSdkMessages([SUCCESS_RESULT], async (options) => {
        const spawnProcess = options.spawnClaudeCodeProcess as
          | ((input: ClaudeAgentSdkSpawnOptions) => ClaudeAgentSdkSpawnedProcess)
          | undefined;
        if (!spawnProcess) {
          throw new Error("Selected Claude credentials require an SDK-private descriptor spawner.");
        }
        const args = [
          "-e",
          [
            `const data = require("node:fs").readFileSync(${JSON.stringify(process.platform === "win32" ? 3 : process.platform === "darwin" ? "/dev/fd/3" : "/proc/self/fd/3")});`,
            'if (require("node:fs").readFileSync(3).length !== 0) throw new Error("credential replayed");',
            'require("node:fs").writeSync(2, Buffer.alloc(1024 * 1024));',
            'const digest = require("node:crypto").createHash("sha256").update(data).digest("hex");',
            'const descendant = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});',
            `process.stdout.write(JSON.stringify({fd: Number(process.env[${JSON.stringify(descriptorEnv)}]), digest, descendantPid: descendant.pid}));`,
            "data.fill(0);",
            "setInterval(() => {}, 1000);",
          ].join(""),
        ];
        const env = { PATH: process.env.PATH, ...prepared.env };
        expect(JSON.stringify(args)).not.toContain(token);
        expect(Object.values(env)).not.toContain(token);
        const child = spawnProcess({
          command: process.execPath,
          args,
          cwd: process.cwd(),
          env,
          signal: new AbortController().signal,
        });
        const output = await new Promise<string>((resolve, reject) => {
          let stdout = "";
          child.stdout.on("data", (chunk: Buffer | string) => {
            stdout += chunk.toString();
            child.kill("SIGTERM");
          });
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            if (signal === "SIGTERM" || (process.platform === "win32" && code !== null)) {
              resolve(stdout);
            } else {
              reject(new Error(`Credential descriptor proof exited ${String(code)}.`));
            }
          });
        });
        const { descendantPid, ...descriptor } = JSON.parse(output) as {
          fd: number;
          digest: string;
          descendantPid: number;
        };
        descriptorOutput = descriptor;
        try {
          await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow());
        } finally {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {}
        }
      });

      const events: Record<string, unknown>[] = [];
      for await (const event of prepared.execute(
        createContext({ env: { ...createContext().env, ...prepared.env } }),
      )) {
        events.push(event);
      }

      expect(events).toContainEqual(SUCCESS_RESULT);
      expect(descriptorOutput).toEqual({
        fd: 3,
        digest: createHash("sha256").update(token).digest("hex"),
      });
      expect(deliveredBuffer).toBeDefined();
      expect(deliveredBuffer?.every((byte) => byte === 0)).toBe(true);
      await prepared.cleanup?.();
      expect(() => prepared.secretInput.createData()).toThrow("no longer available");
    },
  );

  it.each(
    [
      {
        name: "denies",
        decision: { behavior: "deny" as const, message: "OpenClaw denied restricted Bash." },
      },
      {
        name: "allows",
        decision: { behavior: "allow" as const, updatedInput: { command: "printf approved" } },
      },
    ].flatMap(({ name, decision }) => [
      { name: `${name} ambient`, credential: undefined, decision },
      {
        name: `${name} selected-credential`,
        credential: { type: "token" as const, token: "selected-profile-fixture" },
        decision,
      },
    ]),
  )(
    "$name restricted native Bash through the prepared SDK approval owner",
    async ({ credential, decision }) => {
      const backend = buildAnthropicCliBackend();
      const toolAvailability = { native: ["Bash"], openClaw: ["message"] };
      const prepareContext = {
        workspaceDir: "/tmp/openclaw-workspace",
        provider: "claude-cli",
        modelId: "claude-sonnet-4-6",
        executionMode: "agent" as const,
        toolAvailability,
      };
      const prepared = await backend.prepareExecution?.({
        ...prepareContext,
        ...(credential ? { authCredential: credential } : {}),
      } as Parameters<NonNullable<typeof backend.prepareExecution>>[0]);
      if (!prepared?.execute) {
        throw new Error("Restricted native Bash must use OpenClaw's SDK approval owner.");
      }

      const args = backend.resolveExecutionArgs?.({
        ...prepareContext,
        useResume: false,
        baseArgs: backend.config.args ?? [],
      });
      if (!args) {
        throw new Error("Anthropic did not prepare restricted native execution arguments.");
      }
      const requestToolPermission = vi.fn(async () => decision);
      const input = { command: "cat /tmp/openclaw-proof-private.txt" };
      let hookDecision: unknown;
      let callbackDecision: unknown;
      useSdkMessages([SUCCESS_RESULT], async (options) => {
        const signal = new AbortController().signal;
        hookDecision = await sdkPreToolUse(options)(
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: input,
            tool_use_id: "restricted-native-bash",
          },
          undefined,
          { signal },
        );
        callbackDecision = await sdkNativeTool(options)("Bash", input, {
          signal,
          toolUseID: "restricted-native-bash",
        });
      });

      const events: Record<string, unknown>[] = [];
      const executionContext = createContext({ args, requestToolPermission, toolAvailability });
      Object.assign(executionContext.env, prepared.env);
      for await (const event of prepared.execute(executionContext)) {
        events.push(event);
      }

      expect(events).toContainEqual(SUCCESS_RESULT);
      expect(sdkOptions()).toEqual(
        expect.objectContaining({
          tools: ["Bash"],
          allowedTools: ["mcp__openclaw__message"],
          settingSources: [],
          permissionMode: "default",
        }),
      );
      if (credential) {
        expect(sdkOptions().spawnClaudeCodeProcess).toEqual(expect.any(Function));
        expect(sdkOptions().env).toEqual(
          expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" }),
        );
        expect(JSON.stringify(sdkOptions().env)).not.toContain(credential.token);
      }
      expect(hookDecision).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.behavior,
          ...(decision.behavior === "allow"
            ? { updatedInput: decision.updatedInput }
            : { permissionDecisionReason: decision.message }),
        },
      });
      expect(callbackDecision).toEqual(decision);
      expect(requestToolPermission).toHaveBeenCalledTimes(2);
      expect(requestToolPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "Bash",
          toolInput: input,
          toolCallId: "restricted-native-bash",
        }),
      );
    },
  );

  it("runs the installed authenticated executable with the exact host-prepared environment", async () => {
    const result = { ...SUCCESS_RESULT, result: "Launch code remembered." };
    useSdkMessages([result]);
    const context = createContext();

    expect(await collect(context)).toContainEqual(result);

    expect(queryMock).toHaveBeenCalledOnce();
    expect(sdkOptions()).toEqual(
      expect.objectContaining({
        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
        cwd: "/tmp/openclaw-workspace",
        env: context.env,
        model: "claude-sonnet-4-6",
        includePartialMessages: true,
        settingSources: ["user"],
      }),
    );
    expect(sdkOptions().env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(sdkOptions().env).not.toHaveProperty("ANTHROPIC_OAUTH_TOKEN");
    expect(sdkOptions().env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");

    expect(queryMock.mock.calls[0]?.[0]?.prompt).toBe("Remember the launch code.");
  });

  it.each([
    {
      name: "the caller's cancellation reason",
      reason: new Error("OpenClaw cancelled the run before SDK startup."),
    },
    { name: "the default AbortError", reason: undefined },
  ])("preserves $name without starting an already-aborted SDK run", async ({ reason }) => {
    const controller = new AbortController();
    controller.abort(reason);

    await expect(collect(createContext({ abortSignal: controller.signal }))).rejects.toBe(
      controller.signal.reason,
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects cancellation that races the SDK's asynchronous module load", async () => {
    const controller = new AbortController();
    const reason = new Error("OpenClaw cancelled the run while the SDK was loading.");
    const running = collect(createContext({ abortSignal: controller.signal }));

    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it.each([undefined, { prependContext: "private prefix", appendContext: "private suffix" }])(
    "keeps one-shot user input separate from private prompt context %j",
    async (promptContext) => {
      let hookResult: unknown;
      const context = createContext({ promptContext });
      useSdkMessages([SUCCESS_RESULT], async (options) => {
        hookResult = await sdkPromptHook(options)(
          { hook_event_name: "UserPromptSubmit", prompt: context.prompt },
          undefined,
          { signal: new AbortController().signal },
        );
      });
      await collect(context);
      expect(queryMock.mock.calls[0]?.[0]?.prompt).toBe(context.prompt);
      expect(hookResult).toEqual(
        promptContext
          ? {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: "private prefix\n\nprivate suffix",
              },
            }
          : {},
      );
      await expect(
        sdkPromptHook()(
          { hook_event_name: "UserPromptSubmit", prompt: context.prompt },
          undefined,
          { signal: new AbortController().signal },
        ),
      ).resolves.toEqual({});
    },
  );

  it("preserves native session identity across fresh and resumed turns", async () => {
    useSdkMessages();

    await collect(createContext());
    expect(sdkOptions()).toEqual(expect.objectContaining({ sessionId: SESSION_ID }));
    expect(sdkOptions()).not.toHaveProperty("resume");

    queryMock.mockClear();
    await collect(createContext({ useResume: true }));
    expect(sdkOptions()).toEqual(expect.objectContaining({ resume: SESSION_ID }));
    expect(sdkOptions()).not.toHaveProperty("sessionId");
  });

  it("preserves cache, effort, and checkpoint-fork controls through SDK options", async () => {
    useSdkMessages();

    await collect(
      createContext({
        args: [
          "-p",
          "--cache-system-prompt",
          "--effort",
          "max",
          "--fork-session",
          "--resume-session-at",
          "assistant-before-stall",
        ],
        useResume: true,
      }),
    );

    expect(sdkOptions()).toEqual(
      expect.objectContaining({
        resume: SESSION_ID,
        effort: "max",
        forkSession: true,
        resumeSessionAt: "assistant-before-stall",
        extraArgs: { "cache-system-prompt": null },
      }),
    );
  });

  it("reuses one official SDK query and Claude process across compatible agent turns", async () => {
    const live = useLiveSdkStreams();
    const capability = createLiveCapability();
    const activate = vi.spyOn(capability, "activate");
    const first = collect(
      createContext({
        prompt: "Remember orange.",
        promptContext: { prependContext: "private session note" },
        liveSession: capability,
      }),
    );
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    const hook = sdkPromptHook();
    const hookRequest = { signal: new AbortController().signal };
    for (const prompt of ["Remember orange.", "Rewritten orange prompt.", "Remember orange."]) {
      await expect(
        hook({ hook_event_name: "UserPromptSubmit", prompt }, undefined, hookRequest),
      ).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "private session note",
        },
      });
    }
    live.streams[0]?.write({ ...SUCCESS_RESULT, result: "Remembered orange." });

    await expect(first).resolves.toContainEqual(
      expect.objectContaining({ result: "Remembered orange." }),
    );
    const firstHandle = capability.current();
    expect(firstHandle?.isIdle()).toBe(true);
    await expect(
      hook(
        { hook_event_name: "UserPromptSubmit", prompt: "Remember orange." },
        undefined,
        hookRequest,
      ),
    ).resolves.toEqual({});

    const second = collect(
      createContext({
        prompt: "Which color did I mention?",
        useResume: true,
        liveSession: capability,
      }),
    );
    await vi.waitFor(() => expect(live.prompts[0]).toHaveLength(2));
    await expect(
      hook(
        { hook_event_name: "UserPromptSubmit", prompt: "Which color did I mention?" },
        undefined,
        hookRequest,
      ),
    ).resolves.toEqual({});
    live.streams[0]?.write({ ...SUCCESS_RESULT, result: "Orange." });

    await expect(second).resolves.toContainEqual(expect.objectContaining({ result: "Orange." }));
    expect(queryMock).toHaveBeenCalledOnce();
    expect(capability.current()).toBe(firstHandle);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(live.prompts[0]?.map((message) => message.message)).toEqual([
      { role: "user", content: "Remember orange." },
      { role: "user", content: "Which color did I mention?" },
    ]);
  });

  it("keeps a terminal error turn's warm query reusable for the next turn", async () => {
    const live = useLiveSdkStreams();
    const capability = createLiveCapability();
    const first = collect(createContext({ prompt: "Attempt the task.", liveSession: capability }));
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    live.streams[0]?.write({
      ...SUCCESS_RESULT,
      subtype: "error_during_execution",
      is_error: true,
      result: "The native tool failed.",
    });

    await expect(first).resolves.toContainEqual(
      expect.objectContaining({ is_error: true, result: "The native tool failed." }),
    );
    const firstHandle = capability.current();
    expect(firstHandle?.isIdle()).toBe(true);

    const second = collect(
      createContext({
        prompt: "Continue without repeating the failed action.",
        useResume: true,
        liveSession: capability,
      }),
    );
    await vi.waitFor(() => expect(live.prompts[0]).toHaveLength(2));
    live.streams[0]?.write({ ...SUCCESS_RESULT, result: "continued" });

    await expect(second).resolves.toContainEqual(expect.objectContaining({ result: "continued" }));
    expect(queryMock).toHaveBeenCalledOnce();
    expect(capability.current()).toBe(firstHandle);
  });

  it("restarts the warm SDK query when its system prompt or execution fingerprint changes", async () => {
    const live = useLiveSdkStreams();
    const shared: { current?: CliBackendLiveSessionHandle } = {};
    const originalCapability = createLiveCapability("original-system-prompt", shared);
    const original = collect(createContext({ liveSession: originalCapability }));
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    live.streams[0]?.write(SUCCESS_RESULT);
    await original;
    const originalSession = originalCapability.current();

    const changedCapability = createLiveCapability("changed-system-prompt", shared);
    const changed = collect(
      createContext({
        systemPrompt: "A changed authoritative OpenClaw system prompt.",
        useResume: true,
        liveSession: changedCapability,
      }),
    );
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledTimes(2));
    live.streams[1]?.write({ ...SUCCESS_RESULT, result: "new system prompt" });

    await expect(changed).resolves.toContainEqual(
      expect.objectContaining({ result: "new system prompt" }),
    );
    expect(live.closes[0]).toHaveBeenCalledOnce();
    expect(changedCapability.current()?.generation).not.toBe(originalSession?.generation);
    expect(queryMock.mock.calls[1]?.[0]?.options).toEqual(
      expect.objectContaining({
        resume: SESSION_ID,
        systemPrompt: expect.objectContaining({
          append: "A changed authoritative OpenClaw system prompt.",
        }),
      }),
    );
  });

  it("refuses to start a live process when its owner will not activate the admitted turn", async () => {
    const capability = createLiveCapability();
    const reason = new Error("OpenClaw rejected a stale execution owner.");
    vi.spyOn(capability, "activate").mockImplementation(() => {
      throw reason;
    });
    const remove = vi.spyOn(capability, "remove");

    await expect(collect(createContext({ liveSession: capability }))).rejects.toBe(reason);

    expect(queryMock).not.toHaveBeenCalled();
    expect(capability.current()).toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("closes the warm process and fences retained permissions when its active turn is aborted", async () => {
    const live = useLiveSdkStreams();
    const capability = createLiveCapability();
    const controller = new AbortController();
    const running = collect(
      createContext({ abortSignal: controller.signal, liveSession: capability }),
    );
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    const canUseTool = sdkNativeTool(sdkOptions());
    const reason = new Error("OpenClaw cancelled the active warm turn.");

    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(live.closes[0]).toHaveBeenCalledOnce();
    expect(capability.current()).toBeUndefined();
    await expect(
      canUseTool(
        "Bash",
        { command: "echo stale" },
        {
          signal: new AbortController().signal,
          toolUseID: "cancelled-native-tool",
        },
      ),
    ).resolves.toEqual({ behavior: "deny", message: "The OpenClaw run is no longer active." });

    const resumed = collect(
      createContext({
        prompt: "Resume after the interrupted turn.",
        useResume: true,
        liveSession: capability,
      }),
    );
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledTimes(2));
    live.streams[1]?.write({ ...SUCCESS_RESULT, result: "resumed" });

    await expect(resumed).resolves.toContainEqual(expect.objectContaining({ result: "resumed" }));
    expect(queryMock.mock.calls[1]?.[0]?.options).toEqual(
      expect.objectContaining({ resume: SESSION_ID }),
    );
  });

  it("rebinds a persistent SDK approval callback to only the active admitted turn", async () => {
    const live = useLiveSdkStreams();
    const capability = createLiveCapability();
    const firstApproval = vi.fn(async () => ({
      behavior: "allow" as const,
      updatedInput: { command: "echo first" },
    }));
    const secondApproval = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "The second admitted turn denied native execution.",
    }));
    const first = collect(
      createContext({ requestToolPermission: firstApproval, liveSession: capability }),
    );
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    const canUseTool = sdkNativeTool(sdkOptions());
    const firstRequest = {
      signal: new AbortController().signal,
      toolUseID: "native-turn-first",
    };

    await expect(canUseTool("Bash", { command: "echo first" }, firstRequest)).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "echo first" },
    });
    live.streams[0]?.write(SUCCESS_RESULT);
    await first;

    await expect(canUseTool("Bash", { command: "echo stale" }, firstRequest)).resolves.toEqual({
      behavior: "deny",
      message: "The OpenClaw run is no longer active.",
    });

    const second = collect(
      createContext({
        prompt: "second",
        requestToolPermission: secondApproval,
        liveSession: capability,
      }),
    );
    await vi.waitFor(() => expect(live.prompts[0]).toHaveLength(2));
    await expect(
      canUseTool(
        "Bash",
        { command: "echo second" },
        {
          signal: new AbortController().signal,
          toolUseID: "native-turn-second",
        },
      ),
    ).resolves.toEqual({
      behavior: "deny",
      message: "The second admitted turn denied native execution.",
    });
    live.streams[0]?.write(SUCCESS_RESULT);
    await second;

    expect(firstApproval).toHaveBeenCalledOnce();
    expect(secondApproval).toHaveBeenCalledOnce();
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it("rejects an approval that resolves after its exact admitted turn has already ended", async () => {
    const live = useLiveSdkStreams();
    const capability = createLiveCapability();
    let resolveApproval:
      | ((decision: { behavior: "allow"; updatedInput: Record<string, unknown> }) => void)
      | undefined;
    const requestToolPermission = vi.fn(
      () =>
        new Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const running = collect(createContext({ requestToolPermission, liveSession: capability }));
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    const approval = sdkNativeTool(sdkOptions())(
      "Bash",
      { command: "echo late" },
      { signal: new AbortController().signal, toolUseID: "late-native-approval" },
    );
    await vi.waitFor(() => expect(requestToolPermission).toHaveBeenCalledOnce());

    live.streams[0]?.write(SUCCESS_RESULT);
    await running;
    resolveApproval?.({ behavior: "allow", updatedInput: { command: "echo late" } });

    await expect(approval).resolves.toEqual({
      behavior: "deny",
      message: "The OpenClaw run is no longer active.",
    });
  });

  it("holds provisional synthetic results until the real background-agent answer arrives", async () => {
    const live = useLiveSdkStreams();
    const capability = createLiveCapability();
    const observed: Record<string, unknown>[] = [];
    let settled = false;
    const result = (async () => {
      for await (const event of executeClaudeAgentSdk(createContext({ liveSession: capability }))) {
        observed.push(event);
      }
      settled = true;
      return observed;
    })();
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    const stream = live.streams[0];
    expect(stream).toBeDefined();

    stream?.write({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "background-agent", task_type: "local_agent" }],
    });
    stream?.write({
      type: "assistant",
      message: {
        model: "<synthetic>",
        content: [{ type: "text", text: "No response requested." }],
      },
    });
    stream?.write({ ...SUCCESS_RESULT, result: "" });
    await vi.waitFor(() => expect(observed).toHaveLength(3));
    expect(settled).toBe(false);

    stream?.write({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    stream?.write({ ...SUCCESS_RESULT, result: "background answer" });

    await expect(result).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "result", result: "background answer" }),
      ]),
    );
    expect(observed.at(-1)).toEqual(expect.objectContaining({ result: "background answer" }));
    expect(live.closes[0]).not.toHaveBeenCalled();
  });

  it("keeps restricted native tools and MCP grants inside the exact host-owned surface", async () => {
    useSdkMessages();
    const context = createContext({
      args: [
        "-p",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        "/tmp/openclaw-restricted-mcp.json",
        "--tools",
        "",
        "--allowedTools",
        "mcp__openclaw__message",
        "--disallowedTools",
        "Bash",
        "Edit",
        "Write",
      ],
      toolAvailability: {
        native: [],
        openClaw: ["message"],
      },
    });

    await collect(context);

    expect(sdkOptions()).toEqual(
      expect.objectContaining({
        tools: [],
        allowedTools: ["mcp__openclaw__message"],
        disallowedTools: ["Bash", "Edit", "Write"],
        settingSources: [],
        strictMcpConfig: true,
      }),
    );
    expect(sdkOptions().allowedTools).not.toContain("Bash");
    expect(sdkOptions()).not.toHaveProperty("mcpServers");
    expect(sdkOptions().extraArgs).toEqual(
      expect.objectContaining({ "mcp-config": "/tmp/openclaw-restricted-mcp.json" }),
    );
    expect(
      JSON.stringify({ mcpServers: sdkOptions().mcpServers, extraArgs: sdkOptions().extraArgs }),
    ).not.toContain(context.env.OPENCLAW_MCP_TOKEN);
  });

  it("preserves variadic directories, tools, and managed plugin MCP isolation", async () => {
    useSdkMessages();

    await collect(
      createContext({
        args: [
          "-p",
          "--add-dir",
          "/tmp/a",
          "/tmp/b",
          "--add-dir=/tmp/c",
          "--tools",
          "Read",
          "Grep",
          "--plugin-dir",
          "/tmp/openclaw-native-skills",
          "--plugin-dir-no-mcp",
          "/tmp/openclaw-isolated-skills",
        ],
      }),
    );

    expect(sdkOptions().plugins).toEqual([
      { type: "local", path: "/tmp/openclaw-native-skills" },
      { type: "local", path: "/tmp/openclaw-isolated-skills", skipMcpDiscovery: true },
    ]);
    expect(sdkOptions().additionalDirectories).toEqual(["/tmp/a", "/tmp/b", "/tmp/c"]);
    expect(sdkOptions().tools).toEqual(["Read", "Grep"]);
  });

  it.each([
    {
      name: "unsafe project settings",
      args: ["-p", "--setting-sources", "project"],
      error: "Claude Agent SDK settings must be limited to user settings.",
    },
    {
      name: "a missing private MCP configuration path",
      args: ["-p", "--mcp-config"],
      error: "Claude Agent SDK cannot preserve --mcp-config without its value",
    },
  ])("rejects $name before starting the Claude subprocess", async ({ args, error }) => {
    await expect(collect(createContext({ args }))).rejects.toThrow(error);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("expands wildcard MCP grants into only the exact tools admitted by OpenClaw", async () => {
    useSdkMessages();

    await collect(
      createContext({
        args: ["-p", "--allowedTools", "Bash", "mcp__openclaw__*", "Edit"],
        toolAvailability: {
          native: [],
          openClaw: ["message", "memory_search"],
        },
      }),
    );

    expect(sdkOptions()).toEqual(
      expect.objectContaining({
        tools: [],
        allowedTools: ["mcp__openclaw__message", "mcp__openclaw__memory_search"],
      }),
    );
    expect(sdkOptions().allowedTools).not.toContain("mcp__openclaw__*");
    expect(sdkOptions().allowedTools).not.toContain("Bash");
    expect(sdkOptions().allowedTools).not.toContain("Edit");
  });

  it.each([429, 529])(
    "yields an HTTP %i error-marked success before surfacing the SDK's later exit error",
    async (apiErrorStatus) => {
      const result = {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: apiErrorStatus,
        result: "Claude subscription returned an upstream error.",
        session_id: SESSION_ID,
      };
      const exitError = new Error("Claude Code returned an error result.");
      queryMock.mockImplementation(() =>
        Object.assign(
          (async function* () {
            yield result;
            throw exitError;
          })(),
          { close: vi.fn() },
        ),
      );
      const observed: Record<string, unknown>[] = [];
      const running = (async () => {
        for await (const event of executeClaudeAgentSdk(createContext())) {
          observed.push(event);
        }
      })();

      await expect(running).rejects.toBe(exitError);
      expect(observed).toContainEqual(result);
    },
  );

  it("fails closed when the official SDK exits without a terminal result", async () => {
    useSdkMessages([]);

    await expect(collect(createContext())).rejects.toThrow(
      "Claude Agent SDK exited without a terminal result.",
    );
  });
});
