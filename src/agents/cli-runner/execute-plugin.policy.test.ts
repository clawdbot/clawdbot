import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendToolPermissionResult } from "../../plugins/cli-backend.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import * as beforeToolCall from "../agent-tools.before-tool-call.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  closePluginTestAdmissions,
  createExecution,
  requestNativeTool,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

function installBeforeToolCallHook(
  handler: PluginHookHandlerMap["before_tool_call"],
  matcher?: [string, ...string[]],
) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_tool_call",
        handler: (...args) => Reflect.apply(handler, undefined, args),
        ...(matcher ? { matcher } : {}),
      },
    ]),
  );
}

afterEach(() => {
  resetGlobalHookRunner();
  closePluginTestAdmissions();
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
});

describe("plugin-owned CLI native tool policy", () => {
  it("denies native tools when caller authority expires during policy or before a retained call", async () => {
    const { context } = await createExecution({ nativeTools: ["WebFetch"] });
    let callerCurrent = true;
    context.params.assertCurrent = () => {
      if (!callerCurrent) {
        throw new Error("caller revoked");
      }
    };
    const hook = vi.fn(async () => {
      callerCurrent = false;
    });
    installBeforeToolCallHook(hook);
    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com" }),
      ).resolves.toMatchObject({ behavior: "deny" });
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com/retained" }),
      ).resolves.toMatchObject({ behavior: "deny" });
      expect(execution.abortSignal?.aborted).toBe(false);
      yield SUCCESS_RESULT;
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("runs canonical policy before native approval and carries rewritten params plus run context", async () => {
    const policy = vi.spyOn(beforeToolCall, "runBeforeToolCallHook");
    const hook = vi.fn(async (_event: unknown, _context: unknown) => ({
      params: { url: "https://example.com/rewritten" },
    }));
    installBeforeToolCallHook(hook);
    const { context } = await createExecution({ nativeTools: ["WebFetch"] });
    Object.assign(context.params, {
      messageChannel: "telegram",
      messageProvider: "telegram",
      currentChannelId: "chat-1",
      chatId: "chat-1",
      agentAccountId: "bot-1",
      senderId: "user-1",
      senderIsOwner: true,
      currentThreadTs: "thread-1",
    });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "WebFetch", {
        url: "https://example.com/original",
      });
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: { url: "https://example.com/rewritten" },
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]?.[0]).toMatchObject({
      toolName: "web_fetch",
      params: { url: "https://example.com/original" },
      toolCallId: "native-WebFetch",
      runId: context.params.runId,
    });
    expect(hook.mock.calls[0]?.[1]).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "sdk-session",
      runId: context.params.runId,
      channelId: "chat-1",
      requester: {
        channel: "telegram",
        accountId: "bot-1",
        senderId: "user-1",
        senderIsOwner: true,
      },
    });
    expect(policy.mock.calls[0]?.[0]).toMatchObject({
      ctx: {
        config: context.params.config,
        cwd: "/tmp",
        workspaceDir: "/tmp",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
        turnSourceAccountId: "bot-1",
        turnSourceThreadId: "thread-1",
        loopDetection: undefined,
      },
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it.each([
    { native: "Bash", canonical: "exec", input: { command: "echo blocked" } },
    {
      native: "WebFetch",
      canonical: "web_fetch",
      input: { url: "https://example.com", prompt: "summarize" },
    },
    { native: "WebSearch", canonical: "web_search", input: { query: "blocked" } },
  ])(
    "applies matched $canonical policy to native $native",
    async ({ native, canonical, input }) => {
      const hook = vi.fn(async () => ({ block: true, blockReason: `${canonical} blocked` }));
      installBeforeToolCallHook(hook, [canonical]);
      const { context } = await createExecution({ nativeTools: [native] });
      let decision: CliBackendToolPermissionResult | undefined;

      await runPlugin(context, async function* (execution) {
        decision = await requestNativeTool(execution, native, input);
        yield SUCCESS_RESULT;
      });

      expect(decision).toEqual({ behavior: "deny", message: `${canonical} blocked` });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: canonical, params: input }),
        expect.objectContaining({ toolName: canonical }),
      );
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { native: "Read", canonical: "read", input: { file_path: "/tmp/private.txt" } },
    {
      native: "Write",
      canonical: "write",
      input: { file_path: "/tmp/private.txt", content: "private" },
    },
    {
      native: "Edit",
      canonical: "edit",
      input: { file_path: "/tmp/private.txt", old_string: "old", new_string: "new" },
    },
  ])(
    "applies path-based $canonical policy to native $native",
    async ({ native, canonical, input }) => {
      const hook = vi.fn(async (event: { params: Record<string, unknown> }) =>
        event.params.path === "/tmp/private.txt"
          ? { block: true, blockReason: "private path blocked" }
          : undefined,
      );
      installBeforeToolCallHook(hook, [canonical]);
      const { context } = await createExecution({ nativeTools: [native] });
      let decision: CliBackendToolPermissionResult | undefined;

      await runPlugin(context, async function* (execution) {
        decision = await requestNativeTool(execution, native, input);
        yield SUCCESS_RESULT;
      });

      expect(decision).toEqual({ behavior: "deny", message: "private path blocked" });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: canonical,
          params: expect.objectContaining({ path: "/tmp/private.txt" }),
        }),
        expect.objectContaining({ toolName: canonical }),
      );
    },
  );

  it("projects rewritten canonical file arguments back into the native Edit schema", async () => {
    const hook = vi.fn(async () => ({
      params: {
        path: "/tmp/approved.txt",
        edits: [{ oldText: "safe-before", newText: "safe-after" }],
      },
    }));
    installBeforeToolCallHook(hook, ["edit"]);
    const { context } = await createExecution({ nativeTools: ["Edit"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Edit", {
        file_path: "/tmp/original.txt",
        old_string: "before",
        new_string: "after",
        replace_all: false,
      });
      yield SUCCESS_RESULT;
    });

    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "edit",
        params: expect.objectContaining({
          path: "/tmp/original.txt",
          edits: [{ oldText: "before", newText: "after" }],
        }),
      }),
      expect.anything(),
    );
    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: {
        file_path: "/tmp/approved.txt",
        old_string: "safe-before",
        new_string: "safe-after",
        replace_all: false,
      },
    });
  });

  it("rejects conflicting native and canonical paths before invoking policy", async () => {
    const hook = vi.fn(async () => undefined);
    installBeforeToolCallHook(hook, ["read"]);
    const { context } = await createExecution({ nativeTools: ["Read"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Read", {
        file_path: "/tmp/private.txt",
        path: "/tmp/allowed.txt",
      });
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("conflicting"),
      }),
    );
    expect(hook).not.toHaveBeenCalled();
  });

  it("rejects canonical edit rewrites that the native tool cannot represent", async () => {
    const hook = vi.fn(async () => ({
      params: {
        edits: [
          { oldText: "first", newText: "one" },
          { oldText: "second", newText: "two" },
        ],
      },
    }));
    installBeforeToolCallHook(hook, ["edit"]);
    const { context } = await createExecution({ nativeTools: ["Edit"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Edit", {
        file_path: "/tmp/file.txt",
        old_string: "before",
        new_string: "after",
      });
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("native edit"),
      }),
    );
  });

  it.each([
    {
      name: "blocks",
      handler: vi.fn(async () => ({ block: true, blockReason: "blocked by plugin policy" })),
      message: "blocked by plugin policy",
    },
    {
      name: "fails",
      handler: vi.fn(async () => {
        throw new Error("policy crashed");
      }),
      message: "before_tool_call hook failed",
    },
  ])("fails closed when before_tool_call $name", async ({ handler, message }) => {
    installBeforeToolCallHook(handler);
    const { context } = await createExecution({ nativeTools: ["Bash"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({ behavior: "deny", message: expect.stringContaining(message) }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("aborts before_tool_call without reaching native approval", async () => {
    const controller = new AbortController();
    const hook = vi.fn(
      async (_event: unknown, hookContext: { abortSignal?: AbortSignal }): Promise<undefined> =>
        await new Promise((_, reject) => {
          hookContext.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("policy aborted")),
            { once: true },
          );
        }),
    );
    installBeforeToolCallHook(hook);
    const { context } = await createExecution({
      abortSignal: controller.signal,
      nativeTools: ["Bash"],
    });
    const run = runPlugin(context, async function* (execution) {
      await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());

    controller.abort(new Error("cancel policy"));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("fails closed when canonical policy returns a non-record rewrite", async () => {
    vi.spyOn(beforeToolCall, "runBeforeToolCallHook").mockResolvedValueOnce({
      blocked: false,
      params: "invalid",
    });
    const { context } = await createExecution({ nativeTools: ["Bash"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("invalid input"),
      }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});
