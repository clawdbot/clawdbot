// Copilot tests cover tool bridge plugin behavior.
import type { Tool as SdkTool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import type { AnyAgentTool, SandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotToolBridge } from "./tool-bridge.js";

type CopilotToolBridgeInput = Parameters<typeof createCopilotToolBridge>[0];
type ConvertToolOptions = Pick<
  CopilotToolBridgeInput,
  "abortSignal" | "beforeExecute" | "onToolCompleted"
> & {
  onAgentToolResult?: NonNullable<CopilotToolBridgeInput["attemptParams"]>["onAgentToolResult"];
};

type FakeTool = AnyAgentTool & {
  execute: ReturnType<typeof vi.fn>;
  prepareArguments?: ReturnType<typeof vi.fn>;
};

function createDeferred<T>() {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject(reason?: unknown) {
      rejectPromise?.(reason);
    },
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

function flushAsync() {
  return Promise.resolve().then(() => {});
}

function makeInvocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    arguments: { value: "input" },
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "tool-a",
    ...overrides,
  };
}

function makeTool(
  overrides: Partial<FakeTool> = {},
  result: { content?: unknown; details: unknown } = {
    content: [{ text: "done", type: "text" }],
    details: null,
  },
): FakeTool {
  return {
    description: "A fake tool",
    execute: vi.fn(async () => result),
    label: "Fake Tool",
    name: "tool-a",
    parameters: {
      properties: { value: { type: "string" } },
      type: "object",
    } as never,
    ...overrides,
  } as unknown as FakeTool;
}

function getError(result: ToolResultObject): string | undefined {
  return result.error;
}

function runSdkTool(tool: SdkTool, args: unknown, invocation = makeInvocation()) {
  if (!tool.handler) {
    throw new Error(`SDK tool '${tool.name}' has no handler`);
  }
  return tool.handler(args, invocation);
}

async function convertOpenClawToolToSdkToolForTest(
  sourceTool: AnyAgentTool,
  options: ConvertToolOptions,
): Promise<SdkTool> {
  const bridge = await createCopilotToolBridge({
    abortSignal: options.abortSignal,
    agentId: "agent-1",
    allowModelTools: true,
    attemptParams: options.onAgentToolResult
      ? { onAgentToolResult: options.onAgentToolResult }
      : undefined,
    beforeExecute: options.beforeExecute,
    createOpenClawCodingTools: async () => [sourceTool],
    modelId: "gpt-test",
    modelProvider: "github-copilot",
    onToolCompleted: options.onToolCompleted,
    sessionId: "session-1",
  });
  return expectDefined(bridge.sdkTools[0], "Copilot SDK tool");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCopilotToolBridge", () => {
  it("returns empty arrays for unsupported providers without calling the seam", async () => {
    const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);

    const result = await createCopilotToolBridge({
      agentId: "agent-1",
      createOpenClawCodingTools,
      modelId: "gpt-4o",
      modelProvider: "openai",
      sessionId: "session-1",
    });

    expect(result).toEqual({ sdkTools: [], sourceTools: [] });
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
  });

  it("allows vetted BYOK providers to expose model tools", async () => {
    const sourceTools = [makeTool()];
    const createOpenClawCodingTools = vi.fn(async () => sourceTools);

    const result = await createCopilotToolBridge({
      agentId: "agent-1",
      allowModelTools: true,
      createOpenClawCodingTools,
      modelId: "gpt-test",
      modelProvider: "custom-openai",
      sessionId: "session-1",
    });

    expect(createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-test",
        modelProvider: "custom-openai",
      }),
    );
    expect(result.sourceTools).toEqual(sourceTools);
    expect(result.sdkTools.map((tool) => tool.name)).toEqual(["tool-a"]);
  });

  it("forwards supported fields to injected createOpenClawCodingTools", async () => {
    const controller = new AbortController();
    const computerContextEpoch = { value: 0 };
    const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);

    await createCopilotToolBridge({
      abortSignal: controller.signal,
      agentDir: "/agent",
      agentId: "agent-1",
      computerContextEpoch,
      createOpenClawCodingTools,
      cwd: "/workspace/task",
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
      sessionKey: "session-key",
      workspaceDir: "/workspace",
    });

    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(1);
    // F6: the bridge now forwards PI-parity context fields too. This
    // test continues to assert the core flat fields plumb through; full
    // PI-parity is asserted in dedicated tests below.
    expect(createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
        agentDir: "/agent",
        agentId: "agent-1",
        computerContextEpoch,
        cwd: "/workspace/task",
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
        // sessionKey is the sandboxSessionKey derivation; with no
        // attemptParams the bridge falls back to input.sessionKey.
        sessionKey: "session-key",
        workspaceDir: "/workspace",
      }),
    );
  });

  it("returns sdkTools and sourceTools with matching lengths", async () => {
    const sourceTools = [makeTool(), makeTool({ name: "tool-b" })];

    const result = await createCopilotToolBridge({
      agentId: "agent-1",
      createOpenClawCodingTools: async () => sourceTools,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    });

    expect(result.sourceTools).toEqual(sourceTools);
    expect(result.sdkTools).toHaveLength(2);
    expect(result.sdkTools.map((tool) => tool.name)).toEqual(["tool-a", "tool-b"]);
  });

  it("preserves direct-only OpenClaw through the exact Copilot allowlist", async () => {
    const systemAgentTool = makeTool({
      name: "openclaw",
      catalogMode: "direct-only",
    } as never);

    const result = await createCopilotToolBridge({
      agentId: "openclaw",
      attemptParams: {
        runId: "openclaw-turn-1",
        sessionKey: "agent:openclaw:main",
        toolsAllow: ["openclaw"],
      } as never,
      createOpenClawCodingTools: async () => [systemAgentTool],
      modelId: "gpt-4.1",
      modelProvider: "github-copilot",
      sessionId: "openclaw-session",
    });

    expect(result.sourceTools).toEqual([systemAgentTool]);
    expect(result.sdkTools.map((tool) => tool.name)).toEqual(["openclaw"]);
  });

  it("compacts the Copilot tool surface behind tool_search controls when enabled", async () => {
    const createOpenClawCodingTools = vi.fn(async (opts: unknown) => {
      const includeToolSearchControls = Boolean(
        (opts as { includeToolSearchControls?: boolean }).includeToolSearchControls,
      );
      return includeToolSearchControls
        ? [
            makeTool({ name: "tool_search_code" }),
            makeTool({ name: "fake_hidden" }),
            makeTool({ name: "read" }),
          ]
        : [makeTool({ name: "fake_hidden" }), makeTool({ name: "read" })];
    });

    const result = await createCopilotToolBridge({
      agentId: "agent-1",
      attemptParams: {
        config: { tools: { toolSearch: true } },
        runId: "run-tool-search",
        sessionKey: "agent:main:main",
      } as never,
      createOpenClawCodingTools,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    });

    expect(createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        includeToolSearchControls: true,
        toolSearchCatalogRef: expect.any(Object),
        toolSearchCatalogExecutor: expect.any(Function),
      }),
    );
    expect(result.sourceTools.map((tool) => tool.name)).toEqual(["tool_search_code"]);
    expect(result.sdkTools.map((tool) => tool.name)).toEqual(["tool_search_code"]);
  });

  it("keeps tool_search controls visible when a narrow allowlist is active", async () => {
    const createOpenClawCodingTools = vi.fn(async (opts: unknown) => {
      const includeToolSearchControls = Boolean(
        (opts as { includeToolSearchControls?: boolean }).includeToolSearchControls,
      );
      return includeToolSearchControls
        ? [makeTool({ name: "tool_search_code" }), makeTool({ name: "read" })]
        : [makeTool({ name: "read" })];
    });

    const result = await createCopilotToolBridge({
      agentId: "agent-1",
      attemptParams: {
        config: { tools: { toolSearch: true } },
        runId: "run-tool-search",
        sessionKey: "agent:main:main",
        toolsAllow: ["read"],
      } as never,
      createOpenClawCodingTools,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    });

    expect(result.sourceTools.map((tool) => tool.name)).toEqual(["tool_search_code"]);
    expect(result.sdkTools.map((tool) => tool.name)).toEqual(["tool_search_code"]);
  });

  it("filters the hidden tool_search catalog before compacting narrowed tools", async () => {
    let catalogRef: { current?: { entries?: Array<{ name: string }> } } | undefined;
    const createOpenClawCodingTools = vi.fn(async (opts: unknown) => {
      catalogRef = (opts as { toolSearchCatalogRef?: typeof catalogRef }).toolSearchCatalogRef;
      return [
        makeTool({ name: "tool_search_code" }),
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
        makeTool({ name: "write" }),
      ];
    });

    await createCopilotToolBridge({
      agentId: "agent-1",
      attemptParams: {
        config: { tools: { toolSearch: true } },
        runId: "run-tool-search",
        sessionKey: "agent:main:main",
        toolsAllow: ["read"],
      } as never,
      createOpenClawCodingTools,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    });

    expect(catalogRef?.current?.entries?.map((entry) => entry.name)).toEqual(["read"]);
  });

  it("compacts the Copilot tool surface behind code-mode exec/wait when enabled", async () => {
    const createOpenClawCodingTools = vi.fn(async () => [
      makeTool({ name: "fake_hidden" }),
      makeTool({ name: "read" }),
    ]);

    const result = await createCopilotToolBridge({
      agentId: "agent-1",
      attemptParams: {
        config: { tools: { codeMode: true } },
        runId: "run-code-mode",
        sessionKey: "agent:main:main",
      } as never,
      createOpenClawCodingTools,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    });

    expect(createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        includeToolSearchControls: false,
        toolSearchCatalogRef: expect.any(Object),
        toolSearchCatalogExecutor: expect.any(Function),
      }),
    );
    expect(result.sourceTools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(result.sdkTools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
  });

  it("keeps code-mode controls visible when a narrow allowlist is active", async () => {
    const createOpenClawCodingTools = vi.fn(async () => [
      makeTool({ name: "fake_hidden" }),
      makeTool({ name: "read" }),
    ]);

    const result = await createCopilotToolBridge({
      agentId: "agent-1",
      attemptParams: {
        config: { tools: { codeMode: true } },
        runId: "run-code-mode",
        sessionKey: "agent:main:main",
        toolsAllow: ["read"],
      } as never,
      createOpenClawCodingTools,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    });

    expect(result.sourceTools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(result.sdkTools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
  });

  it("filters the hidden code-mode catalog before compacting narrowed tools", async () => {
    let catalogRef: { current?: { entries?: Array<{ name: string }> } } | undefined;
    const createOpenClawCodingTools = vi.fn(async (opts: unknown) => {
      catalogRef = (opts as { toolSearchCatalogRef?: typeof catalogRef }).toolSearchCatalogRef;
      return [makeTool({ name: "read" }), makeTool({ name: "edit" }), makeTool({ name: "write" })];
    });

    await createCopilotToolBridge({
      agentId: "agent-1",
      attemptParams: {
        config: { tools: { codeMode: true } },
        runId: "run-code-mode",
        sessionKey: "agent:main:main",
        toolsAllow: ["read"],
      } as never,
      createOpenClawCodingTools,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    });

    expect(catalogRef?.current?.entries?.map((entry) => entry.name)).toEqual(["read"]);
  });

  it("throws when createOpenClawCodingTools returns a non-array", async () => {
    await expect(
      createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools: async () => ({ tools: [] }) as never,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("createOpenClawCodingTools must return an array");
  });

  it("throws when createOpenClawCodingTools rejects and includes the cause", async () => {
    await expect(
      createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools: async () => {
          throw new Error("factory failed");
        },
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("factory failed");
  });

  it("throws on duplicate tool names and lists all duplicates", async () => {
    await expect(
      createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools: async () => [
          makeTool({ name: "alpha" }),
          makeTool({ name: "beta" }),
          makeTool({ name: "alpha" }),
          makeTool({ name: "beta" }),
        ],
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("duplicate tool names: alpha, beta");
  });

  // F6: PI-parity tool context. The bridged OpenClaw tools register
  // with the SDK as `overridesBuiltInTool: true, skipPermission: true`,
  // so the wrapped-tool enforcement layer
  // (src/agents/pi-tools.before-tool-call.ts) is the single gate for
  // permission, owner-only allowlists, loop detection, trusted-plugin
  // policies, and two-phase plugin approvals. Missing context fields
  // silently degrade those policy decisions. See round-3 maintainer
  // finding F6 and docs/plugins/copilot.md.
  describe("PI-parity attempt context (F6)", () => {
    function captureCall() {
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      return {
        createOpenClawCodingTools,
        getOpts: () =>
          (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as Record<
            string,
            unknown
          >,
      };
    }

    it("forwards identity, owner/policy, and channel/routing fields from attemptParams", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          agentAccountId: "acct-1",
          senderId: "sender-1",
          senderName: "Ada",
          senderUsername: "ada",
          senderE164: "+15551234567",
          senderIsOwner: true,
          memberRoleIds: ["role-admin"],
          allowGatewaySubagentBinding: true,
          spawnedBy: "parent:agent",
          groupId: "g-1",
          groupChannel: "#general",
          groupSpace: "team-1",
          currentChannelId: "C123",
          currentMessagingTarget: "user:U123",
          currentThreadTs: "1700000000.000100",
          currentMessageId: "M-1",
          messageProvider: "slack",
          messageTo: "U-1",
          messageThreadId: "1700000000.000100",
          replyToMode: "first",
          requireExplicitMessageTarget: true,
          disableMessageTool: false,
          forceMessageTool: true,
          enableHeartbeatTool: true,
          forceHeartbeatTool: false,
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      const opts = getOpts();
      expect(opts).toMatchObject({
        agentAccountId: "acct-1",
        senderId: "sender-1",
        senderName: "Ada",
        senderUsername: "ada",
        senderE164: "+15551234567",
        senderIsOwner: true,
        memberRoleIds: ["role-admin"],
        allowGatewaySubagentBinding: true,
        spawnedBy: "parent:agent",
        groupId: "g-1",
        groupChannel: "#general",
        groupSpace: "team-1",
        currentChannelId: "C123",
        currentMessagingTarget: "user:U123",
        currentThreadTs: "1700000000.000100",
        currentMessageId: "M-1",
        messageProvider: "slack",
        messageTo: "U-1",
        messageThreadId: "1700000000.000100",
        replyToMode: "first",
        requireExplicitMessageTarget: true,
        forceMessageTool: true,
        enableHeartbeatTool: true,
      });
    });

    it("falls back messageProvider to attemptParams.messageChannel when messageProvider is absent (codex parity)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { messageChannel: "telegram" } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      expect(getOpts().messageProvider).toBe("telegram");
    });

    it("forwards authProfileStore, runId, config, and run hooks (onToolOutcome) from attemptParams", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const authProfileStore = { kind: "fake-store" } as never;
      const config = { agents: {} } as never;
      const onToolOutcome = vi.fn();

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          authProfileStore,
          runId: "run-1",
          config,
          onToolOutcome,
          messageActionTurnCapability: "turn-capability-1",
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      const opts = getOpts();
      expect(opts.authProfileStore).toBe(authProfileStore);
      expect(opts.runId).toBe("run-1");
      expect(opts.config).toBe(config);
      expect(opts.onToolOutcome).toBe(onToolOutcome);
      expect(opts.messageActionTurnCapability).toBe("turn-capability-1");
    });

    it("prefers the unscoped toolAuthProfileStore when building OpenClaw tools", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const authProfileStore = { kind: "transport-scoped-store" } as never;
      const toolAuthProfileStore = { kind: "tool-store" } as never;

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          authProfileStore,
          toolAuthProfileStore,
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      expect(getOpts().authProfileStore).toBe(toolAuthProfileStore);
    });

    it("derives sandboxSessionKey and runSessionKey from attemptParams (PI parity)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        // Mirrors PI attempt.ts:1053-1060: when sandboxSessionKey
        // differs from sessionKey, sessionKey is published as the
        // sandbox key and the real run key is exposed as runSessionKey
        // so `session_status: "current"` resolves to the live session.
        attemptParams: {
          sandboxSessionKey: "sandbox:agent:main",
          sessionKey: "agent:main:main",
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      const opts = getOpts();
      expect(opts.sessionKey).toBe("sandbox:agent:main");
      expect(opts.runSessionKey).toBe("agent:main:main");
    });

    it("derives runSessionKey as undefined when sandboxSessionKey equals sessionKey", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { sessionKey: "agent:main:main" } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      const opts = getOpts();
      expect(opts.sessionKey).toBe("agent:main:main");
      expect(opts.runSessionKey).toBeUndefined();
    });

    it("falls back sessionKey to input.sessionKey when attemptParams omits it (legacy callers)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {},
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
        sessionKey: "fallback-key",
      });

      expect(getOpts().sessionKey).toBe("fallback-key");
    });

    it("computes modelApi, modelContextWindowTokens, modelCompat, and modelHasVision from attemptParams.model", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          model: {
            api: "openai-responses",
            contextWindow: 200_000,
            input: ["text", "image"],
            compat: { some: "shape" },
          },
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      const opts = getOpts();
      expect(opts.modelApi).toBe("openai-responses");
      expect(opts.modelContextWindowTokens).toBe(200_000);
      expect(opts.modelHasVision).toBe(true);
      expect(opts.modelCompat).toEqual({ some: "shape" });
    });

    it("modelHasVision is false when model.input does not include 'image'", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { model: { input: ["text"] } } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      expect(getOpts().modelHasVision).toBe(false);
    });

    it("spreads execOverrides and bashElevated into the exec field (PI parity)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const execOverrides = { security: "fast" } as never;
      const bashElevated = { allowed: true } as never;

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { execOverrides, bashElevated } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      const exec = getOpts().exec as Record<string, unknown>;
      expect(exec).toMatchObject({ security: "fast", elevated: { allowed: true } });
    });

    it("forwards run-trace context (trigger, jobId, memoryFlushWritePath, toolsAllow) via buildEmbeddedAttemptToolRunContext", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          trigger: "cron",
          jobId: "job-1",
          memoryFlushWritePath: ".memory/append.md",
          toolsAllow: ["read", "edit"],
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      const opts = getOpts();
      expect(opts.trigger).toBe("cron");
      expect(opts.jobId).toBe("job-1");
      expect(opts.memoryFlushWritePath).toBe(".memory/append.md");
      // buildEmbeddedAttemptToolRunContext renames toolsAllow ->
      // runtimeToolAllowlist; consumers (PI plugin tools) read the
      // renamed key, so the bridge must surface the renamed shape too.
      expect(opts.runtimeToolAllowlist).toEqual(["read", "edit"]);
    });

    it("forwards the native conversation identity from attemptParams", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          chatId: "oc_native_chat",
          chatType: "direct",
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      expect(getOpts()).toMatchObject({
        chatType: "direct",
        nativeChannelId: "oc_native_chat",
      });
    });

    it("onYield routes to sessionRef.current.abort() and invokes onYieldDetected when the live session is bound", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const abort = vi.fn();
      const sessionRef: { current: { abort?: () => unknown } | undefined } = {
        current: undefined,
      };
      const onYieldDetected = vi.fn();

      await createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        onYieldDetected,
        sessionId: "session-1",
        sessionRef,
      });

      const onYield = getOpts().onYield as (msg?: string) => void;
      // No session bound yet: onYield must no-op the abort path
      // without throwing, but the onYieldDetected notification fires
      // regardless so a yield before session-bind is still surfaced
      // to the final attempt result.
      expect(() => onYield("early yield")).not.toThrow();
      expect(abort).toHaveBeenCalledTimes(0);
      expect(onYieldDetected).toHaveBeenCalledTimes(1);
      expect(onYieldDetected).toHaveBeenCalledWith("early yield");

      // Bind the session after the fact (attempt.ts does this after
      // createSession/resumeSession resolves) and verify subsequent
      // yields abort it and continue to notify.
      sessionRef.current = { abort };
      onYield("now yield");
      expect(abort).toHaveBeenCalledTimes(1);
      expect(onYieldDetected).toHaveBeenCalledTimes(2);
      expect(onYieldDetected).toHaveBeenLastCalledWith("now yield");
    });

    it("onYield still aborts the live session when onYieldDetected throws (defense in depth)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const abort = vi.fn();
      const sessionRef: { current: { abort?: () => unknown } | undefined } = {
        current: { abort },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        onYieldDetected: () => {
          throw new Error("handler boom");
        },
        sessionId: "session-1",
        sessionRef,
      });

      const onYield = getOpts().onYield as (msg?: string) => void;
      expect(() => onYield("handler-fails-but-abort-must-fire")).not.toThrow();
      expect(abort).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("requireExplicitMessageTarget defaults to isSubagentSessionKey(sessionKey) when undefined", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        agentId: "agent-1",
        // No requireExplicitMessageTarget; sessionKey looks like a
        // subagent key so the default must be true. Mirrors PI
        // attempt.ts:1097-1098.
        attemptParams: { sessionKey: "subagent:envelope:abc" } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      const opts = getOpts();
      // We don't assert the exact boolean (subagent detection is owned
      // by isSubagentSessionKey) — only that the bridge consulted the
      // helper rather than emitting `undefined`.
      expect(typeof opts.requireExplicitMessageTarget).toBe("boolean");
    });
  });

  describe("sandbox forwarding (PR #86155 [P1])", () => {
    function makeSandboxStub(overrides: Partial<SandboxContext> = {}): SandboxContext {
      return {
        enabled: true,
        workspaceAccess: "ro",
        workspaceDir: "/sandbox/copy",
        agentWorkspaceDir: "/sandbox/agent",
        scopeKey: "agent-1:session-1",
        sessionKey: "session-1",
        backend: { kind: "local" } as never,
        cfg: {} as never,
        ...overrides,
      } as unknown as SandboxContext;
    }

    it("defaults sandbox to undefined and derives spawnWorkspaceDir from workspaceDir when no sandbox is passed (back-compat)", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      await createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
        sessionKey: "session-1",
        workspaceDir: "/workspace",
      });
      const opts = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sandbox?: unknown;
        spawnWorkspaceDir?: unknown;
        workspaceDir?: unknown;
      };
      expect(opts.sandbox).toBeUndefined();
      expect(opts.workspaceDir).toBe("/workspace");
      // resolveAttemptSpawnWorkspaceDir returns undefined for the
      // no-sandbox path; the back-compat fallback emits that.
      expect(opts.spawnWorkspaceDir).toBeUndefined();
    });

    it("forwards an explicit sandbox and spawnWorkspaceDir verbatim to createOpenClawCodingTools", async () => {
      const sandbox = makeSandboxStub();
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      await createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sandbox,
        sessionId: "session-1",
        sessionKey: "session-1",
        spawnWorkspaceDir: "/original-workspace",
        workspaceDir: "/sandbox/copy",
      });
      const opts = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sandbox?: unknown;
        spawnWorkspaceDir?: unknown;
        workspaceDir?: unknown;
      };
      expect(opts.sandbox).toBe(sandbox);
      expect(opts.workspaceDir).toBe("/sandbox/copy");
      expect(opts.spawnWorkspaceDir).toBe("/original-workspace");
    });

    it("derives spawnWorkspaceDir from sandbox when caller omits it (fallback path)", async () => {
      const sandbox = makeSandboxStub({ workspaceAccess: "ro" });
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      await createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sandbox,
        sessionId: "session-1",
        sessionKey: "session-1",
        workspaceDir: "/sandbox/copy",
      });
      const opts = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        spawnWorkspaceDir?: unknown;
      };
      // Fallback derives spawnWorkspaceDir from (effective) workspaceDir
      // since the caller didn't pre-compute one. For a ro/none sandbox
      // this yields the effective dir (= sandbox copy). Production
      // callers (attempt.ts) always pre-compute spawnWorkspaceDir from
      // the original workspace; the fallback is for test fixtures.
      expect(opts.spawnWorkspaceDir).toBe("/sandbox/copy");
    });
  });

  // The Copilot bridge mirrors the PI runner's disable/raw/allowlist
  // gates locally (codex-precedent at
  // extensions/codex/src/app-server/run-attempt.ts:3813,3906-3939,4220-4234)
  // so a Copilot run cannot expose the SDK any tool that the same
  // OpenClaw attempt would suppress. These tests pin the contract.
  describe("tool-surface gating (PR #86155 [P1] round-6)", () => {
    it("short-circuits when attemptParams.disableTools is true and never calls createOpenClawCodingTools", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { disableTools: true } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result).toEqual({ sdkTools: [], sourceTools: [] });
      expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
    });

    it('short-circuits raw model runs signalled via promptMode: "none"', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { promptMode: "none" } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result).toEqual({ sdkTools: [], sourceTools: [] });
      expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
    });

    it("short-circuits raw model runs signalled via modelRun: true", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { modelRun: true } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result).toEqual({ sdkTools: [], sourceTools: [] });
      expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
    });

    it("filters constructed tools to exactly the allowlist when toolsAllow is narrow", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["read"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read"]);
      expect(result.sdkTools.map((tool) => tool.name)).toEqual(["read"]);
    });

    it("returns no tools when toolsAllow is an empty list and nothing is forced", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: [] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools).toEqual([]);
      expect(result.sdkTools).toEqual([]);
    });

    it('merges "message" into an empty allowlist when forceMessageTool is true', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: [], forceMessageTool: true } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["message"]);
    });

    it('merges "message" into an empty allowlist when sourceReplyDeliveryMode is message_tool_only', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          toolsAllow: [],
          sourceReplyDeliveryMode: "message_tool_only",
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["message"]);
    });

    it('appends "message" to a narrow allowlist when forceMessageTool is true', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          toolsAllow: ["read"],
          forceMessageTool: true,
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name).toSorted()).toEqual(["message", "read"]);
    });

    it("does NOT force a message tool when disableMessageTool is true (disable wins over force)", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          toolsAllow: ["read"],
          forceMessageTool: true,
          disableMessageTool: true,
        } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read"]);
    });

    it("leaves the tool list unchanged when toolsAllow is undefined", async () => {
      const tools = [makeTool({ name: "read" }), makeTool({ name: "edit" })];
      const createOpenClawCodingTools = vi.fn(async () => tools);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {} as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read", "edit"]);
    });

    it("leaves the tool list unchanged when toolsAllow contains a wildcard", async () => {
      const tools = [makeTool({ name: "read" }), makeTool({ name: "edit" })];
      const createOpenClawCodingTools = vi.fn(async () => tools);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["*"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read", "edit"]);
    });

    it("runs duplicate detection AFTER allowlist filtering so a suppressed duplicate does not fail a narrow run", async () => {
      // The raw construction returns duplicate "edit" entries, but the
      // allowlist excludes "edit" entirely. PI parity: the duplicate
      // never reaches the SDK, so the bridge must not throw.
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
        makeTool({ name: "edit" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["read"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read"]);
    });

    it("still throws when the filtered tool set itself contains duplicates", async () => {
      // Both copies of "read" survive the allowlist, so the duplicate
      // truly reaches the SDK and the bridge must fail loudly.
      await expect(
        createCopilotToolBridge({
          agentId: "agent-1",
          attemptParams: { toolsAllow: ["read"] } as never,
          createOpenClawCodingTools: async () => [
            makeTool({ name: "read" }),
            makeTool({ name: "read" }),
          ],
          modelId: "gpt-4o",
          modelProvider: "github-copilot",
          sessionId: "session-1",
        }),
      ).rejects.toThrow("duplicate tool names: read");
    });
  });

  // Codex extension already normalises a small set of tool-name aliases
  // before allowlist matching
  // (extensions/codex/src/app-server/dynamic-tool-profile.ts:17-30
  // + extensions/codex/src/app-server/run-attempt.test.ts:2062). The
  // Copilot bridge mirrors the same two aliases so a `toolsAllow: ["bash"]`
  // or `toolsAllow: ["apply-patch"]` resolves to the underlying tool.
  describe("tool-name aliases (PR #86155 [P1] round-7)", () => {
    it('matches the "exec" tool when toolsAllow contains "bash"', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "exec" }),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["bash"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["exec"]);
    });

    it('matches the "apply_patch" tool when toolsAllow contains "apply-patch"', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "apply_patch" }),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["apply-patch"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["apply_patch"]);
    });

    it("normalises case so uppercase/whitespace aliases still resolve", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "exec" }),
        makeTool({ name: "apply_patch" }),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: [" BASH ", "Apply-Patch", "READ"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name).toSorted()).toEqual([
        "apply_patch",
        "exec",
        "read",
      ]);
    });

    it("continues to match canonical names directly (no double-aliasing)", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "exec" }),
        makeTool({ name: "apply_patch" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["exec", "apply_patch"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name).toSorted()).toEqual([
        "apply_patch",
        "exec",
      ]);
    });

    it("honors core group allowlists through the shared embedded-runner filter", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["group:fs"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name).toSorted()).toEqual(["edit", "read"]);
    });

    it("does not discard lean-mode overrides after tool construction", async () => {
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: {
          config: {
            agents: { defaults: { experimental: { localModelLean: true } } },
            tools: { alsoAllow: ["image_generate"] },
          },
        } as never,
        createOpenClawCodingTools: async () => [makeTool({ name: "image_generate" })],
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });

      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["image_generate"]);
    });

    it("keeps plugin tools for plugin group allowlists", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "memory_search", pluginId: "active-memory" } as never),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["group:plugins"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["memory_search"]);
    });

    it("keeps core tools available for glob allowlists", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "web_fetch" }),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["web_*"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["web_fetch"]);
      const options = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        toolConstructionPlan?: { includeOpenClawTools?: boolean };
      };
      expect(options?.toolConstructionPlan?.includeOpenClawTools).toBe(true);
    });

    it("does not keep apply_patch for a write-only allowlist", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "write" }),
        makeTool({ name: "apply_patch" }),
      ]);
      const result = await createCopilotToolBridge({
        agentId: "agent-1",
        attemptParams: { toolsAllow: ["write"] } as never,
        createOpenClawCodingTools,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["write"]);
      const options = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        toolConstructionPlan?: { includeShellTools?: boolean };
      };
      expect(options?.toolConstructionPlan?.includeShellTools).toBe(false);
    });
  });
});

describe("createCopilotToolBridge tool conversion", () => {
  it("throws on empty and non-string names", async () => {
    await expect(
      convertOpenClawToolToSdkToolForTest(makeTool({ name: "" as never }), {}),
    ).rejects.toThrow("tool name must be a non-empty string");
    await expect(
      convertOpenClawToolToSdkToolForTest(makeTool({ name: 42 as never }), {}),
    ).rejects.toThrow("tool name must be a non-empty string");
  });

  it("throws on non-function execute", async () => {
    await expect(
      convertOpenClawToolToSdkToolForTest(makeTool({ execute: "nope" as never }), {}),
    ).rejects.toThrow("must define an execute function");
  });

  it("preserves name, description, and parameters exactly", async () => {
    const parameters = {
      properties: { path: { type: "string" } },
      type: "object",
    };
    const sourceTool = makeTool({
      description: "Read a file",
      name: "read_file",
      parameters: parameters as never,
    });

    const result = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    expect(result.name).toBe("read_file");
    expect(result.description).toBe("Read a file");
    expect(result.parameters).toBe(parameters);
  });

  it("sets skipPermission: true so OpenClaw's wrapped-tool internal enforcement handles permission decisions (PI-parity model)", async () => {
    // Per the harness docs: every bridged OpenClaw tool comes from
    // `createOpenClawCodingTools`, which already wraps each tool with
    // `wrapToolWithBeforeToolCallHook` (loop detection, trusted plugin
    // policies, before-tool-call hooks, two-phase plugin approvals via
    // the gateway). Asking the SDK to run its own `onPermissionRequest`
    // for kind: "custom-tool" would either short-circuit OpenClaw's
    // richer enforcement (allow-all) or block every call (reject-all).
    // Setting `skipPermission: true` lets the wrapped execute() run
    // OpenClaw's hook with the right context — mirrors codex
    // (`extensions/codex/src/app-server/dynamic-tools.ts`).
    const result = (await convertOpenClawToolToSdkToolForTest(makeTool(), {})) as SdkTool & {
      skipPermission?: boolean;
    };

    expect(result.skipPermission).toBe(true);
  });

  it("marks every bridged tool as overridesBuiltInTool so OpenClaw owns names that collide with Copilot CLI built-ins (edit/read/write/bash/...)", async () => {
    // Real-world dogfood found that openclaw's createOpenClawCodingTools
    // returns a tool named `edit`, which the bundled Copilot CLI also ships
    // as a built-in. The SDK rejects the registration unless the external
    // tool is explicitly marked as an override.
    for (const name of ["edit", "read", "write", "bash", "live_echo"]) {
      const result = (await convertOpenClawToolToSdkToolForTest(
        makeTool({ name }),
        {},
      )) as SdkTool & { overridesBuiltInTool?: boolean };
      expect(result.overridesBuiltInTool).toBe(true);
    }
  });

  it("returns a failure result when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sourceTool = makeTool();
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {
      abortSignal: controller.signal,
    });

    const result = await runSdkTool(sdkTool, {});

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] aborted before execution",
    });
    expect(getError(result as ToolResultObject)).toBe(
      "[copilot-tool-bridge] aborted before execution",
    );
  });

  it("calls beforeExecute with the invocation context before execute", async () => {
    const beforeExecute = vi.fn(async () => undefined);
    const sourceTool = makeTool();
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, { beforeExecute });
    const invocation = makeInvocation({ toolCallId: "call-42" });
    const args = { value: "input" };

    await runSdkTool(sdkTool, args, invocation);

    expect(beforeExecute).toHaveBeenCalledTimes(1);
    expect(beforeExecute).toHaveBeenCalledWith({
      args,
      invocation,
      sourceTool,
      toolCallId: "call-42",
      toolName: "tool-a",
    });
    expect(
      expectDefined(beforeExecute.mock.invocationCallOrder[0], "Copilot before-execute invocation"),
    ).toBeLessThan(
      expectDefined(sourceTool.execute.mock.invocationCallOrder[0], "Copilot tool invocation"),
    );
  });

  it("returns a failure result when beforeExecute throws", async () => {
    const error = new Error("permission denied");
    const sourceTool = makeTool();
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {
      beforeExecute: vi.fn(async () => {
        throw error;
      }),
    });

    const result = await runSdkTool(sdkTool, {});

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm:
        "[copilot-tool-bridge] beforeExecute failed for tool 'tool-a': permission denied",
    });
    expect(getError(result as ToolResultObject)).toBe(error.message);
  });

  it("calls prepareArguments and passes the prepared args and toolCallId to execute", async () => {
    const preparedArgs = { value: "prepared" };
    const onToolCompleted = vi.fn();
    const prepareArguments = vi.fn(() => preparedArgs);
    const sourceTool = makeTool({ prepareArguments });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, { onToolCompleted });

    await runSdkTool(sdkTool, { value: "raw" }, makeInvocation({ toolCallId: "call-99" }));

    expect(prepareArguments).toHaveBeenCalledTimes(1);
    expect(prepareArguments).toHaveBeenCalledWith({ value: "raw" });
    expect(sourceTool.execute).toHaveBeenCalledWith("call-99", preparedArgs, undefined, undefined);
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ args: preparedArgs, toolCallId: "call-99" }),
    );
  });

  it("returns a failure result when prepareArguments throws", async () => {
    const error = new Error("bad args");
    const sourceTool = makeTool({
      prepareArguments: vi.fn(() => {
        throw error;
      }),
    });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    const result = await runSdkTool(sdkTool, {});

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] prepareArguments failed for tool 'tool-a': bad args",
    });
    expect(getError(result as ToolResultObject)).toBe(error.message);
  });

  it("converts single text content to an exact textResultForLlm", async () => {
    const onAgentToolResult = vi.fn();
    const sourceResult = {
      content: [{ text: "hello", type: "text" }],
      details: { results: [{ text: "hello" }] },
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(makeTool({}, sourceResult), {
      onAgentToolResult,
    });

    const result = await runSdkTool(sdkTool, {});

    expect(result).toEqual({ resultType: "success", textResultForLlm: "hello" });
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "tool-a",
      result: sourceResult,
      isError: false,
    });
  });

  it("reports terminal tool results to the harness lifecycle bridge", async () => {
    const onToolCompleted = vi.fn();
    const sourceResult = {
      content: [{ text: "hello", type: "text" }],
      details: { results: [{ text: "hello" }] },
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(makeTool({}, sourceResult), {
      onToolCompleted,
    });

    await runSdkTool(sdkTool, { value: "input" }, makeInvocation({ toolCallId: "call-9" }));
    await flushAsync();

    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { value: "input" },
        result: sourceResult,
        toolCallId: "call-9",
        toolName: "tool-a",
      }),
    );
  });

  it("reports thrown tool failures to the private result observer", async () => {
    const error = new Error("backend unavailable");
    const onAgentToolResult = vi.fn();
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool({
        execute: vi.fn(async () => {
          throw error;
        }),
      }),
      { onAgentToolResult },
    );

    await runSdkTool(sdkTool, {});

    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "tool-a",
      result: {
        content: [
          {
            type: "text",
            text: "[copilot-tool-bridge] tool 'tool-a' failed: backend unavailable",
          },
        ],
        details: { status: "failed", error: "backend unavailable" },
      },
      isError: true,
    });
  });

  it("reports terminal tool failures to the harness lifecycle bridge", async () => {
    const onToolCompleted = vi.fn();
    const preparedArgs = { value: "prepared" };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool({
        prepareArguments: vi.fn(() => preparedArgs),
        execute: vi.fn(async () => {
          throw new Error("backend unavailable");
        }),
      }),
      { onToolCompleted },
    );

    await runSdkTool(sdkTool, { value: "input" }, makeInvocation({ toolCallId: "call-10" }));
    await flushAsync();

    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        args: preparedArgs,
        error: "backend unavailable",
        toolCallId: "call-10",
        toolName: "tool-a",
      }),
    );
  });

  it("reports returned OpenClaw error results to both tool observers", async () => {
    const onAgentToolResult = vi.fn();
    const onToolCompleted = vi.fn();
    const sourceResult = {
      content: [{ text: '{"status":"error","error":"backend unavailable"}', type: "text" }],
      details: { status: "error", error: "backend unavailable" },
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(makeTool({}, sourceResult), {
      onAgentToolResult,
      onToolCompleted,
    });

    const result = await runSdkTool(sdkTool, {});
    await flushAsync();

    expect(result).toMatchObject({ resultType: "success" });
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "tool-a",
      result: sourceResult,
      isError: true,
    });
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "backend unavailable",
        result: sourceResult,
      }),
    );
  });

  it("joins multiple text blocks with newlines", async () => {
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool(
        {},
        {
          content: [
            { text: "first", type: "text" },
            { text: "second", type: "text" },
            { text: "third", type: "text" },
          ],
          details: null,
        },
      ),
      {},
    );

    const result = await runSdkTool(sdkTool, {});

    expect(result).toEqual({ resultType: "success", textResultForLlm: "first\nsecond\nthird" });
  });

  it("converts image content into binaryResultsForLlm while preserving text", async () => {
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool(
        {},
        {
          content: [
            { text: "preview", type: "text" },
            { data: "base64-data", mimeType: "image/png", type: "image" },
          ],
          details: null,
        },
      ),
      {},
    );

    const result = await runSdkTool(sdkTool, {});

    expect(result).toEqual({
      binaryResultsForLlm: [
        {
          data: "base64-data",
          mimeType: "image/png",
          type: "image",
        },
      ],
      resultType: "success",
      textResultForLlm: "preview",
    });
  });

  it("returns a failure result when execute throws and preserves the error", async () => {
    const error = new Error("tool exploded");
    const sourceTool = makeTool({
      execute: vi.fn(async () => {
        throw error;
      }),
    });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    const result = await runSdkTool(sdkTool, {});

    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] tool 'tool-a' failed: tool exploded",
    });
    expect(getError(result as ToolResultObject)).toBe(error.message);
  });

  it("runs default tools in parallel", async () => {
    const first = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const second = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const sourceTool = makeTool({ execute });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    const firstRun = runSdkTool(sdkTool, {}, makeInvocation({ toolCallId: "call-1" }));
    const secondRun = runSdkTool(sdkTool, {}, makeInvocation({ toolCallId: "call-2" }));
    await flushAsync();

    expect(execute).toHaveBeenCalledTimes(2);
    first.resolve({ content: [{ text: "one", type: "text" }], details: null });
    second.resolve({ content: [{ text: "two", type: "text" }], details: null });

    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
      { resultType: "success", textResultForLlm: "one" },
      { resultType: "success", textResultForLlm: "two" },
    ]);
  });

  it("serializes sequential tools so the second call waits for the first", async () => {
    const first = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const second = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const sourceTool = makeTool({ execute, executionMode: "sequential" });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    const firstRun = runSdkTool(sdkTool, {}, makeInvocation({ toolCallId: "call-1" }));
    const secondRun = runSdkTool(sdkTool, {}, makeInvocation({ toolCallId: "call-2" }));
    await flushAsync();

    expect(execute).toHaveBeenCalledTimes(1);
    first.resolve({ content: [{ text: "one", type: "text" }], details: null });
    await firstRun;
    await flushAsync();
    expect(execute).toHaveBeenCalledTimes(2);
    second.resolve({ content: [{ text: "two", type: "text" }], details: null });

    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
      { resultType: "success", textResultForLlm: "one" },
      { resultType: "success", textResultForLlm: "two" },
    ]);
  });

  it("returns a failure result when execute observes an abort after start", async () => {
    const controller = new AbortController();
    const sourceTool = makeTool({
      execute: vi.fn(
        (_toolCallId: string, _args: unknown, signal?: AbortSignal) =>
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("aborted during execute"));
              },
              { once: true },
            );
          }),
      ),
    });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {
      abortSignal: controller.signal,
    });

    const resultPromise = runSdkTool(sdkTool, {});
    await flushAsync();
    controller.abort();
    const result = await resultPromise;

    expect(sourceTool.execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] tool 'tool-a' failed: aborted during execute",
    });
    expect(getError(result as ToolResultObject)).toBe("aborted during execute");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
