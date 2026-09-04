import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeClaudeAgentSdk } from "./agent-sdk.runtime.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

const SYSTEM_PROMPT = "Follow the OpenClaw execution policy.";
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
    systemPrompt: SYSTEM_PROMPT,
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

function useSdkMessages() {
  queryMock.mockImplementation(() => {
    const stream = (async function* () {
      yield* [SUCCESS_RESULT];
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

describe("Anthropic Agent SDK prompt and settings ownership", () => {
  afterEach(() => {
    queryMock.mockReset();
  });

  it("replaces the Claude Code preset and disables its memory surfaces by default", async () => {
    useSdkMessages();

    await collect(createContext());

    expect(sdkOptions()).toEqual(
      expect.objectContaining({
        systemPrompt: SYSTEM_PROMPT,
        settings: {
          autoMemoryEnabled: false,
          claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"],
        },
      }),
    );
  });

  it("leaves a restricted run's own --settings payload in place", async () => {
    useSdkMessages();

    const restricted = JSON.stringify({
      disableAllHooks: true,
      enabledPlugins: {},
      autoMemoryEnabled: false,
      claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"],
    });
    await collect(createContext({ args: ["-p", "--settings", restricted] }));

    // That payload also pins disableAllHooks and enabledPlugins; replacing it
    // with the two memory keys would quietly restore hooks and plugins.
    const options = sdkOptions();
    expect(options.settings).toBeUndefined();
    expect(options.extraArgs).toMatchObject({ settings: restricted });
  });
});
