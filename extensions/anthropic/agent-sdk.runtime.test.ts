import { PassThrough } from "node:stream";
import type {
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

function createLiveCapability(
  fingerprint = "matching-session-policy",
  state: { current?: CliBackendLiveSessionHandle } = {},
): CliBackendLiveSessionCapability {
  const capability: CliBackendLiveSessionCapability = {
    ownerKey: "claude-cli:authenticated-owner",
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
  it("keeps explicit credentials and isolated completions on their existing protected transports", () => {
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
    const sideQuestion = backend.prepareExecution?.({
      ...base,
      executionMode: "side-question",
      isolatedCompletionPrompt: "Return a JSON summary.",
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0]);

    expect(credential).toEqual(
      expect.objectContaining({
        env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" },
        secretInput: expect.objectContaining({ fd: 3 }),
      }),
    );
    expect(credential).not.toHaveProperty("execute");
    expect(sideQuestion).not.toHaveProperty("execute");
  });

  it("excludes restricted native-capable turns while admitting MCP-only SDK runs", () => {
    const backend = buildAnthropicCliBackend();
    const base = {
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "claude-cli",
      modelId: "claude-sonnet-4-6",
      executionMode: "agent" as const,
    };

    const nativeCapable = backend.prepareExecution?.({
      ...base,
      toolAvailability: {
        native: ["Bash"],
        openClaw: ["message"],
        mcp: ["mcp__openclaw__message"],
      },
    });
    const gatewayToolsOnly = backend.prepareExecution?.({
      ...base,
      toolAvailability: {
        native: [],
        openClaw: ["message"],
        mcp: ["mcp__openclaw__message"],
      },
    });

    expect(nativeCapable).not.toEqual(expect.objectContaining({ execute: expect.any(Function) }));
    expect(gatewayToolsOnly).toEqual(expect.objectContaining({ execute: expect.any(Function) }));
  });

  it("runs the installed authenticated executable with the exact host-prepared environment", async () => {
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Launch code remembered.",
      session_id: SESSION_ID,
    };
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

    const prompt = queryMock.mock.calls[0]?.[0]?.prompt as AsyncIterable<unknown>;
    const messages: unknown[] = [];
    for await (const message of prompt) {
      messages.push(message);
    }
    expect(messages).toEqual([
      {
        type: "user",
        message: { role: "user", content: "Remember the launch code." },
        parent_tool_use_id: null,
        uuid: expect.any(String),
        session_id: SESSION_ID,
      },
    ]);
  });

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

  it("reuses one official SDK query and Claude process across compatible agent turns", async () => {
    const live = useLiveSdkStreams();
    const capability = createLiveCapability();
    const first = collect(createContext({ prompt: "Remember orange.", liveSession: capability }));
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    live.streams[0]?.write({ ...SUCCESS_RESULT, result: "Remembered orange." });

    await expect(first).resolves.toContainEqual(
      expect.objectContaining({ result: "Remembered orange." }),
    );
    const firstHandle = capability.current();
    expect(firstHandle?.isIdle()).toBe(true);

    const second = collect(
      createContext({
        prompt: "Which color did I mention?",
        useResume: true,
        liveSession: capability,
      }),
    );
    await vi.waitFor(() => expect(live.prompts[0]).toHaveLength(2));
    live.streams[0]?.write({ ...SUCCESS_RESULT, result: "Orange." });

    await expect(second).resolves.toContainEqual(expect.objectContaining({ result: "Orange." }));
    expect(queryMock).toHaveBeenCalledOnce();
    expect(capability.current()).toBe(firstHandle);
    expect(capability.activate).toHaveBeenCalledTimes(2);
    expect(live.prompts[0]?.map((message) => message.message)).toEqual([
      { role: "user", content: "Remember orange." },
      { role: "user", content: "Which color did I mention?" },
    ]);
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
    const canUseTool = sdkOptions().canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      details: { signal: AbortSignal; toolUseID: string },
    ) => Promise<unknown>;
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
        "Bash,Edit,Write",
      ],
      toolAvailability: {
        native: [],
        openClaw: ["message"],
        mcp: ["mcp__openclaw__message"],
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

  it("expands wildcard MCP grants into only the exact tools admitted by OpenClaw", async () => {
    useSdkMessages();

    await collect(
      createContext({
        args: ["-p", "--allowedTools", "mcp__openclaw__*"],
        toolAvailability: {
          native: [],
          openClaw: ["message", "memory_search"],
          mcp: ["mcp__openclaw__message", "mcp__openclaw__memory_search"],
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
  });

  it("enforces native tool policy before user settings can shadow the permission callback", async () => {
    const requestToolPermission = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "The session policy denied native execution.",
    }));
    let nativeDecision: unknown;
    let gatewayDecision: unknown;
    useSdkMessages([SUCCESS_RESULT], async (options) => {
      const hooks = options.hooks as {
        PreToolUse?: Array<{
          hooks?: Array<
            (
              input: {
                hook_event_name: "PreToolUse";
                tool_name: string;
                tool_input: Record<string, unknown>;
                tool_use_id: string;
              },
              toolUseId: string | undefined,
              options: { signal: AbortSignal },
            ) => Promise<unknown>
          >;
        }>;
      };
      const hook = hooks.PreToolUse?.[0]?.hooks?.[0];
      expect(hook).toEqual(expect.any(Function));
      const signal = new AbortController().signal;

      nativeDecision = await hook?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "cat private.txt" },
          tool_use_id: "native-tool-shadowed",
        },
        "native-tool-shadowed",
        { signal },
      );
      gatewayDecision = await hook?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__openclaw__message",
          tool_input: { action: "send" },
          tool_use_id: "gateway-tool-owned",
        },
        "gateway-tool-owned",
        { signal },
      );
    });

    await collect(createContext({ requestToolPermission }));

    expect(nativeDecision).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "The session policy denied native execution.",
      },
    });
    expect(gatewayDecision).toEqual({ continue: true });
    expect(requestToolPermission).toHaveBeenCalledOnce();
    expect(requestToolPermission).toHaveBeenCalledWith({
      toolName: "Bash",
      toolInput: { command: "cat private.txt" },
      toolCallId: "native-tool-shadowed",
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("keeps bypass-shaped backend arguments behind the host permission callback", async () => {
    const requestToolPermission = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "The session policy denied native execution.",
    }));
    let decision: unknown;
    useSdkMessages([SUCCESS_RESULT], async (options) => {
      const canUseTool = options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        details: { signal: AbortSignal; toolUseID: string; requestId: string },
      ) => Promise<unknown>;
      decision = await canUseTool(
        "Bash",
        { command: "cat private.txt" },
        {
          signal: new AbortController().signal,
          toolUseID: "native-tool-bypass",
          requestId: "approval-bypass",
        },
      );
    });

    await collect(
      createContext({
        args: ["-p", "--permission-mode", "bypassPermissions"],
        requestToolPermission,
      }),
    );

    expect(sdkOptions().permissionMode).toBe("default");
    expect(sdkOptions()).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(decision).toEqual({
      behavior: "deny",
      message: "The session policy denied native execution.",
    });
    expect(requestToolPermission).toHaveBeenCalledOnce();
  });

  it("forwards native tool decisions and exact inputs to the admitted OpenClaw host", async () => {
    const requestToolPermission = vi.fn(async () => ({
      behavior: "allow" as const,
      updatedInput: { command: "echo approved" },
    }));
    const signal = new AbortController().signal;
    let decision: unknown;
    useSdkMessages([SUCCESS_RESULT], async (options) => {
      const canUseTool = options.canUseTool as
        | ((
            toolName: string,
            input: Record<string, unknown>,
            details: { signal: AbortSignal; toolUseID: string; requestId: string },
          ) => Promise<unknown>)
        | undefined;
      expect(canUseTool).toEqual(expect.any(Function));
      decision = await canUseTool?.(
        "Bash",
        { command: "echo approved" },
        { signal, toolUseID: "native-tool-1", requestId: "approval-1" },
      );
    });

    await collect(createContext({ requestToolPermission }));

    expect(decision).toEqual({ behavior: "allow", updatedInput: { command: "echo approved" } });
    expect(requestToolPermission).toHaveBeenCalledWith({
      toolName: "Bash",
      toolInput: { command: "echo approved" },
      toolCallId: "native-tool-1",
      abortSignal: signal,
    });
  });

  it("preserves denied host decisions instead of granting SDK tools", async () => {
    const requestToolPermission = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "OpenClaw exec policy denied this action.",
    }));
    let decision: unknown;
    useSdkMessages([SUCCESS_RESULT], async (options) => {
      const canUseTool = options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        details: { signal: AbortSignal; toolUseID: string; requestId: string },
      ) => Promise<unknown>;
      decision = await canUseTool(
        "Bash",
        { command: "cat private.txt" },
        {
          signal: new AbortController().signal,
          toolUseID: "native-tool-2",
          requestId: "approval-2",
        },
      );
    });

    await collect(createContext({ requestToolPermission }));

    expect(decision).toEqual({
      behavior: "deny",
      message: "OpenClaw exec policy denied this action.",
    });
  });

  it("fails closed when the host approval owner cannot authorize a native tool", async () => {
    const requestToolPermission = vi.fn(async () => {
      throw new Error("The Gateway approval owner is unavailable.");
    });
    let decision: unknown;
    useSdkMessages([SUCCESS_RESULT], async (options) => {
      const canUseTool = options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        details: { signal: AbortSignal; toolUseID: string; requestId: string },
      ) => Promise<unknown>;
      decision = await canUseTool(
        "Bash",
        { command: "ls" },
        {
          signal: new AbortController().signal,
          toolUseID: "native-tool-3",
          requestId: "approval-3",
        },
      );
    });

    await collect(createContext({ requestToolPermission }));

    expect(decision).toEqual({
      behavior: "deny",
      message: "OpenClaw could not authorize this tool call.",
    });
  });

  it("rejects retained SDK permission callbacks after their run closes", async () => {
    let canUseTool:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          details: { signal: AbortSignal; toolUseID: string; requestId: string },
        ) => Promise<unknown>)
      | undefined;
    useSdkMessages([SUCCESS_RESULT], async (options) => {
      canUseTool = options.canUseTool as typeof canUseTool;
    });
    const requestToolPermission = vi.fn(async () => ({
      behavior: "allow" as const,
      updatedInput: { command: "echo stale" },
    }));

    await collect(createContext({ requestToolPermission }));

    await expect(
      canUseTool?.(
        "Bash",
        { command: "echo stale" },
        {
          signal: new AbortController().signal,
          toolUseID: "native-tool-stale",
          requestId: "approval-stale",
        },
      ),
    ).resolves.toEqual({
      behavior: "deny",
      message: "The OpenClaw run is no longer active.",
    });
    expect(requestToolPermission).not.toHaveBeenCalled();
  });

  it("preserves error-marked success results for the host error and failover owners", async () => {
    const result = {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "Claude subscription rate limit reached.",
      session_id: SESSION_ID,
    };
    useSdkMessages([result]);

    expect(await collect(createContext())).toContainEqual(result);
  });

  it("fails closed when the official SDK exits without a terminal result", async () => {
    useSdkMessages([]);

    await expect(collect(createContext())).rejects.toThrow(
      "Claude Agent SDK exited without a terminal result.",
    );
  });
});
