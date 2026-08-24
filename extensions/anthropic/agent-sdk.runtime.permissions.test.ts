import type { PermissionResult as ClaudeAgentSdkPermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeClaudeAgentSdk } from "./agent-sdk.runtime.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: "a174e16f-b6e9-48da-ad5a-c437dfc2f9b4",
};

function createContext(
  overrides: Partial<CliBackendExecuteContext> = {},
): CliBackendExecuteContext {
  return {
    command: "/usr/local/bin/claude",
    args: ["-p"],
    cwd: "/tmp/openclaw-workspace",
    env: { PATH: "/usr/local/bin:/usr/bin" },
    prompt: "Remember the launch code.",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "Follow the OpenClaw execution policy.",
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
  queryMock.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
    const stream = (async function* () {
      await onQuery?.(options);
      yield* messages;
    })();
    return Object.assign(stream, { close: vi.fn() });
  });
}

async function collect(context: CliBackendExecuteContext): Promise<void> {
  for await (const record of executeClaudeAgentSdk(context)) {
    void record;
  }
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
) => Promise<ClaudeAgentSdkPermissionResult>;

function sdkNativeTool(options: Record<string, unknown>): SdkNativeToolCallback {
  return options.canUseTool as SdkNativeToolCallback;
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
  const hooks = options.hooks as { PreToolUse?: Array<{ hooks?: SdkPreToolUseCallback[] }> };
  const callback = hooks.PreToolUse?.[0]?.hooks?.[0];
  if (!callback) {
    throw new Error("Claude Agent SDK did not register its native permission hook.");
  }
  return callback;
}

afterEach(() => {
  queryMock.mockReset();
  vi.restoreAllMocks();
});

describe("Anthropic Agent SDK native permission bridge", () => {
  it("routes AskUserQuestion through structured input instead of tool approval", async () => {
    const requestToolPermission = vi.fn();
    const requestUserInput = vi.fn(async () => ({
      status: "answered" as const,
      answers: { question_1: ["Shared flow"] },
    }));
    let decision: unknown;
    useSdkMessages([SUCCESS_RESULT], async (options) => {
      decision = await sdkNativeTool(options)(
        "AskUserQuestion",
        {
          questions: [
            {
              header: "Approach",
              question: "Which implementation should Claude use?",
              options: [
                { label: "Shared flow", description: "Use OpenClaw's existing question flow." },
                { label: "Claude-only", description: "Build a provider-specific path." },
              ],
              multiSelect: false,
            },
          ],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "ask-user-question",
        },
      );
    });

    await collect(createContext({ requestToolPermission, requestUserInput }));

    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: expect.any(Array),
        answers: { "Which implementation should Claude use?": "Shared flow" },
      },
    });
    expect(requestToolPermission).not.toHaveBeenCalled();
    expect(requestUserInput).toHaveBeenCalledOnce();
  });

  it("enforces native tool policy before user settings can shadow the permission callback", async () => {
    const requestToolPermission = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "The session policy denied native execution.",
    }));
    let nativeDecision: unknown;
    let gatewayDecision: unknown;
    let malformedDecision: unknown;
    useSdkMessages([SUCCESS_RESULT], async (options) => {
      const hook = sdkPreToolUse(options);
      const signal = new AbortController().signal;

      nativeDecision = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "cat private.txt" },
          tool_use_id: "native-tool-shadowed",
        },
        "native-tool-shadowed",
        { signal },
      );
      gatewayDecision = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__openclaw__message",
          tool_input: { action: "send" },
          tool_use_id: "gateway-tool-owned",
        },
        "gateway-tool-owned",
        { signal },
      );
      malformedDecision = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: "not-an-object",
          tool_use_id: "malformed-native-tool",
        },
        "malformed-native-tool",
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
    expect(malformedDecision).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "OpenClaw rejected malformed native tool input.",
      },
    });
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
      decision = await sdkNativeTool(options)(
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

  it.each([
    {
      name: "forwards allowed decisions and exact host inputs",
      resolve: async () => ({
        behavior: "allow" as const,
        updatedInput: { command: "echo approved" },
      }),
      expected: { behavior: "allow", updatedInput: { command: "echo approved" } },
    },
    {
      name: "preserves a denied host decision",
      resolve: async () => ({
        behavior: "deny" as const,
        message: "OpenClaw exec policy denied this action.",
      }),
      expected: { behavior: "deny", message: "OpenClaw exec policy denied this action." },
    },
    {
      name: "fails closed when the host approval owner is unavailable",
      resolve: async () => {
        throw new Error("The Gateway approval owner is unavailable.");
      },
      expected: { behavior: "deny", message: "OpenClaw could not authorize this tool call." },
    },
  ])("$name and fences the retained callback after closure", async ({ resolve, expected }) => {
    const requestToolPermission = vi.fn(resolve);
    const signal = new AbortController().signal;
    const input = { command: "echo approved" };
    let decision: unknown;
    let callback: SdkNativeToolCallback | undefined;
    useSdkMessages([SUCCESS_RESULT], async (options) => {
      callback = sdkNativeTool(options);
      decision = await callback("Bash", input, {
        signal,
        toolUseID: "native-tool-1",
        requestId: "approval-1",
      });
    });

    await collect(createContext({ requestToolPermission }));

    expect(decision).toEqual(expected);
    expect(requestToolPermission).toHaveBeenCalledWith({
      toolName: "Bash",
      toolInput: input,
      toolCallId: "native-tool-1",
      abortSignal: signal,
    });
    await expect(
      callback?.(
        "Bash",
        { command: "echo stale" },
        {
          signal,
          toolUseID: "native-tool-stale",
        },
      ),
    ).resolves.toEqual({
      behavior: "deny",
      message: "The OpenClaw run is no longer active.",
    });
    expect(requestToolPermission).toHaveBeenCalledOnce();
  });
});
