/** Tests phase-scoped plugin hooks and hook registration ordering. */
import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks, createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import type {
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "./types.js";

describe("phase hooks merger", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  async function runPhaseHook(params: {
    hookName: "before_model_resolve" | "before_prompt_build";
    hooks: ReadonlyArray<{
      pluginId: string;
      result: PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult;
      priority?: number;
    }>;
  }) {
    addStaticTestHooks(registry, {
      hookName: params.hookName,
      hooks: [...params.hooks],
    });
    const runner = createHookRunner(registry);
    if (params.hookName === "before_model_resolve") {
      return await runner.runBeforeModelResolve({ prompt: "test" }, {});
    }
    return await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});
  }

  async function expectPhaseHookMerge(params: {
    hookName: "before_model_resolve" | "before_prompt_build";
    hooks: ReadonlyArray<{
      pluginId: string;
      result: PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult;
      priority?: number;
    }>;
    expected: PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult;
  }) {
    const result = await runPhaseHook(params);
    expect(result).toStrictEqual(params.expected);
  }

  it.each([
    {
      name: "before_model_resolve keeps higher-priority override values",
      hookName: "before_model_resolve" as const,
      hooks: [
        { pluginId: "low", result: { modelOverride: "demo-low-priority-model" }, priority: 1 },
        {
          pluginId: "high",
          result: {
            modelOverride: "demo-high-priority-model",
            providerOverride: "demo-provider",
          },
          priority: 10,
        },
      ],
      expected: {
        modelOverride: "demo-high-priority-model",
        providerOverride: "demo-provider",
      },
    },
    {
      name: "before_prompt_build concatenates prependContext and preserves systemPrompt precedence",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "high",
          result: { prependContext: "context A", systemPrompt: "system A" },
          priority: 10,
        },
        {
          pluginId: "low",
          result: { prependContext: "context B", systemPrompt: "system B" },
          priority: 1,
        },
      ],
      expected: {
        prependContext: "context A\n\ncontext B",
        appendContext: undefined,
        prependSystemContext: undefined,
        appendSystemContext: undefined,
        systemPrompt: "system A",
      },
    },
    {
      name: "before_prompt_build concatenates prependSystemContext and appendSystemContext",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "first",
          result: {
            prependSystemContext: "prepend A",
            appendSystemContext: "append A",
          },
          priority: 10,
        },
        {
          pluginId: "second",
          result: {
            prependSystemContext: "prepend B",
            appendSystemContext: "append B",
          },
          priority: 1,
        },
      ],
      expected: {
        systemPrompt: undefined,
        prependContext: undefined,
        appendContext: undefined,
        prependSystemContext: "prepend A\n\nprepend B",
        appendSystemContext: "append A\n\nappend B",
      },
    },
  ] as const)("$name", async ({ hookName, hooks, expected }) => {
    await expectPhaseHookMerge({ hookName, hooks, expected });
  });

  it("scopes modifying, claiming, and void agent hooks to their plugin and agent", async () => {
    const scopes: Record<
      string,
      { pluginId?: string; agentId?: string; pluginSource?: string } | undefined
    > = {};
    const captureScope = (hookName: string) => {
      const scope = getPluginRuntimeGatewayRequestScope();
      scopes[hookName] = scope
        ? {
            pluginId: scope.pluginId,
            agentId: scope.agentId,
            pluginSource: scope.pluginSource,
          }
        : undefined;
    };
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "before_prompt_build",
        pluginId: "mutator-plugin",
        priority: 10,
        handler: (_event, ctx) => {
          captureScope("mutator_plugin");
          (ctx as { agentId: string }).agentId = "spoofed";
          return {};
        },
      },
      {
        hookName: "before_prompt_build",
        pluginId: "prompt-plugin",
        handler: async () => {
          await Promise.resolve();
          captureScope("before_prompt_build");
          return {};
        },
      },
      {
        hookName: "before_agent_reply",
        pluginId: "reply-plugin",
        handler: () => {
          captureScope("before_agent_reply");
          return { handled: false };
        },
      },
      {
        hookName: "agent_end",
        pluginId: "end-plugin",
        handler: () => {
          captureScope("agent_end");
        },
      },
      {
        hookName: "subagent_spawning",
        pluginId: "spawning-plugin",
        handler: () => {
          captureScope("subagent_spawning");
          return { status: "ok" };
        },
      },
    ]);

    await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, { agentId: "codex" });
    await runner.runBeforeAgentReply({ cleanedBody: "test" }, { agentId: "codex" });
    await runner.runAgentEnd({ messages: [], success: true }, { agentId: "codex" });
    await runner.runSubagentSpawning(
      {
        childSessionKey: "child",
        agentId: "child-agent",
        mode: "run",
        threadRequested: false,
      },
      {},
    );

    expect(scopes).toEqual({
      mutator_plugin: {
        pluginId: "mutator-plugin",
        agentId: "codex",
        pluginSource: "test",
      },
      before_prompt_build: {
        pluginId: "prompt-plugin",
        agentId: "codex",
        pluginSource: "test",
      },
      before_agent_reply: {
        pluginId: "reply-plugin",
        agentId: "codex",
        pluginSource: "test",
      },
      agent_end: {
        pluginId: "end-plugin",
        agentId: "codex",
        pluginSource: "test",
      },
      subagent_spawning: {
        pluginId: "spawning-plugin",
        agentId: "child-agent",
        pluginSource: "test",
      },
    });
  });

  it("scopes specialized hook runners to their plugin and trusted agent", async () => {
    const scopes: Record<string, { pluginId?: string; agentId?: string } | undefined> = {};
    const captureScope = (hookName: string) => {
      const scope = getPluginRuntimeGatewayRequestScope();
      scopes[hookName] = scope
        ? {
            pluginId: scope.pluginId,
            agentId: scope.agentId,
          }
        : undefined;
    };
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "inbound_claim",
        pluginId: "target-plugin",
        handler: () => {
          captureScope("targeted_claim");
          return { handled: false };
        },
      },
      {
        hookName: "reply_payload_sending",
        pluginId: "payload-plugin",
        handler: () => {
          captureScope("reply_payload_sending");
        },
      },
      {
        hookName: "before_message_write",
        pluginId: "sync-plugin",
        handler: () => {
          captureScope("before_message_write");
        },
      },
      {
        hookName: "subagent_spawned",
        pluginId: "spawned-plugin",
        handler: () => {
          captureScope("subagent_spawned");
        },
      },
      {
        hookName: "cron_changed",
        pluginId: "cron-plugin",
        handler: () => {
          captureScope("cron_changed");
        },
      },
    ]);

    await runner.runInboundClaimForPluginOutcome(
      "target-plugin",
      { content: "test", channel: "test", isGroup: false },
      { channelId: "test", agentId: "codex" },
    );
    await runner.runReplyPayloadSending(
      { payload: { text: "test" }, kind: "final", usageState: { agentId: "codex" } },
      { channelId: "test" },
    );
    runner.runBeforeMessageWrite(
      { message: { role: "user", content: "test", timestamp: 1 }, agentId: "event-agent" },
      { agentId: "codex" },
    );
    await runner.runSubagentSpawned(
      {
        runId: "run-1",
        childSessionKey: "child",
        agentId: "child-agent",
        mode: "run",
        threadRequested: false,
      },
      {},
    );
    await runner.runCronChanged({ action: "started", jobId: "job-1", agentId: "cron-agent" }, {});

    expect(scopes).toEqual({
      targeted_claim: { pluginId: "target-plugin", agentId: "codex" },
      reply_payload_sending: { pluginId: "payload-plugin", agentId: "codex" },
      before_message_write: { pluginId: "sync-plugin", agentId: "codex" },
      subagent_spawned: { pluginId: "spawned-plugin", agentId: "child-agent" },
      cron_changed: { pluginId: "cron-plugin", agentId: "cron-agent" },
    });
  });

  it("uses host invocation scope for nested reply and subagent identities", async () => {
    const scopes: Record<string, { pluginId?: string; agentId?: string } | undefined> = {};
    const captureScope = (hookName: string) => {
      const scope = getPluginRuntimeGatewayRequestScope();
      scopes[hookName] = scope ? { pluginId: scope.pluginId, agentId: scope.agentId } : undefined;
    };
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "reply_dispatch",
        pluginId: "reply-plugin",
        handler: () => {
          captureScope("reply_dispatch");
          return { handled: false };
        },
      },
      {
        hookName: "message_received",
        pluginId: "message-plugin",
        handler: () => {
          captureScope("message_received");
        },
      },
      {
        hookName: "subagent_progress",
        pluginId: "progress-plugin",
        handler: () => {
          captureScope("subagent_progress");
        },
      },
    ]);

    await withPluginRuntimeGatewayRequestScope(
      { agentId: "ambient-agent", isWebchatConnect: () => false },
      async () => {
        await runner.runReplyDispatch({ ctx: { AgentId: "nested-agent" } } as never, {} as never, {
          agentId: "reply-agent",
        });
        await runner.runMessageReceived(
          { from: "user-1", content: "hello" },
          { channelId: "test", sessionKey: "agent:session-agent:main" },
          { agentId: "message-agent" },
        );
        await runner.runSubagentProgress(
          { phase: "started", runId: "run-1", childSessionKey: "agent:child:run:1" },
          { childSessionKey: "agent:child:run:1" },
          { agentId: "child-agent" },
        );
      },
    );

    expect(scopes).toEqual({
      reply_dispatch: { pluginId: "reply-plugin", agentId: "reply-agent" },
      message_received: { pluginId: "message-plugin", agentId: "message-agent" },
      subagent_progress: { pluginId: "progress-plugin", agentId: "child-agent" },
    });
  });

  it("derives hook agent scope from canonical session keys when no explicit scope is passed", async () => {
    const scopes: Record<string, { pluginId?: string; agentId?: string } | undefined> = {};
    const captureScope = (hookName: string) => {
      const scope = getPluginRuntimeGatewayRequestScope();
      scopes[hookName] = scope ? { pluginId: scope.pluginId, agentId: scope.agentId } : undefined;
    };
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "before_dispatch",
        pluginId: "dispatch-plugin",
        handler: () => {
          captureScope("before_dispatch");
          return { handled: false };
        },
      },
      {
        hookName: "message_sending",
        pluginId: "sending-plugin",
        handler: () => {
          captureScope("message_sending");
        },
      },
      {
        hookName: "message_sent",
        pluginId: "sent-plugin",
        handler: () => {
          captureScope("message_sent");
        },
      },
    ]);

    await withPluginRuntimeGatewayRequestScope(
      { agentId: "ambient-agent", isWebchatConnect: () => false },
      async () => {
        await runner.runBeforeDispatch(
          { content: "hello", sessionKey: "agent:dispatch-agent:main" } as never,
          { channelId: "test", sessionKey: "agent:dispatch-agent:main" },
        );
        await runner.runMessageSending(
          { to: "user-1", content: "hello" },
          { channelId: "test", sessionKey: "agent:sending-agent:main" },
        );
        await runner.runMessageSent(
          { to: "user-1", content: "hello", success: true },
          { channelId: "test", sessionKey: "agent:sent-agent:main" },
        );
      },
    );

    expect(scopes).toEqual({
      before_dispatch: { pluginId: "dispatch-plugin", agentId: "dispatch-agent" },
      message_sending: { pluginId: "sending-plugin", agentId: "sending-agent" },
      message_sent: { pluginId: "sent-plugin", agentId: "sent-agent" },
    });
  });

  it("preserves ambient agent scope for replay reply payload hooks", async () => {
    let captured: { pluginId?: string; agentId?: string } | undefined;
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "reply_payload_sending",
        pluginId: "payload-plugin",
        handler: () => {
          const scope = getPluginRuntimeGatewayRequestScope();
          captured = scope ? { pluginId: scope.pluginId, agentId: scope.agentId } : undefined;
        },
      },
    ]);

    await withPluginRuntimeGatewayRequestScope(
      { agentId: "replay-agent", isWebchatConnect: () => false },
      () =>
        runner.runReplyPayloadSending(
          { payload: { text: "test" }, kind: "final" },
          { channelId: "test", sessionKey: "main" },
        ),
    );

    expect(captured).toEqual({ pluginId: "payload-plugin", agentId: "replay-agent" });
  });
});
