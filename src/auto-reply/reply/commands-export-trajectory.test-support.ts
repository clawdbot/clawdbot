// Tests trajectory export command approval routing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ExecToolDetails } from "../../agents/bash-tools.js";
import { buildExportTrajectoryCommandReply } from "./commands-export-trajectory.js";
import type {
  deliverPrivateCommandReply,
  resolvePrivateCommandRouteTargets,
} from "./commands-private-route.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const commandMocks = vi.hoisted(() => ({
  createExecTool: vi.fn(),
  resolvePrivateCommandRouteTargets: vi.fn<typeof resolvePrivateCommandRouteTargets>(),
  deliverPrivateCommandReply: vi.fn<typeof deliverPrivateCommandReply>(),
}));

vi.mock("../../agents/bash-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/bash-tools.js")>()),
  createExecTool: commandMocks.createExecTool,
}));

vi.mock("./commands-private-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands-private-route.js")>()),
  resolvePrivateCommandRouteTargets: commandMocks.resolvePrivateCommandRouteTargets,
  deliverPrivateCommandReply: commandMocks.deliverPrivateCommandReply,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeParams(
  workspaceDir = tempDirs.make("openclaw-export-command-"),
): HandleCommandsParams {
  return {
    cfg: {
      session: {
        store: "/tmp/openclaw-sessions.json",
      },
    },
    ctx: {
      SessionKey: "agent:main:slash-session",
      AccountId: "account-1",
    },
    command: {
      commandBodyNormalized: "/export-trajectory",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "sender-1",
      channel: "quietchat",
      surface: "quietchat",
      ownerList: [],
      rawBodyNormalized: "/export-trajectory",
      from: "sender-1",
      to: "bot",
    },
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: 1,
    },
    sessionKey: "agent:target:session",
    agentId: "target",
    workspaceDir,
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  };
}

function mockCommandBoundaries(
  options: {
    privateTargets?: Awaited<ReturnType<typeof resolvePrivateCommandRouteTargets>>;
    result?: { content?: Array<{ type: string; text?: string }>; details?: ExecToolDetails };
    deliveryOutcome?: Awaited<ReturnType<typeof deliverPrivateCommandReply>>;
  } = {},
) {
  const execCalls: Array<{ defaults: unknown; params: unknown }> = [];
  const privateReplies: Array<{
    targets: Array<{ channel: string; to: string; accountId?: string | null }>;
    text?: string;
  }> = [];
  commandMocks.createExecTool.mockImplementation((defaults: unknown) => ({
    execute: vi.fn(async (_toolCallId: string, params: unknown) => {
      execCalls.push({ defaults, params });
      return (
        options.result ?? {
          details: {
            status: "approval-pending" as const,
            approvalId: "approval-1",
            approvalSlug: "traj-approval",
            expiresAtMs: Date.now() + 60_000,
            allowedDecisions: ["allow-once", "deny"] as const,
            host: "gateway" as const,
            command: "openclaw sessions export-trajectory --session-key agent:target:session",
            cwd: "/tmp",
          },
        }
      );
    }),
  }));
  commandMocks.resolvePrivateCommandRouteTargets.mockResolvedValue(options.privateTargets ?? []);
  commandMocks.deliverPrivateCommandReply.mockImplementation(async ({ targets, reply }) => {
    privateReplies.push({ targets, text: reply.text });
    return options.deliveryOutcome ?? "delivered";
  });
  return { execCalls, privateReplies };
}

function readEncodedRequestFromCommand(command: string): Record<string, unknown> {
  const match = command.match(/'?--request-json-base64'?\s+'?([A-Za-z0-9_-]+)'?/u);
  const encoded = match?.[1];
  if (encoded === undefined) {
    throw new Error("expected encoded export request");
  }
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value) {
    throw new Error("expected record");
  }
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function execCallRecord(
  execCalls: Array<{ defaults: unknown; params: unknown }>,
  index = 0,
): { defaults: Record<string, unknown>; params: Record<string, unknown> } {
  const call = execCalls[index];
  if (!call) {
    throw new Error(`expected exec call at index ${index}`);
  }
  return {
    defaults: requireRecord(call.defaults),
    params: requireRecord(call.params),
  };
}

describe("buildExportTrajectoryCommandReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests per-run exec approval for trajectory exports", async () => {
    const { execCalls } = mockCommandBoundaries();
    const params = makeParams();

    const reply = await buildExportTrajectoryCommandReply(params);

    expect(reply.text).toContain(
      "Trajectory exports can include prompts, model messages, tool schemas",
    );
    expect(reply.text).toContain("https://docs.openclaw.ai/tools/trajectory");
    expect(reply.text).toContain("do not use allow-all");
    expect(reply.text).toContain("Allowed decisions: allow-once, deny");
    expect(execCalls).toHaveLength(1);
    const execCall = execCallRecord(execCalls);
    expect(execCall.defaults.host).toBe("gateway");
    expect(execCall.defaults.security).toBe("allowlist");
    expect(execCall.defaults.ask).toBe("always");
    expect(execCall.defaults.trigger).toBe("export-trajectory");
    expect(execCall.defaults.approvalFollowupMode).toBe("agent");
    expect(execCall.defaults.sessionId).toBe("session-1");
    expect(execCall.defaults.sessionStore).toBe("/tmp/openclaw-sessions.json");
    expect(execCall.defaults.currentChannelId).toBe("bot");
    expect(execCall.defaults.accountId).toBe("account-1");
    expect(execCall.params.ask).toBe("always");
    expect(execCall.params.background).toBe(true);
    const command = typeof execCall.params.command === "string" ? execCall.params.command : "";
    expect(command).toContain("sessions");
    expect(command).toContain("export-trajectory");
    expect(command).toContain("--request-json-base64");
    expect(command).toContain("--json");
    expect(command).not.toContain("--session-key");
    expect(command).not.toContain("openclaw sessions export-trajectory");
    const request = readEncodedRequestFromCommand(command);
    expect(request.sessionKey).toBe("agent:target:session");
    expect(request.workspace).toBe(params.workspaceDir);
    expect(String(request.workspace)).toContain("openclaw-export-command-");
  });

  it.each([
    {
      label: "running export",
      result: { details: { status: "running" as const, sessionId: "export-1", startedAt: 1 } },
      text: "Trajectory export is running (exec session export-1).",
    },
    {
      label: "completed output",
      result: {
        details: {
          status: "completed" as const,
          exitCode: 0,
          durationMs: 1,
          aggregated: "  bundle.zip\n",
        },
      },
      text: "bundle.zip",
    },
    {
      label: "empty failed output",
      result: {
        details: { status: "failed" as const, exitCode: 1, durationMs: 1, aggregated: "  " },
      },
      text: "(no exec output)",
    },
    {
      label: "text content ahead of status details",
      result: {
        content: [
          { type: "text", text: "  first " },
          { type: "image" },
          { type: "text", text: "second  " },
        ],
        details: { status: "running" as const, sessionId: "export-1", startedAt: 1 },
      },
      text: "first \nsecond",
    },
    { label: "missing details", result: {}, text: "(no exec details returned)" },
  ])("reports $label to the owner", async ({ result, text }) => {
    mockCommandBoundaries({ result });
    const reply = await buildExportTrajectoryCommandReply(makeParams());
    expect(reply.text?.endsWith(text)).toBe(true);
  });

  it("uses the originating Telegram route for native trajectory export followups", async () => {
    const { execCalls } = mockCommandBoundaries();
    const params = makeParams();
    params.ctx = {
      ...params.ctx,
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:8460800771",
      From: "telegram:8460800771",
      To: "slash:8460800771",
      CommandSource: "native",
    };
    params.command = {
      ...params.command,
      channel: "telegram",
      surface: "telegram",
      from: "telegram:8460800771",
      to: "slash:8460800771",
    };

    await buildExportTrajectoryCommandReply(params);

    expect(execCalls).toHaveLength(1);
    const execCall = execCallRecord(execCalls);
    expect(execCall.defaults.messageProvider).toBe("telegram");
    expect(execCall.defaults.currentChannelId).toBe("telegram:8460800771");
    expect(execCall.defaults.accountId).toBe("account-1");
  });

  it("keeps user-controlled export values out of the shell command", async () => {
    const { execCalls } = mockCommandBoundaries();
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory bad'; Invoke-Expression evil ;'";

    await buildExportTrajectoryCommandReply(params);

    const commandValue = execCallRecord(execCalls).params.command;
    const command = typeof commandValue === "string" ? commandValue : "";
    expect(command).toMatch(/'?sessions'?\s+'?export-trajectory'?/u);
    expect(command).toMatch(/'?--request-json-base64'?\s+'?[A-Za-z0-9_-]+'?/u);
    expect(command).toMatch(/'?--json'?$/u);
    expect(command).not.toContain("Invoke-Expression");
    expect(readEncodedRequestFromCommand(command).output).toBe("bad';");
  });

  it("rejects oversized output paths before requesting exec approval", async () => {
    const { execCalls } = mockCommandBoundaries();
    const params = makeParams();
    params.command.commandBodyNormalized = `/export-trajectory ${"a".repeat(513)}`;

    const reply = await buildExportTrajectoryCommandReply(params);

    expect(reply.text).toContain("Output path is too long");
    expect(execCalls).toHaveLength(0);
  });

  it("rejects oversized encoded export requests before requesting exec approval", async () => {
    const { execCalls } = mockCommandBoundaries();
    const params = makeParams();
    params.workspaceDir = `/${"workspace".repeat(1200)}`;

    const reply = await buildExportTrajectoryCommandReply(params);

    expect(reply.text).toContain("Encoded trajectory export request is too large");
    expect(execCalls).toHaveLength(0);
  });

  it.each([
    {
      outcome: "delivered",
      acknowledgement: "I sent the trajectory export details to the owner privately",
    },
    {
      outcome: "pending",
      acknowledgement:
        "Private delivery of the export request is pending; I can't confirm receipt yet",
    },
    {
      outcome: "suppressed",
      acknowledgement: "Private delivery of the export request was suppressed",
    },
    { outcome: "failed", acknowledgement: "Run /export-trajectory from an owner DM" },
  ] as const)(
    "keeps $outcome trajectory export requests private",
    async ({ outcome, acknowledgement }) => {
      const { execCalls, privateReplies } = mockCommandBoundaries({
        deliveryOutcome: outcome,
        privateTargets: [
          { channel: "telegram", to: "owner-dm", accountId: "account-1" },
          { channel: "whatsapp", to: "backup-owner-dm", accountId: "account-2" },
        ],
      });
      const params = makeParams();
      params.isGroup = true;
      params.command.to = "group-1";
      params.ctx.OriginatingTo = "origin-group";
      params.ctx.MessageThreadId = 42;

      const reply = await buildExportTrajectoryCommandReply(params);

      expect(reply.text).toContain(acknowledgement);
      expect(reply.text).not.toContain(params.workspaceDir);
      expect(reply.text).not.toContain("traj-approval");
      expect(reply.text).not.toContain("--request-json-base64");
      expect(reply.text).not.toContain("agent:target:session");
      const route = commandMocks.resolvePrivateCommandRouteTargets.mock.calls[0]?.[0];
      expect(route?.request).toMatchObject({
        approvalKind: "exec",
        id: "trajectory-export-private-route",
        request: {
          agentId: "target",
          sessionKey: "agent:target:session",
          turnSourceChannel: "quietchat",
          turnSourceTo: "origin-group",
          turnSourceAccountId: "account-1",
          turnSourceThreadId: "42",
          commandArgv: expect.arrayContaining(["sessions", "export-trajectory", "--json"]),
        },
      });
      expect(privateReplies).toHaveLength(1);
      expect(privateReplies[0]?.targets).toEqual([
        { channel: "telegram", to: "owner-dm", accountId: "account-1" },
      ]);
      expect(privateReplies[0]?.text).toContain("Trajectory exports can include prompts");
      expect(privateReplies[0]?.text).toContain("openclaw sessions export-trajectory");
      expect(privateReplies[0]?.text).toContain("Session: agent:target:session");
      expect(execCalls).toHaveLength(1);
      const execCall = execCallRecord(execCalls);
      expect(execCall.defaults.messageProvider).toBe("telegram");
      expect(execCall.defaults.currentChannelId).toBe("owner-dm");
      expect(execCall.defaults.accountId).toBe("account-1");
    },
  );

  it("fails closed in groups when no private owner route is available", async () => {
    const { execCalls, privateReplies } = mockCommandBoundaries();
    const params = makeParams();
    params.isGroup = true;
    params.command.to = "group-1";

    const reply = await buildExportTrajectoryCommandReply(params);

    expect(reply.text).toContain("Run /export-trajectory from an owner DM");
    expect(execCalls).toHaveLength(0);
    expect(privateReplies).toHaveLength(0);
  });
});
