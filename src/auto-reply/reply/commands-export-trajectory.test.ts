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
    existsSyncMock: vi.fn((file: fs.PathLike, actualExistsSync: (path: fs.PathLike) => boolean) =>
      actualExistsSync(file),
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
  const mockedFs = {
    ...actual,
    existsSync: (file: fs.PathLike) => hoisted.existsSyncMock(file, actual.existsSync),
  };
  return {
    ...mockedFs,
    default: mockedFs,
  };
});

const tempDirs: string[] = [];

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

describe("buildExportTrajectoryReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.existsSyncMock.mockImplementation(
      (file: fs.PathLike, actualExistsSync: (path: fs.PathLike) => boolean) =>
        file.toString() === "/tmp/target-store/session.jsonl" || actualExistsSync(file),
    );
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a trajectory bundle from the target session", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");

    const reply = await buildExportTrajectoryReply(makeParams());

    expect(reply.text).toContain("✅ Trajectory exported!");
    expect(reply.text).toContain("session-branch.json");
    expect(reply.text).not.toContain("session.jsonl");
    expect(reply.text).not.toContain("runtime.jsonl");
    expect(hoisted.resolveDefaultSessionStorePathMock).toHaveBeenCalledWith("target");
    expect(hoisted.exportTrajectoryBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:target:session",
        workspaceDir: expect.stringContaining("openclaw-export-command-"),
      }),
    );
  });

  it("keeps user-named output paths inside the workspace trajectory export directory", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory my-bundle";

    await buildExportTrajectoryReply(params);

    expect(hoisted.exportTrajectoryBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(params.workspaceDir, ".openclaw", "trajectory-exports", "my-bundle"),
      }),
    );
  });

  it("rejects absolute output paths", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory /tmp/outside";

    const reply = await buildExportTrajectoryReply(params);

    expect(reply.text).toContain("Failed to resolve output path");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });

  it("rejects home-relative output paths", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory ~/bundle";

    const reply = await buildExportTrajectoryReply(params);

    expect(reply.text).toContain("Failed to resolve output path");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });

  it("does not echo absolute session paths when the transcript is missing", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");
    hoisted.existsSyncMock.mockImplementation(
      (file: fs.PathLike, actualExistsSync: (path: fs.PathLike) => boolean) =>
        file.toString() === "/tmp/target-store/session.jsonl" ? false : actualExistsSync(file),
    );

    const reply = await buildExportTrajectoryReply(makeParams());

    expect(reply.text).toBe("❌ Session file not found.");
    expect(reply.text).not.toContain("/tmp/target-store/session.jsonl");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });

  it("rejects output paths redirected by a symlinked exports directory", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");
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
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");
    const workspaceDir = makeTempDir();
    const outsideDir = makeTempDir();
    fs.mkdirSync(path.join(workspaceDir, ".openclaw"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(workspaceDir, ".openclaw", "trajectory-exports"));

    const reply = await buildExportTrajectoryReply(makeParams(workspaceDir));

    expect(reply.text).toContain("Failed to resolve output path");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });

  it("rejects symlinked state directories before creating export folders", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");
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
