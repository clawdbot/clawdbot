import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const hoisted = await vi.hoisted(async () => {
  const { createExportCommandSessionMocks } = await import("./commands-export-test-mocks.js");
  return {
    ...createExportCommandSessionMocks(vi),
    exportTrajectoryBundleMock: vi.fn(() => ({
      outputDir: "/tmp/workspace/.openclaw/trajectory-exports/openclaw-trajectory-session",
      manifest: {
        eventCount: 7,
        runtimeEventCount: 3,
        transcriptEventCount: 4,
      },
      events: [{ type: "context.compiled" }],
      runtimeFile: "/tmp/target-store/session.trajectory.jsonl",
      supplementalFiles: ["metadata.json", "artifacts.json", "prompts.json"],
    })),
    resolveDefaultTrajectoryExportDirMock: vi.fn(
      () => "/tmp/workspace/.openclaw/trajectory-exports/openclaw-trajectory-session",
    ),
    accessMock: vi.fn(
      async (file: fs.PathLike, actualAccess: (path: fs.PathLike) => Promise<void>) => {
        await actualAccess(file);
      },
    ),
    statMock: vi.fn(
      async (file: fs.PathLike, actualStat: (path: fs.PathLike) => Promise<unknown>) => {
        return await actualStat(file);
      },
    ),
  };
});

vi.mock("../../config/sessions/paths.js", () => ({
  resolveDefaultSessionStorePath: hoisted.resolveDefaultSessionStorePathMock,
  resolveSessionFilePath: hoisted.resolveSessionFilePathMock,
  resolveSessionFilePathOptions: hoisted.resolveSessionFilePathOptionsMock,
}));

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: hoisted.loadSessionStoreMock,
}));

vi.mock("../../trajectory/export.js", () => ({
  exportTrajectoryBundle: hoisted.exportTrajectoryBundleMock,
  resolveDefaultTrajectoryExportDir: hoisted.resolveDefaultTrajectoryExportDirMock,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mockedFs = { ...actual };
  return {
    ...mockedFs,
    default: mockedFs,
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mockedFs = {
    ...actual,
    access: (file: fs.PathLike) => hoisted.accessMock(file, actual.access),
    stat: (file: fs.PathLike) => hoisted.statMock(file, actual.stat),
  };
  return {
    ...mockedFs,
    default: mockedFs,
  };
});

import {
  buildExportTrajectoryCommandReply,
  buildExportTrajectoryReply,
} from "./commands-export-trajectory.js";

const tempDirs: string[] = [];
const mockedSessionFile = "/tmp/target-store/session.jsonl";

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-export-command-"));
  tempDirs.push(dir);
  return dir;
}

function makeParams(workspaceDir = makeTempDir()): HandleCommandsParams {
  return {
    cfg: {},
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
    workspaceDir,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

function createExecDeps(
  options: {
    privateTargets?: Array<{ channel: string; to: string; accountId?: string | null }>;
  } = {},
) {
  const execCalls: Array<{ defaults: unknown; params: unknown }> = [];
  const privateReplies: Array<{
    targets: Array<{ channel: string; to: string; accountId?: string | null }>;
    text?: string;
  }> = [];
  const createExecTool = vi.fn((defaults: unknown) => ({
    execute: vi.fn(async (_toolCallId: string, params: unknown) => {
      execCalls.push({ defaults, params });
      return {
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
      };
    }),
  }));
  return {
    execCalls,
    privateReplies,
    deps: {
      createExecTool: createExecTool as never,
      resolvePrivateTrajectoryTargets: vi.fn(async () => options.privateTargets ?? []),
      deliverPrivateTrajectoryReply: vi.fn(async ({ targets, reply }) => {
        privateReplies.push({ targets, text: reply.text });
        return true;
      }),
    },
  };
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

function exportBundleParams(): Record<string, unknown> {
  const calls = hoisted.exportTrajectoryBundleMock.mock.calls as unknown[][];
  return requireRecord(calls[0]?.[0]);
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

describe("buildExportTrajectoryReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.accessMock.mockImplementation(
      async (file: fs.PathLike, actualAccess: (path: fs.PathLike) => Promise<void>) => {
        if (file.toString() === "/tmp/target-store/session.jsonl") {
          return;
        }
        await actualAccess(file);
      },
    );
    hoisted.statMock.mockImplementation(
      async (file: fs.PathLike, actualStat: (path: fs.PathLike) => Promise<unknown>) => {
        if (file.toString() === "/tmp/target-store/session.jsonl") {
          return {};
        }
        return await actualStat(file);
      },
    );
    fs.mkdirSync(path.dirname(mockedSessionFile), { recursive: true });
    fs.writeFileSync(mockedSessionFile, "{}\n");
  });

  afterEach(() => {
    fs.rmSync(mockedSessionFile, { force: true });
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a trajectory bundle from the target session", async () => {
    const params = makeParams();
    const reply = await buildExportTrajectoryReply(params);

    expect(reply.text).toContain("✅ Trajectory exported!");
    expect(reply.text).toContain("session-branch.json");
    expect(reply.text).not.toContain("session.jsonl");
    expect(reply.text).not.toContain("runtime.jsonl");
    expect(hoisted.resolveDefaultSessionStorePathMock).toHaveBeenCalledWith("target");
    const exportParams = exportBundleParams();
    expect(exportParams.sessionId).toBe("session-1");
    expect(exportParams.sessionKey).toBe("agent:target:session");
    expect(exportParams.workspaceDir).toBe(params.workspaceDir);
    expect(String(exportParams.workspaceDir)).toContain("openclaw-export-command-");
  });

  it("keeps user-named output paths inside the workspace trajectory export directory", async () => {
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory my-bundle";

    await buildExportTrajectoryReply(params);

    expect(exportBundleParams().outputDir).toBe(
      path.join(params.workspaceDir, ".openclaw", "trajectory-exports", "my-bundle"),
    );
  });

  it("rejects absolute output paths", async () => {
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory /tmp/outside";

    const reply = await buildExportTrajectoryReply(params);

    expect(reply.text).toContain("Failed to resolve output path");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });

  it("rejects home-relative output paths", async () => {
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory ~/bundle";

    const reply = await buildExportTrajectoryReply(params);

    expect(reply.text).toContain("Failed to resolve output path");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });

  it("does not echo absolute session paths when the transcript is missing", async () => {
    fs.rmSync(mockedSessionFile, { force: true });
    hoisted.accessMock.mockImplementation(
      async (file: fs.PathLike, actualAccess: (path: fs.PathLike) => Promise<void>) => {
        if (file.toString() === "/tmp/target-store/session.jsonl") {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        await actualAccess(file);
      },
    );
    hoisted.statMock.mockImplementation(
      async (file: fs.PathLike, actualStat: (path: fs.PathLike) => Promise<unknown>) => {
        if (file.toString() === "/tmp/target-store/session.jsonl") {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return await actualStat(file);
      },
    );

    const reply = await buildExportTrajectoryReply(makeParams());

    expect(reply.text).toBe("❌ Session file not found.");
    expect(reply.text).not.toContain("/tmp/target-store/session.jsonl");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });

  it("rejects output paths redirected by a symlinked exports directory", async () => {
    const workspaceDir = makeTempDir();
    const outsideDir = makeTempDir();
    fs.mkdirSync(path.join(workspaceDir, ".openclaw"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(workspaceDir, ".openclaw", "trajectory-exports"));
    const params = makeParams(workspaceDir);
    params.command.commandBodyNormalized = "/export-trajectory my-bundle";

    const reply = await buildExportTrajectoryReply(params);

    expect(reply.text).toContain("Failed to resolve output path");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });

  it("rejects default output paths redirected by a symlinked exports directory", async () => {
    const workspaceDir = makeTempDir();
    const outsideDir = makeTempDir();
    fs.mkdirSync(path.join(workspaceDir, ".openclaw"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(workspaceDir, ".openclaw", "trajectory-exports"));

    const reply = await buildExportTrajectoryReply(makeParams(workspaceDir));

    expect(reply.text).toContain("Failed to resolve output path");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });

  it("rejects symlinked state directories before creating export folders", async () => {
    const workspaceDir = makeTempDir();
    const outsideDir = makeTempDir();
    fs.symlinkSync(outsideDir, path.join(workspaceDir, ".openclaw"));
    const params = makeParams(workspaceDir);
    params.command.commandBodyNormalized = "/export-trajectory my-bundle";

    const reply = await buildExportTrajectoryReply(params);

    expect(reply.text).toContain("Failed to resolve output path");
    expect(fs.existsSync(path.join(outsideDir, "trajectory-exports"))).toBe(false);
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });
});

describe("buildExportTrajectoryCommandReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests per-run exec approval for trajectory exports", async () => {
    const { execCalls, deps } = createExecDeps();
    const params = makeParams();

    const reply = await buildExportTrajectoryCommandReply(params, deps);

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
    expect(execCall.defaults.currentChannelId).toBe("bot");
    expect(execCall.defaults.accountId).toBe("account-1");
    expect(execCall.params.security).toBe("allowlist");
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

  it("uses the originating Telegram route for native trajectory export followups", async () => {
    const { execCalls, deps } = createExecDeps();
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

    await buildExportTrajectoryCommandReply(params, deps);

    expect(execCalls).toHaveLength(1);
    const execCall = execCallRecord(execCalls);
    expect(execCall.defaults.messageProvider).toBe("telegram");
    expect(execCall.defaults.currentChannelId).toBe("telegram:8460800771");
    expect(execCall.defaults.accountId).toBe("account-1");
  });

  it("keeps user-controlled export values out of the shell command", async () => {
    const { execCalls, deps } = createExecDeps();
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory bad'; Invoke-Expression evil ;'";

    await buildExportTrajectoryCommandReply(params, deps);

    const commandValue = execCallRecord(execCalls).params.command;
    const command = typeof commandValue === "string" ? commandValue : "";
    expect(command).toMatch(/'?sessions'?\s+'?export-trajectory'?/u);
    expect(command).toMatch(/'?--request-json-base64'?\s+'?[A-Za-z0-9_-]+'?/u);
    expect(command).toMatch(/'?--json'?$/u);
    expect(command).not.toContain("Invoke-Expression");
    expect(readEncodedRequestFromCommand(command).output).toBe("bad';");
  });

  it("rejects oversized output paths before requesting exec approval", async () => {
    const { execCalls, deps } = createExecDeps();
    const params = makeParams();
    params.command.commandBodyNormalized = `/export-trajectory ${"a".repeat(513)}`;

    const reply = await buildExportTrajectoryCommandReply(params, deps);

    expect(reply.text).toContain("Output path is too long");
    expect(execCalls).toHaveLength(0);
  });

  it("rejects oversized encoded export requests before requesting exec approval", async () => {
    const { execCalls, deps } = createExecDeps();
    const params = makeParams();
    params.workspaceDir = `/${"workspace".repeat(1200)}`;

    const reply = await buildExportTrajectoryCommandReply(params, deps);

    expect(reply.text).toContain("Encoded trajectory export request is too large");
    expect(execCalls).toHaveLength(0);
  });

  it("routes group trajectory export approval privately", async () => {
    const { execCalls, privateReplies, deps } = createExecDeps({
      privateTargets: [
        { channel: "telegram", to: "owner-dm", accountId: "account-1" },
        { channel: "whatsapp", to: "backup-owner-dm", accountId: "account-2" },
      ],
    });
    const params = makeParams();
    params.isGroup = true;
    params.command.to = "group-1";

    const reply = await buildExportTrajectoryCommandReply(params, deps);

    expect(reply.text).toBe(
      "Trajectory exports are sensitive. I sent the export request and approval prompt to the owner privately.",
    );
    expect(reply.text).not.toContain("agent:target:session");
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
  });

  it("fails closed in groups when no private owner route is available", async () => {
    const { execCalls, privateReplies, deps } = createExecDeps();
    const params = makeParams();
    params.isGroup = true;
    params.command.to = "group-1";

    const reply = await buildExportTrajectoryCommandReply(params, deps);

    expect(reply.text).toContain("Run /export-trajectory from an owner DM");
    expect(execCalls).toHaveLength(0);
    expect(privateReplies).toHaveLength(0);
  });
});
