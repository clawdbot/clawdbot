import { PROTOCOL_VERSION, RequestError, type AgentSideConnection } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "../agents/bash-tools.exec-approval-request.js";
import type { AgentCommandIngressOpts } from "../agents/command/types.js";
import { runWithLocalExecApprovalHandler } from "../agents/local-exec-approval-broker.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getEmbeddedPluginApprovalBroker } from "../infra/embedded-plugin-approval-broker.js";
import { PLUGIN_APPROVAL_DETAIL_MAX_LENGTH } from "../infra/plugin-approvals.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import { AcpNativeAgent } from "./native-agent.js";

function createHarness(
  executeAgent: (...args: never[]) => Promise<unknown>,
  requestPermission = vi.fn(async () => ({
    outcome: { outcome: "selected" as const, optionId: "allow-once" },
  })),
  deps: {
    sessionCreateRateLimit?: {
      maxRequests?: number;
      windowMs?: number;
    };
    abortSettleTimeoutMs?: number;
  } = {},
) {
  const updates: unknown[] = [];
  let listener: ((event: AgentEventPayload) => void) | undefined;
  const connection = {
    requestPermission,
    sessionUpdate: vi.fn(async (update: unknown) => {
      updates.push(update);
    }),
  } as unknown as AgentSideConnection;
  let id = 0;
  const agent = new AcpNativeAgent(connection, {
    executeAgent: executeAgent as never,
    createId: () => `id-${++id}`,
    resolveAgentId: () => "main",
    subscribeAgentEvents: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    ...deps,
  });
  agent.start();
  return {
    agent,
    connection,
    requestPermission,
    updates,
    emit: (event: AgentEventPayload) => listener?.(event),
  };
}

afterEach(() => {
  delete process.env.BUZZ_PRIVATE_KEY;
});

describe("AcpNativeAgent", () => {
  it("runs the canonical agent in-process with the inherited environment", async () => {
    process.env.BUZZ_PRIVATE_KEY = "test-buzz-key";
    const harnessRef: { current?: ReturnType<typeof createHarness> } = {};
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      expect(process.env.BUZZ_PRIVATE_KEY).toBe("test-buzz-key");
      harnessRef.current?.emit({
        runId: opts.runId,
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { delta: "raw internal stream" },
      });
      return {
        payloads: [{ text: "fallback reply" }],
        meta: { finalAssistantVisibleText: "[[reply_to_current]]local reply" },
      };
    });
    const harness = createHarness(executeAgent);
    harnessRef.current = harness;

    expect(
      harness.agent.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    ).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    });
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await expect(
      harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "reply through Buzz" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });

    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "reply through Buzz",
        sessionKey: `agent:main:native-acp:${session.sessionId}`,
        cwd: "/tmp/project",
        deliver: false,
        senderIsOwner: false,
        allowModelOverride: false,
        channel: "webchat",
      }),
      expect.any(Object),
    );
    const ingress = executeAgent.mock.calls[0]?.[0] as AgentCommandIngressOpts;
    expect(isAcpSessionKey(ingress.sessionKey)).toBe(false);
    expect(harness.updates).toContainEqual({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "local reply" },
      },
    });
    expect(JSON.stringify(harness.updates)).not.toContain("raw internal stream");
    await harness.agent.shutdown();
    expect(isEmbeddedMode()).toBe(false);
  });

  it("suppresses silent replies and rejects failed agent results", async () => {
    const silentHarness = createHarness(
      vi.fn(async () => ({
        payloads: [{ text: "fallback must not leak" }],
        meta: { finalAssistantVisibleText: "NO_REPLY" },
      })),
    );
    const silentSession = silentHarness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await expect(
      silentHarness.agent.prompt({
        sessionId: silentSession.sessionId,
        prompt: [{ type: "text", text: "stay silent" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(silentHarness.updates).toEqual([]);
    await silentHarness.agent.shutdown();

    const failedHarness = createHarness(
      vi.fn(async () => ({
        payloads: [{ text: "provider exploded", isError: true }],
        meta: { stopReason: "error", error: { message: "provider exploded" } },
      })),
    );
    const failedSession = failedHarness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    const failure = await failedHarness.agent
      .prompt({
        sessionId: failedSession.sessionId,
        prompt: [{ type: "text", text: "fail" }],
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RequestError);
    expect(failure).toMatchObject({
      code: -32603,
      data: { kind: "agent_execution_failed" },
    });
    expect((failure as Error).message).toContain("agent prompt failed: provider exploded");
    expect(failedHarness.updates).toEqual([]);
    await failedHarness.agent.shutdown();
  });

  it("redacts and bounds native prompt failures before returning them over ACP", async () => {
    const secret = `sk-${"a".repeat(48)}`; // pragma: allowlist secret
    const harness = createHarness(
      vi.fn(async () => {
        throw new Error(`provider\u001b[2K failed with token ${secret} ${"x".repeat(2_000)}`);
      }),
    );
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    const failure = await harness.agent
      .prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "fail safely" }],
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RequestError);
    expect((failure as RequestError).code).toBe(-32603);
    expect((failure as Error).message).toContain("agent prompt failed: provider failed");
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).message).not.toContain("\u001b");
    expect((failure as Error).message.length).toBeLessThanOrEqual(1_100);
    await harness.agent.shutdown();
  });

  it("advertises model setup to ACP clients with terminal authentication", async () => {
    const harness = createHarness(vi.fn(async () => ({ payloads: [], meta: {} })));

    expect(
      harness.agent.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      }),
    ).toMatchObject({
      authMethods: [
        {
          id: "openclaw-model-setup",
          type: "terminal",
          args: ["--configure-model"],
        },
      ],
    });

    await harness.agent.shutdown();
  });

  it("relays exec approvals through ACP instead of calling a Gateway", async () => {
    const commandSecret = "sk-abcdefghijklmnopqrstuv"; // pragma: allowlist secret
    const executeAgent = vi.fn(
      async (opts: AgentCommandIngressOpts) =>
        await runWithLocalExecApprovalHandler({
          handler: opts.localExecApprovalHandler,
          signal: opts.abortSignal,
          run: async () => {
            const registration = await registerExecApprovalRequestForHostOrThrow({
              approvalId: "approval-1",
              command: `buzz messages send --token ${commandSecret} --message hello`,
              env: { BUZZ_PRIVATE_KEY: "must-not-leak" },
              workdir: "/tmp/project",
              host: "gateway",
              security: "allowlist",
              ask: "always",
              commandHighlighting: false,
            });
            const decision = await resolveRegisteredExecApprovalDecision({
              approvalId: registration.id,
              preResolvedDecision: registration.finalDecision,
            });
            return { payloads: [{ text: decision }], meta: {} };
          },
        }),
    );
    const harness = createHarness(executeAgent);
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "send a reply" }],
    });

    expect(harness.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        toolCall: expect.objectContaining({
          kind: "execute",
          rawInput: expect.objectContaining({
            command: expect.stringContaining("buzz messages send"),
          }),
        }),
      }),
    );
    expect(JSON.stringify(harness.requestPermission.mock.calls)).not.toContain(commandSecret);
    expect(JSON.stringify(harness.requestPermission.mock.calls)).not.toContain("must-not-leak");
    await harness.agent.shutdown();
  });

  it("projects plugin approvals through the canonical safe presentation", async () => {
    const secret = `ghp_${"a".repeat(100)}`; // pragma: allowlist secret
    let decision: string | null | undefined;
    const executeAgent = vi.fn(async (opts: AgentCommandIngressOpts) => {
      await Promise.resolve();
      const broker = getEmbeddedPluginApprovalBroker();
      if (!broker) {
        throw new Error("expected embedded plugin approval broker");
      }
      decision = (
        await broker.request({
          runId: opts.runId,
          request: {
            title: `Deploy\u202Eprod ${secret}`,
            description: `Review\u0000\n${secret}`,
            detail: `${"x".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH + 1)}\u202E`,
            pluginId: `plugin\u202E${secret}`,
            toolName: `tool\n${secret}`,
            toolCallId: "plugin-tool-1",
          },
          timeoutMs: 1_000,
          signal: opts.abortSignal,
        })
      ).decision;
      return { payloads: [], meta: {} };
    });
    const harness = createHarness(executeAgent);
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "run plugin tool" }],
    });

    expect(decision).toBe("allow-once");
    const serialized = JSON.stringify(harness.requestPermission.mock.calls);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("\u202E");
    expect(serialized).not.toContain("\u0000");
    expect(serialized).toContain("\\\\u{202E}");
    expect(serialized).toContain("[truncated]");
    await harness.agent.shutdown();
  });

  it("denies plugin approvals that exceed canonical presentation limits", async () => {
    let decision: string | null | undefined;
    const executeAgent = vi.fn(async (opts: AgentCommandIngressOpts) => {
      await Promise.resolve();
      const broker = getEmbeddedPluginApprovalBroker();
      if (!broker) {
        throw new Error("expected embedded plugin approval broker");
      }
      decision = (
        await broker.request({
          runId: opts.runId,
          request: {
            title: "x".repeat(81),
            description: "bounded description",
          },
          timeoutMs: 1_000,
          signal: opts.abortSignal,
        })
      ).decision;
      return { payloads: [], meta: {} };
    });
    const harness = createHarness(executeAgent);
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "run oversized plugin tool" }],
    });

    expect(decision).toBe("deny");
    expect(harness.requestPermission).not.toHaveBeenCalled();
    await harness.agent.shutdown();
  });

  it("denies plugin approvals retained from an earlier native run", async () => {
    const runIds: string[] = [];
    let releaseSecond: (() => void) | undefined;
    const executeAgent = vi.fn(async (opts: AgentCommandIngressOpts) => {
      runIds.push(opts.runId ?? "");
      if (runIds.length === 2) {
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
      }
      return { payloads: [], meta: {} };
    });
    const harness = createHarness(executeAgent);
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "first" }],
    });
    const second = harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "second" }],
    });
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledTimes(2));
    const broker = getEmbeddedPluginApprovalBroker();
    if (!broker) {
      throw new Error("expected embedded plugin approval broker");
    }

    await expect(
      broker.request({
        runId: runIds[0],
        request: {
          title: "stale approval",
          description: "must not reach the host",
          sessionKey: `agent:main:acp:${session.sessionId}`,
        },
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    expect(harness.requestPermission).not.toHaveBeenCalled();

    releaseSecond?.();
    await second;
    await harness.agent.shutdown();
  });

  it("cancels an active prompt and closes its session deterministically", async () => {
    const executeAgent = vi.fn(
      async (opts: { abortSignal?: AbortSignal }) =>
        await new Promise((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => resolve({ payloads: [], meta: {} }), {
            once: true,
          });
        }),
    );
    const harness = createHarness(executeAgent);
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    const prompt = harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledOnce());

    harness.agent.cancel({ sessionId: session.sessionId });

    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    await expect(harness.agent.closeSession({ sessionId: session.sessionId })).resolves.toEqual({});
    await expect(
      harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "again" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await harness.agent.shutdown();
  });

  it.each(["close", "shutdown"] as const)(
    "does not start a queued prompt after session %s teardown begins",
    async (teardown) => {
      let releaseFirst: (() => void) | undefined;
      const executeAgent = vi.fn(
        async () =>
          await new Promise<{ payloads: never[]; meta: Record<string, never> }>((resolve) => {
            releaseFirst = () => resolve({ payloads: [], meta: {} });
          }),
      );
      const harness = createHarness(executeAgent);
      const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
      const first = harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "first" }],
      });
      await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledOnce());

      const second = harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "second" }],
      });
      const secondResult = expect(second).rejects.toMatchObject({ code: -32602 });
      const teardownResult =
        teardown === "close"
          ? harness.agent.closeSession({ sessionId: session.sessionId })
          : harness.agent.shutdown();

      releaseFirst?.();

      await expect(first).resolves.toEqual({ stopReason: "cancelled" });
      await secondResult;
      await teardownResult;
      expect(executeAgent).toHaveBeenCalledTimes(1);
      if (teardown === "close") {
        await harness.agent.shutdown();
      }
    },
  );

  it("bounds prompt replacement when the superseded executor ignores abort", async () => {
    const executeAgent = vi.fn(async () => await new Promise<never>(() => {}));
    const harness = createHarness(executeAgent, undefined, { abortSettleTimeoutMs: 5 });
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    void harness.agent
      .prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "first" }],
      })
      .catch(() => {});
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledOnce());

    await expect(
      harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "replacement" }],
      }),
    ).resolves.toEqual({ stopReason: "cancelled" });
    expect(executeAgent).toHaveBeenCalledOnce();
    await harness.agent.shutdown();
  });

  it.each(["cancel", "close"] as const)(
    "drops late thought events after native session %s",
    async (teardown) => {
      let runId = "";
      const executeAgent = vi.fn(async (opts: AgentCommandIngressOpts) => {
        runId = opts.runId ?? "";
        return await new Promise<never>(() => {});
      });
      const harness = createHarness(executeAgent, undefined, { abortSettleTimeoutMs: 5 });
      const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
      void harness.agent
        .prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "wait" }],
        })
        .catch(() => {});
      await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledOnce());

      if (teardown === "cancel") {
        harness.agent.cancel({ sessionId: session.sessionId });
      } else {
        await harness.agent.closeSession({ sessionId: session.sessionId });
      }
      harness.emit({
        runId,
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { delta: "late thought" },
      });
      await Promise.resolve();

      expect(harness.updates).toEqual([]);
      await harness.agent.shutdown();
    },
  );

  it.each(["close", "shutdown"] as const)(
    "bounds session %s when the executor ignores abort",
    async (teardown) => {
      const executeAgent = vi.fn(async () => await new Promise<never>(() => {}));
      const harness = createHarness(executeAgent, undefined, { abortSettleTimeoutMs: 5 });
      const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
      void harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "wait forever" }],
      });
      await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledOnce());

      const teardownResult =
        teardown === "close"
          ? harness.agent.closeSession({ sessionId: session.sessionId })
          : harness.agent.shutdown();

      await expect(teardownResult).resolves.toEqual(teardown === "close" ? {} : undefined);
      if (teardown === "close") {
        await harness.agent.shutdown();
      }
    },
  );

  it("rate limits excessive native session creation bursts", async () => {
    const harness = createHarness(
      vi.fn(async () => ({ payloads: [], meta: {} })),
      undefined,
      {
        sessionCreateRateLimit: {
          maxRequests: 1,
          windowMs: 60_000,
        },
      },
    );

    expect(() => harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] })).not.toThrow();
    expect(() => harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] })).toThrow(
      /session creation rate limit exceeded/i,
    );

    await harness.agent.shutdown();
  });

  it("rejects unsupported client-owned runtime surfaces", async () => {
    const harness = createHarness(vi.fn(async () => ({ payloads: [], meta: {} })));

    expect(() =>
      harness.agent.newSession({
        cwd: "relative",
        mcpServers: [],
      }),
    ).toThrow("cwd must be an absolute path");
    expect(() =>
      harness.agent.newSession({
        cwd: "/tmp/project",
        mcpServers: [{ name: "extra", command: "server", args: [], env: [] }],
      }),
    ).toThrow("client-supplied MCP servers are not supported");
    await harness.agent.shutdown();
  });
});
