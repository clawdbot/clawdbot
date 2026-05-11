import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { createPluginRegistry, type PluginRecord } from "../../plugins/registry.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { PluginCommandContext } from "../../plugins/types.js";
import type { MsgContext } from "../templating.js";
import { createDiagnosticsCommandHandler } from "./commands-diagnostics.js";
import type { HandleCommandsParams } from "./commands-types.js";

type ExecCall = {
  defaults: unknown;
  params: unknown;
};

type ExecDefaults = {
  accountId?: string;
  approvalFollowup?: () => Promise<string | undefined>;
  approvalFollowupMode?: string;
  approvalFollowupText?: string;
  approvalWarningText?: string;
  ask?: string;
  currentChannelId?: string;
  host?: string;
  messageProvider?: string;
  security?: string;
  trigger?: string;
};

type ExecParams = {
  ask?: string;
  command?: string;
  security?: string;
};

type DiagnosticsSession = {
  accountId?: string;
  agentHarnessId?: string;
  channel?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
};

function requireExecCall(execCalls: ExecCall[], index = 0) {
  const call = execCalls[index];
  if (!call) {
    throw new Error(`expected exec call #${index + 1}`);
  }
  return {
    defaults: call.defaults as ExecDefaults,
    params: call.params as ExecParams,
  };
}

function requireDiagnosticsSessions(call: PluginCommandContext | undefined) {
  const sessions = call?.diagnosticsSessions as DiagnosticsSession[] | undefined;
  if (!sessions) {
    throw new Error("expected diagnostics sessions");
  }
  return sessions;
}

function buildDiagnosticsParams(
  commandBodyNormalized: string,
  overrides: Partial<HandleCommandsParams> = {},
): HandleCommandsParams {
  return {
    cfg: { commands: { text: true } } as OpenClawConfig,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      AccountId: "account-1",
      MessageThreadId: "thread-1",
    } as MsgContext,
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "user-1",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
      from: "user-1",
      to: "bot",
    },
    sessionKey: "agent:main:whatsapp:direct:user-1",
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    ...overrides,
  } as HandleCommandsParams;
}

function createBundledPluginRecord(id: string): PluginRecord {
  return {
    id,
    name: id,
    source: `bundled:${id}`,
    rootDir: `/bundled/${id}`,
    origin: "bundled",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  } as PluginRecord;
}

function registerHostTrustedReservedCommandForTest(
  command: Parameters<typeof registerPluginCommand>[1],
) {
  const pluginRegistry = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: true,
  });
  pluginRegistry.registerCommand(createBundledPluginRecord(command.name), command);
}

function registerCodexDiagnosticsCommandForTest(
  handler: (ctx: PluginCommandContext) => Promise<unknown>,
) {
  const calls: PluginCommandContext[] = [];
  const commandHandler = vi.fn(async (ctx: PluginCommandContext) => {
    calls.push(ctx);
    await handler(ctx);
    if (ctx.diagnosticsPreviewOnly) {
      return {
        text: [
          "Codex runtime thread detected.",
          "Approving diagnostics will also send this thread's feedback bundle to OpenAI servers.",
          "The completed diagnostics reply will list the OpenClaw session ids and Codex thread ids that were sent.",
          "Included: Codex logs and spawned Codex subthreads when available.",
        ].join("\n"),
      };
    }
    if (ctx.diagnosticsUploadApproved) {
      return {
        text: [
          "Codex diagnostics sent to OpenAI servers:",
          "Session 1",
          "Channel: whatsapp",
          "OpenClaw session id: `session-1`",
          "Codex thread id: `codex-thread-1`",
          "Inspect locally: `codex resume codex-thread-1`",
          "Included Codex logs and spawned Codex subthreads when available.",
        ].join("\n"),
      };
    }
    return {
      text: [
        "Codex runtime thread detected.",
        "Thread: codex-thread-1",
        "To send: /codex diagnostics confirm abc123def456",
        "To cancel: /codex diagnostics cancel abc123def456",
      ].join("\n"),
      interactive: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "Send diagnostics",
                value: "/codex diagnostics confirm abc123def456",
                style: "danger" as const,
              },
              {
                label: "Cancel",
                value: "/codex diagnostics cancel abc123def456",
                style: "secondary" as const,
              },
            ],
          },
        ],
      },
    };
  });
  registerHostTrustedReservedCommandForTest({
    name: "codex",
    description: "Codex command",
    acceptsArgs: true,
    handler: commandHandler,
    ownership: "reserved",
  });
  return { calls, commandHandler };
}

function createDiagnosticsHandlerForTest(
  options: {
    privateTargets?: Array<{ channel: string; to: string; accountId?: string | null }>;
    execResult?: {
      content: Array<{ type: "text"; text: string }>;
      details?: { status: string; [key: string]: unknown };
    };
  } = {},
) {
  const execCalls: ExecCall[] = [];
  const privateReplies: Array<{
    targets: Array<{ channel: string; to: string; accountId?: string | null }>;
    text?: string;
  }> = [];
  const createExecTool = vi.fn((defaults: unknown) => ({
    execute: vi.fn(async (_toolCallId: string, params: unknown) => {
      execCalls.push({ defaults, params });
      return (
        options.execResult ?? {
          content: [
            {
              type: "text" as const,
              text: "Exec approval pending. Allowed decisions: allow-once, deny.",
            },
          ],
          details: {
            status: "approval-pending" as const,
            approvalId: "approval-1",
            approvalSlug: "diag-approval",
            expiresAtMs: Date.now() + 60_000,
            allowedDecisions: ["allow-once", "deny"] as const,
            host: "gateway" as const,
            command: "openclaw gateway diagnostics export --json",
            cwd: "/tmp",
          },
        }
      );
    }),
  }));
  return {
    execCalls,
    privateReplies,
    handleDiagnosticsCommand: createDiagnosticsCommandHandler({
      createExecTool: createExecTool as never,
      resolvePrivateDiagnosticsTargets: vi.fn(async () => options.privateTargets ?? []),
      deliverPrivateDiagnosticsReply: vi.fn(async ({ targets, reply }) => {
        privateReplies.push({ targets, text: reply.text });
        return true;
      }),
    }),
  };
}

afterEach(() => {
  clearPluginCommands();
});

describe("diagnostics command", () => {
  it("requests Gateway diagnostics approval without a duplicate pending chat reply", async () => {
    const { execCalls, handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const result = await handleDiagnosticsCommand(buildDiagnosticsParams("/diagnostics"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(execCalls).toHaveLength(1);
    const execCall = requireExecCall(execCalls);
    expect(execCall.defaults.host).toBe("gateway");
    expect(execCall.defaults.security).toBe("allowlist");
    expect(execCall.defaults.ask).toBe("always");
    expect(execCall.defaults.trigger).toBe("diagnostics");
    expect(execCall.defaults.approvalFollowupMode).toBe("direct");
    expect(execCall.defaults.approvalWarningText).toContain(
      "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    );
    expect(execCall.defaults.approvalWarningText).toContain(
      "https://docs.openclaw.ai/gateway/diagnostics",
    );
    expect(execCall.params.security).toBe("allowlist");
    expect(execCall.params.ask).toBe("always");
    const command = execCall.params.command ?? "";
    expect(command).toContain("gateway");
    expect(command).toContain("diagnostics");
    expect(command).toContain("export");
    expect(command).toContain("--json");
    expect(command).not.toBe("openclaw gateway diagnostics export --json");
  });

  it("uses the originating Telegram route for native diagnostics followups", async () => {
    const { execCalls, handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const params = buildDiagnosticsParams("/diagnostics", {
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:8460800771",
        From: "telegram:8460800771",
        To: "slash:8460800771",
        CommandSource: "native",
        AccountId: "account-1",
      } as MsgContext,
      command: {
        commandBodyNormalized: "/diagnostics",
        isAuthorizedSender: true,
        senderIsOwner: true,
        senderId: "8460800771",
        channel: "telegram",
        channelId: "telegram",
        surface: "telegram",
        ownerList: [],
        rawBodyNormalized: "/diagnostics",
        from: "telegram:8460800771",
        to: "slash:8460800771",
      },
      sessionKey: "agent:main:telegram:slash:8460800771",
    });

    await handleDiagnosticsCommand(params, true);

    expect(execCalls).toHaveLength(1);
    const execCall = requireExecCall(execCalls);
    expect(execCall.defaults.messageProvider).toBe("telegram");
    expect(execCall.defaults.currentChannelId).toBe("telegram:8460800771");
    expect(execCall.defaults.accountId).toBe("account-1");
  });

  it("falls back to a visible reply when approval cannot be queued", async () => {
    const { execCalls, handleDiagnosticsCommand } = createDiagnosticsHandlerForTest({
      execResult: {
        content: [
          {
            type: "text",
            text: "Exec approval is required, but no interactive approval client is currently available.",
          },
        ],
        details: {
          status: "approval-unavailable",
          reason: "no-approval-route",
        },
      },
    });
    const result = await handleDiagnosticsCommand(buildDiagnosticsParams("/diagnostics"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(
      "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    );
    expect(result?.reply?.text).toContain("https://docs.openclaw.ai/gateway/diagnostics");
    expect(result?.reply?.text).toContain("no interactive approval client");
    expect(execCalls).toHaveLength(1);
  });

  it("wraps Codex feedback upload into the Gateway diagnostics approval", async () => {
    const { calls } = registerCodexDiagnosticsCommandForTest(async () => null);
    const { execCalls, handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics flaky tool call", {
        sessionEntry: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          updatedAt: 1,
          agentHarnessId: "codex",
        },
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toBe("diagnostics flaky tool call");
    expect(calls[0]?.diagnosticsPreviewOnly).toBe(true);
    expect(calls[0]?.senderIsOwner).toBe(true);
    expect(calls[0]?.sessionFile).toBe("/tmp/session.jsonl");
    const diagnosticsSessions = requireDiagnosticsSessions(calls[0]);
    expect(diagnosticsSessions).toHaveLength(1);
    expect(diagnosticsSessions[0]?.agentHarnessId).toBe("codex");
    expect(diagnosticsSessions[0]?.sessionId).toBe("session-1");
    expect(diagnosticsSessions[0]?.sessionFile).toBe("/tmp/session.jsonl");
    expect(diagnosticsSessions[0]?.channel).toBe("whatsapp");
    expect(diagnosticsSessions[0]?.accountId).toBe("account-1");
    const { defaults } = requireExecCall(execCalls);
    expect(defaults.approvalWarningText).toContain("OpenAI Codex harness:");
    expect(defaults.approvalWarningText).toContain(
      "Approving diagnostics will also send this thread's feedback bundle to OpenAI servers.",
    );
    expect(defaults.approvalWarningText).not.toContain("To send:");
    expect(defaults.approvalWarningText).not.toContain("/codex diagnostics confirm");
    expect(defaults.approvalFollowupText).toBeUndefined();

    await expect(defaults.approvalFollowup?.()).resolves.toContain(
      "Codex diagnostics sent to OpenAI servers:",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.diagnosticsUploadApproved).toBe(true);
  });

  it("passes sidecar-bound session files to Codex diagnostics even when harness metadata is stale", async () => {
    const { calls } = registerCodexDiagnosticsCommandForTest(async () => null);
    const { execCalls, handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics", {
        sessionKey: "agent:main:telegram:direct:user-1",
        sessionEntry: {
          sessionId: "telegram-session",
          sessionFile: "/tmp/telegram.jsonl",
          updatedAt: 1,
        },
        sessionStore: {
          "agent:main:telegram:direct:user-1": {
            sessionId: "telegram-session",
            sessionFile: "/tmp/telegram.jsonl",
            updatedAt: 1,
          },
          "agent:main:discord:channel:123": {
            sessionId: "discord-session",
            sessionFile: "/tmp/discord.jsonl",
            updatedAt: 2,
            channel: "discord",
          },
        },
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(calls).toHaveLength(1);
    const diagnosticsSessions = requireDiagnosticsSessions(calls[0]);
    expect(diagnosticsSessions).toHaveLength(2);
    expect(diagnosticsSessions[0]?.sessionKey).toBe("agent:main:telegram:direct:user-1");
    expect(diagnosticsSessions[0]?.sessionId).toBe("telegram-session");
    expect(diagnosticsSessions[0]?.sessionFile).toBe("/tmp/telegram.jsonl");
    expect(diagnosticsSessions[0]?.channel).toBe("whatsapp");
    expect(diagnosticsSessions[1]?.sessionKey).toBe("agent:main:discord:channel:123");
    expect(diagnosticsSessions[1]?.sessionId).toBe("discord-session");
    expect(diagnosticsSessions[1]?.sessionFile).toBe("/tmp/discord.jsonl");
    expect(diagnosticsSessions[1]?.channel).toBe("discord");
    expect(requireExecCall(execCalls).defaults.approvalWarningText).toContain(
      "OpenAI Codex harness:",
    );
  });

  it("omits the Codex section for ordinary sessions without Codex targets", async () => {
    registerHostTrustedReservedCommandForTest({
      name: "codex",
      description: "Codex command",
      acceptsArgs: true,
      ownership: "reserved",
      handler: vi.fn(async () => ({
        text: [
          "No Codex thread is attached to this OpenClaw session yet.",
          "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
        ].join("\n"),
      })),
    });
    const { execCalls, handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();

    await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics", {
        sessionEntry: {
          sessionId: "ordinary-session",
          sessionFile: "/tmp/ordinary.jsonl",
          updatedAt: 1,
        },
      }),
      true,
    );

    expect(requireExecCall(execCalls).defaults.approvalWarningText).not.toContain(
      "OpenAI Codex harness:",
    );
  });

  it("routes group diagnostics details privately before starting collection", async () => {
    const { calls } = registerCodexDiagnosticsCommandForTest(async () => null);
    const { execCalls, privateReplies, handleDiagnosticsCommand } = createDiagnosticsHandlerForTest(
      {
        privateTargets: [
          { channel: "telegram", to: "owner-dm", accountId: "account-1" },
          { channel: "whatsapp", to: "backup-owner-dm", accountId: "account-2" },
        ],
      },
    );

    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics flaky tool call", {
        isGroup: true,
        sessionEntry: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          updatedAt: 1,
          agentHarnessId: "codex",
        },
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe(
      "Diagnostics are sensitive. I sent the diagnostics details and approval prompts to the owner privately.",
    );
    expect(result?.reply?.text).not.toContain("codex-thread-1");
    expect(privateReplies).toHaveLength(0);
    expect(execCalls).toHaveLength(1);
    const { defaults } = requireExecCall(execCalls);
    expect(defaults.messageProvider).toBe("telegram");
    expect(defaults.currentChannelId).toBe("owner-dm");
    expect(defaults.accountId).toBe("account-1");
    expect(defaults.approvalWarningText).toContain(
      "Approving diagnostics will also send this thread's feedback bundle",
    );
    expect(defaults.approvalWarningText).not.toContain("To send:");
    expect(calls[0]?.diagnosticsPrivateRouted).toBe(true);
  });

  it("fails closed in groups when no private diagnostics route is available", async () => {
    registerCodexDiagnosticsCommandForTest(async () => null);
    const { execCalls, privateReplies, handleDiagnosticsCommand } =
      createDiagnosticsHandlerForTest();

    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics", {
        isGroup: true,
        sessionEntry: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          updatedAt: 1,
          agentHarnessId: "codex",
        },
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Run /diagnostics from an owner DM");
    expect(execCalls).toHaveLength(0);
    expect(privateReplies).toHaveLength(0);
  });

  it("routes group diagnostics confirmations privately", async () => {
    const commandHandler = vi.fn(async () => ({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        "- channel whatsapp, OpenClaw session session-1, Codex thread codex-thread-1",
      ].join("\n"),
    }));
    registerHostTrustedReservedCommandForTest({
      name: "codex",
      description: "Codex command",
      acceptsArgs: true,
      handler: commandHandler,
      ownership: "reserved",
    });
    const { privateReplies, handleDiagnosticsCommand } = createDiagnosticsHandlerForTest({
      privateTargets: [
        { channel: "telegram", to: "owner-dm", accountId: "account-1" },
        { channel: "whatsapp", to: "backup-owner-dm", accountId: "account-2" },
      ],
    });

    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics confirm abc123def456", { isGroup: true }),
      true,
    );

    expect(result?.reply?.text).toBe(
      "Diagnostics are sensitive. I sent the diagnostics details and approval prompts to the owner privately.",
    );
    expect(privateReplies).toHaveLength(1);
    expect(privateReplies[0]?.targets).toEqual([
      { channel: "telegram", to: "owner-dm", accountId: "account-1" },
    ]);
    expect(privateReplies[0]?.text).toContain("Codex diagnostics sent to OpenAI servers:");
    expect(privateReplies[0]?.text).toContain("codex-thread-1");
  });

  it("requires an owner for diagnostics", async () => {
    const { handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics", {
        command: {
          ...buildDiagnosticsParams("/diagnostics").command,
          senderIsOwner: false,
        },
      }),
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
  });

  it("routes confirmations back to the Codex diagnostics handler without repeating the preamble", async () => {
    const { handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const commandHandler = vi.fn(async (ctx: PluginCommandContext) => ({
      text: `confirmed ${ctx.args}`,
    }));
    registerHostTrustedReservedCommandForTest({
      name: "codex",
      description: "Codex command",
      acceptsArgs: true,
      handler: commandHandler,
      ownership: "reserved",
    });

    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics confirm abc123def456"),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(result?.reply?.text).toBe("confirmed diagnostics confirm abc123def456");
  });

  it("does not delegate diagnostics to a non-Codex plugin command", async () => {
    const { handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const commandHandler = vi.fn(async () => ({ text: "wrong codex" }));
    registerPluginCommand(
      "third-party",
      {
        name: "codex",
        description: "Fake Codex command",
        acceptsArgs: true,
        handler: commandHandler,
      },
      { allowReservedCommandNames: true },
    );

    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics confirm abc123def456"),
      true,
    );

    expect(result?.reply?.text).toBe(
      "No Codex diagnostics confirmation handler is available for this session.",
    );
    expect(commandHandler).not.toHaveBeenCalled();
  });
});
